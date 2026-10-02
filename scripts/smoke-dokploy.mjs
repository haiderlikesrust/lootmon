import assert from 'node:assert/strict';
import WebSocket from 'ws';

// Public, read-only verification. No wallet signatures, accounts, orders,
// treasury requests or configuration changes are submitted to the target.
const [input, ...options] = process.argv.slice(2);
if (!input || options.some(value => value !== '--direct')) {
  console.error('Usage: node scripts/smoke-dokploy.mjs https://your-domain [--direct]');
  process.exit(1);
}
const base = new URL(input);
assert.ok(['http:', 'https:'].includes(base.protocol), 'Use an HTTP(S) origin');
assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'Supply only the origin, without credentials or a path');
const direct = options.includes('--direct');
const get = async (path, status = 200) => {
  const response = await fetch(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, status, path);
  return response;
};

const home = await get('/');
if (!direct) {
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const connectSources = (home.headers.get('content-security-policy') ?? '').split(';').find(directive => directive.trim().startsWith('connect-src '))?.trim().split(/\s+/).slice(1) ?? [];
  assert.ok(connectSources.includes('blob:'), 'Embedded GLB atlases need fetch(blob:) allowed by connect-src');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
}
const html = await home.text();
assert.match(html, /<title>Lootmon/);
const entryAssets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
assert.ok(entryAssets.some(path => path.endsWith('.js')), 'Built JavaScript entry is present');
assert.ok(entryAssets.some(path => path.endsWith('.css')), 'Built stylesheet is present');
for (const path of [...new Set(entryAssets)]) {
  const response = await get(path);
  assert.match(response.headers.get('content-type') ?? '', path.endsWith('.css') ? /text\/css/ : /(?:java|ecma)script/);
  if (!direct) assert.match(response.headers.get('cache-control') ?? '', /max-age=31536000/);
  assert.ok((await response.arrayBuffer()).byteLength > 0, path);
}
for (const path of ['/brand/lootmon-mark.svg', '/brand/lootmon-logo.webp', '/art/looter-avatar.png', ...[25, 50, 100, 250, 500].map(tier => `/art/lootmon-pack-${tier}.webp`), '/fonts/space-grotesk-500-v1.woff2', ...['Rogue', 'Rogue_Hooded', 'Mage'].map(name => `/models/kaykit-adventurers/${name}.glb`)]) {
  const response = await get(path);
  assert.doesNotMatch(response.headers.get('content-type') ?? '', /text\/html/, `${path} must be an asset, not a fallback page`);
  assert.ok((await response.arrayBuffer()).byteLength > 0, path);
}
const ping = await get('/api/ping');
assert.equal((await ping.json()).ok, true);
assert.match(ping.headers.get('cache-control') ?? '', /no-store/);
const configuration = await (await get('/api/config')).json();
assert.equal(configuration.mode, 'live');
assert.equal(configuration.eligibilityPercent, 0.25);
assert.equal(configuration.eliteAbovePercent, 2);
const status = await (await get('/api/status')).json();
assert.equal(status.ok, true);
assert.ok(!Array.isArray(status.state?.players) && !Array.isArray(status.state?.packs), 'Public status must not reveal players or hidden coordinates');
assert.match(await (await get('/leaderboard')).text(), /<title>Lootmon/);
const leaderboard = await (await get('/api/leaderboard')).json();
assert.ok(Array.isArray(leaderboard.entries), 'Leaderboard is served by the authority');
const community = await (await get('/api/community')).json();
assert.ok(Array.isArray(community.chat) && Array.isArray(community.activity), 'Public community feed is available');
await (await get('/api/auth/session', 401)).arrayBuffer();
await (await get('/api/collection', 401)).arrayBuffer();

// A 401 from /ws demonstrates that the gateway forwarded the Upgrade request
// to the authenticated WebSocket route without granting an anonymous session.
const wsUrl = new URL('/ws', base);
wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
await new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl, { headers: { origin: base.origin }, handshakeTimeout: 10_000 });
  const timeout = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket authentication check timed out')); }, 12_000);
  socket.on('error', error => { clearTimeout(timeout); reject(error); });
  socket.on('open', () => { clearTimeout(timeout); socket.terminate(); reject(new Error('Anonymous WebSocket was incorrectly accepted')); });
  socket.on('unexpected-response', (_request, response) => {
    clearTimeout(timeout);
    response.resume();
    if (response.statusCode !== 401) reject(new Error(`WebSocket must reject anonymous access with 401, received ${response.statusCode}`));
    else resolve();
    // Nginx can keep a rejected upgrade connection alive. Release it after
    // checking the response instead of delaying the smoke until its idle limit.
    response.destroy();
    socket.terminate();
  });
});
console.log(`Lootmon smoke passed: built page, art/models/fonts, public APIs, private collections and anonymous WebSocket rejection${direct ? ' (direct Node; proxy headers were not checked)' : ' through the gateway'}.`);
console.log(`Wallet gate: ${configuration.configured ? 'configured' : 'awaiting configuration'}. Funding: ${configuration.funding?.ready ? 'ready' : 'not ready'}. No accounts or financial transactions were created.`);
