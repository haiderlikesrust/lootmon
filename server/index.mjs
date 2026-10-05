import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Game, GAME_RULES } from './game.mjs';
import { Auth } from './auth.mjs';
import { FileStore } from './storage.mjs';
import { createProvider } from './provider.mjs';
import { publicSite } from './public-site.mjs';
import { clientAddress } from './network.mjs';
import { Community } from './community.mjs';
import { startupDiagnostic } from './startup-diagnostics.mjs';
import { inspectConfiguration } from '../scripts/preflight.mjs';
import { CommunityHistory } from './community-history.mjs';

const colliderPath = fileURLToPath(new URL('../shared/world-colliders.json', import.meta.url));
if (!existsSync(colliderPath)) throw new Error('World collider data is required. Refusing to start an unprotected world.');
const colliderData = JSON.parse(readFileSync(colliderPath, 'utf8'));
const store = new FileStore(undefined, { kernelLockHeld: process.argv.includes('--authority-lock-held') });
let game;
const auth = new Auth();
let provider;
let community;
let closing = false;
let authorityLost = false;
let stopForAuthorityLoss = null;
let startupStage = 'treasury';
try {
  provider = await createProvider({ env: process.env, onActivity(event) { community?.packEvent(event); }, onAuthorityLost() {
    authorityLost = true;
    console.error('Database authority was lost. The game server is stopping to protect prize ownership.');
    stopForAuthorityLoss?.();
  } });
  if (authorityLost) {
    store.close();
    process.exit(1);
  }
  if (provider.pausedMints?.length) console.warn(`[startup:treasury:INACTIVE_RECOVERY_PAUSED] ${provider.pausedMints.length} inactive coin profile(s) have unfinished operations under different treasury wallets. Records are preserved; recovery requires each profile's original CA and treasury key.`);
  startupStage = 'world';
  store.selectMint(process.env.MEMECOIN_MINT, provider.legacyMint);
  game = new Game({ store, colliders: Array.isArray(colliderData) ? colliderData : colliderData.colliders ?? [] });
} catch (error) {
  // Provider/driver errors can contain connection details. Startup diagnostics
  // intentionally omit their raw messages, stacks and environment values.
  console.error(startupDiagnostic(error, startupStage));
  for (const issue of inspectConfiguration().issues) console.error(`[startup:configuration] ${issue}`);
  store.close();
  process.exit(1);
}
game.treasury = { ...game.treasury, ...provider.status };
const clients = new Map();
const walletConnections = new Map();
const rateLimits = new Map();
const port = Number(process.env.GAME_PORT || 8787);
const host = process.env.GAME_HOST || '127.0.0.1';
const distPath = fileURLToPath(new URL('../dist', import.meta.url));
const secureCookie = process.env.NODE_ENV === 'production' || auth.domain.startsWith('https://');
const allowedOrigins = new Set((process.env.APP_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173').split(',').map(value => value.trim()).filter(Boolean));
const communityHistory = new CommunityHistory(store.path);
community = new Community(game, { history: communityHistory.load(), onChange(snapshot) {
  void communityHistory.save(snapshot).catch(() => console.error('Community history could not be saved; gameplay and the prize ledger remain separate.'));
  for (const ws of clients.keys()) send(ws, { type: 'community', ...snapshot });
} });

function config() {
  return { mode: 'live', configured: auth.configured, liveEnabled: auth.configured, missingConfig: auth.missingConfig,
    mint: auth.mint, site: publicSite(), eligibilityPercent: 0.25, eliteAbovePercent: 2, rules: GAME_RULES,
    funding: { enabled: Boolean(provider.status.enabled), ready: Boolean(provider.status.ready), blockers: provider.status.blockers ?? [] },
    note: 'Wallet ownership and token holdings are verified by the game server. Only purchased inventory can be found and won.' };
}
function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}
function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.host && (parsed.protocol === 'https:' || !secureCookie && parsed.protocol === 'http:');
  } catch { return false; }
}
function limit(request, bucket, max = 30) {
  const key = `${clientAddress(request, Number(process.env.TRUST_PROXY_HOPS || 0))}:${bucket}`;
  const now = Date.now();
  let item = rateLimits.get(key);
  if (!item || item.expiresAt <= now) { item = { count: 0, expiresAt: now + 60_000 }; rateLimits.set(key, item); }
  return ++item.count <= max;
}
async function readJson(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('A JSON object is required.'), { status: 400 });
  return body;
}
function sessionCookie(token, age = 3600) {
  return `cards_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookie ? '; Secure' : ''}`;
}
function publicSession(session) {
  return { wallet: session.wallet, holdPercent: session.holdPercent, elite: session.elite, eligible: session.eligible };
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/api/ping') return json(response, closing || authorityLost ? 503 : 200, { ok: !closing && !authorityLost });
    if (request.method === 'GET' && pathname === '/api/config') return json(response, 200, config());
    if (request.method === 'GET' && pathname === '/api/status') return json(response, 200, { ok: true, ...config(), state: game.publicStatus() });
    if (request.method === 'GET' && ['/api/community', '/api/leaderboard'].includes(pathname)) {
      if (!limit(request, 'community-read', 120)) return json(response, 429, { error: 'Too many community requests. Try again shortly.' });
      return json(response, 200, pathname === '/api/community' ? community.snapshot() : community.leaderboard());
    }
    if (request.method === 'GET' && pathname === '/api/collection') {
      const session = auth.sessionFromCookie(request.headers.cookie);
      if (!session) return json(response, 401, { ok: false, error: 'Sign in with your wallet to see your collection.' });
      return json(response, 200, { ok: true, collection: game.accounts[session.wallet]?.collection ?? [] });
    }
    if (pathname.startsWith('/api/auth/')) {
      if (!originAllowed(request)) return json(response, 403, { error: 'Request origin is not permitted.' });
      if (!limit(request, 'auth')) return json(response, 429, { error: 'Too many sign-in requests. Try again in a minute.' });
      if (request.method === 'POST' && pathname === '/api/auth/challenge') {
        const body = await readJson(request);
        return json(response, 200, auth.issueChallenge(body.wallet));
      }
      if (request.method === 'POST' && pathname === '/api/auth/verify') {
        const body = await readJson(request);
        const session = await auth.verify(body);
        const previous = auth.sessionFromCookie(request.headers.cookie);
        if (previous) {
          auth.revoke(previous);
          const previousSocket = walletConnections.get(previous.wallet);
          if (clients.get(previousSocket)?.session === previous) previousSocket.close(1000, 'Wallet session replaced');
        }
        response.setHeader('Set-Cookie', sessionCookie(session.token));
        return json(response, 200, { ok: true, player: publicSession(session), collection: game.accounts[session.wallet]?.collection ?? [], expiresAt: session.expiresAt });
      }
      const session = auth.sessionFromCookie(request.headers.cookie);
      if (request.method === 'GET' && pathname === '/api/auth/session') {
        if (!session) return json(response, 401, { ok: false, error: 'Connect and sign with your wallet to play.' });
        if (Date.now() - session.verifiedAt > 60_000 && !await auth.revalidate(session)) return json(response, 401, { ok: false, error: 'Wallet eligibility could not be renewed. Sign in again.' });
        return json(response, 200, { ok: true, player: publicSession(session), collection: game.accounts[session.wallet]?.collection ?? [], expiresAt: session.expiresAt });
      }
      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        auth.revoke(session);
        const sessionSocket = session && walletConnections.get(session.wallet);
        if (sessionSocket && clients.get(sessionSocket)?.session === session) sessionSocket.close(1000, 'Signed out');
        response.setHeader('Set-Cookie', sessionCookie('', 0));
        return json(response, 200, { ok: true });
      }
    }
    if (pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found' });
    if (request.method === 'GET' && existsSync(distPath)) {
      let decoded;
      try { decoded = decodeURIComponent(pathname); } catch { return json(response, 400, { error: 'Invalid path' }); }
      let path = resolve(distPath, `.${decoded}`);
      if (path !== distPath && !path.startsWith(distPath + sep)) return json(response, 403, { error: 'Forbidden' });
      if (!existsSync(path) || statSync(path).isDirectory()) path = resolve(distPath, 'index.html');
      if (!existsSync(path)) return json(response, 404, { error: 'Build the client before starting production.' });
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary' };
      response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600' });
      return response.end(readFileSync(path));
    }
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    json(response, error.status || 503, { ok: false, error: error.status ? error.message : 'The service is temporarily unavailable. Please retry.' });
  }
});
server.headersTimeout = 15_000;
server.requestTimeout = 15_000;

const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
server.on('upgrade', async (request, socket, head) => {
  try {
    if (closing || authorityLost) { socket.destroy(); return; }
    if (new URL(request.url, 'http://localhost').pathname !== '/ws' || !originAllowed(request) || !limit(request, 'socket', 20)) { socket.destroy(); return; }
    const session = auth.sessionFromCookie(request.headers.cookie);
    if (!auth.configured || !session || Date.now() - session.verifiedAt > 60_000 && !await auth.revalidate(session)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    if (closing || authorityLost || auth.sessionFromCookie(request.headers.cookie) !== session) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, session));
  } catch { socket.destroy(); }
});
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512_000) ws.send(JSON.stringify(payload));
}
wss.on('connection', (ws, session) => {
  const previous = walletConnections.get(session.wallet);
  if (previous) { game.removePlayer(session.wallet); previous.close(1000, 'Wallet connected in another tab'); }
  const client = { id: session.wallet, session, joined: false, count: 0, windowAt: Date.now(), alive: true, revalidating: false };
  clients.set(ws, client);
  walletConnections.set(session.wallet, ws);
  send(ws, { type: 'state', state: game.state(null) });
  send(ws, { type: 'community', ...community.snapshot() });
  ws.on('pong', () => { client.alive = true; });
  ws.on('error', () => {});
  ws.on('message', raw => {
    if (closing || authorityLost) { ws.close(1012, 'Game authority is restarting'); return; }
    const now = Date.now();
    if (now - client.windowAt >= 1000) { client.windowAt = now; client.count = 0; }
    if (++client.count > 90) { ws.close(1008, 'Too many messages'); return; }
    if (walletConnections.get(client.id) !== ws) return;
    if (!auth.sessions.has(session.token) || session.expiresAt <= now) { ws.close(1008, 'Wallet session expired'); return; }
    if (now - session.verifiedAt > 60_000) { send(ws, { type: 'error', message: 'Refreshing token eligibility. Please wait.' }); return; }
    let message;
    try { message = JSON.parse(raw.toString()); } catch { send(ws, { type: 'error', message: 'Invalid JSON.' }); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'join') {
      if (message.mode && message.mode !== 'live') { send(ws, { type: 'error', message: 'Only verified live play is available.' }); return; }
      if (!client.joined && game.players.size >= 64) { send(ws, { type: 'error', message: 'This world is full. Please try again shortly.' }); return; }
      if (!client.joined) {
        const player = game.addPlayer(client.id, message.name, now, session);
        if (message.character !== undefined) game.setCharacter(client.id, message.character);
        client.joined = true;
        game.addEvent(`${player.name} deployed into the hunt.`, now);
      }
      send(ws, { type: 'welcome', id: client.id, state: game.state(client.id, now) });
      return;
    }
    if (message.type === 'ping') {
      if (Number.isSafeInteger(message.nonce) && message.nonce >= 0) send(ws, { type: 'pong', nonce: message.nonce, serverTime: now });
      return;
    }
    if (message.type === 'chat') {
      const result = client.joined ? community.submit(client.id, message.text, now)
        : { ok: false, reason: 'Join the hunt with your verified wallet before chatting.' };
      send(ws, { type: 'chat_ack', ...result });
      return;
    }
    if (!client.joined) { send(ws, { type: 'error', message: 'Deploy before taking an action.' }); return; }
    let result;
    if (message.type === 'move') game.move(client.id, message, now);
    else if (message.type === 'jump') result = game.jump(client.id, now);
    else if (message.type === 'interact') result = game.interact(client.id, now);
    else if (message.type === 'ability') result = game.useAbility(client.id, message.ability, now);
    else if (message.type === 'profile') result = { ok: false, reason: 'Privileges are determined by verified token holdings.' };
    if (result) send(ws, { type: 'action', ...result });
  });
  ws.on('close', () => {
    if (walletConnections.get(client.id) === ws) { game.removePlayer(client.id); walletConnections.delete(client.id); }
    clients.delete(ws);
  });
});

let broadcastFrame = 0;
const ticker = setInterval(() => {
  const now = Date.now();
  game.tick(now);
  // State snapshots are replaceable. A slow connection gets the next fresh
  // snapshot after draining, instead of a queue of stale movement frames.
  if (++broadcastFrame % 2 === 0) for (const [ws, client] of clients) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount === 0) send(ws, { type: 'state', state: game.state(client.joined ? client.id : null, now) });
  }
}, 50);
const heartbeat = setInterval(() => {
  auth.prune();
  for (const [key, item] of rateLimits) if (item.expiresAt <= Date.now()) rateLimits.delete(key);
  for (const [ws, client] of clients) {
    if (!client.alive) { ws.terminate(); continue; }
    client.alive = false;
    ws.ping();
    if (!client.revalidating) {
      client.revalidating = true;
      auth.revalidate(client.session).then(valid => {
        if (closing || authorityLost || walletConnections.get(client.id) !== ws || clients.get(ws) !== client || ws.readyState !== WebSocket.OPEN) return;
        if (!valid) { send(ws, { type: 'error', message: 'Token eligibility could not be verified. Please reconnect your wallet.' }); ws.close(1008, 'Eligibility verification required'); }
        else game.updateIdentity(client.id, client.session);
      }).finally(() => { client.revalidating = false; });
    }
  }
}, 30_000);
let fundingBusy = false;
async function fundingTick() {
  if (fundingBusy || closing || authorityLost) return;
  fundingBusy = true;
  try {
    const inventory = await provider.tick();
    if (closing || authorityLost) return;
    for (const prize of inventory) game.addFundedPack(prize);
    for (const award of game.pendingAwards()) {
      try { game.markAward(award.id, await provider.award(award)); }
      catch (error) {
        const quarantined = error?.name === 'ReviewRequired';
        const at = Date.now();
        game.markAward(award.id, {
          status: quarantined ? 'quarantined' : 'pending', code: quarantined ? 'intent_quarantined' : 'provider_unavailable',
          reason: quarantined ? 'Delivery intent failed validation and is quarantined. The original claim remains reserved.' : 'Delivery is unavailable; the original claim will be reconciled automatically.',
          attempts: (award.attempts ?? 0) + 1, lastAttemptAt: at, nextAttemptAt: quarantined ? null : at + 30_000,
          history: [...(award.history ?? []), { at, state: quarantined ? 'quarantined' : 'retrying', code: quarantined ? 'intent_quarantined' : 'provider_unavailable' }].slice(-12),
        });
        console.error('A prize delivery remains durably reserved for safe reconciliation.');
      }
    }
  } catch { console.error('Funding worker is unavailable; no unverified prizes were added.'); }
  finally { game.treasury = { ...game.treasury, ...provider.status }; fundingBusy = false; }
}
const fundingTimer = setInterval(fundingTick, 15_000);
void fundingTick();

async function shutdown(exitCode = 0, reason = 'Server shutting down') {
  if (closing) return;
  closing = true;
  clearInterval(ticker); clearInterval(heartbeat); clearInterval(fundingTimer);
  community.close();
  for (const ws of clients.keys()) ws.close(exitCode ? 1012 : 1001, reason);
  game.persist();
  wss.close();
  server.close();
  const forceStop = setTimeout(() => {
    for (const ws of clients.keys()) ws.terminate();
    store.close();
    process.exit(exitCode);
  }, 3000);
  forceStop.unref();
  try { await Promise.all([provider.close?.(), communityHistory.flush()]); } catch { /* Durable jobs resume on restart. */ }
  store.close();
  clearTimeout(forceStop);
  process.exit(exitCode);
}
stopForAuthorityLoss = () => { void shutdown(1, 'Game authority interrupted. Reconnect after service restart.'); };
if (authorityLost) stopForAuthorityLoss();
else server.listen(port, host, () => console.log(`CARDS game server at http://${host}:${server.address().port} — wallet gate ${auth.configured ? 'configured' : 'awaiting configuration'}`));
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
