import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import bs58 from 'bs58';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const makeWallet = () => {
  const key = generateKeyPairSync('ed25519');
  const address = bs58.encode(key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { key, address };
};

test('live server verifies signed wallets, isolates players, and revokes stale privileges without real chain calls', { timeout: 50_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cards-integration-'));
  const alice = makeWallet();
  const bob = makeWallet();
  const exactEliteBoundary = makeWallet();
  const ineligible = makeWallet();
  const mint = makeWallet().address;
  const balances = new Map([[alice.address, '2500'], [bob.address, '20001'], [exactEliteBoundary.address, '20000'], [ineligible.address, '2499']]);
  const sockets = [];
  let child;
  let output = '';
  let rpcCalls = 0;
  const rpc = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const query = JSON.parse(raw);
    rpcCalls++;
    assert.equal(query.params.at(-1).commitment, 'confirmed');
    let result;
    if (query.method === 'getTokenSupply') {
      assert.equal(query.params[0], mint);
      result = { value: { amount: '1000000' } };
    } else {
      assert.equal(query.method, 'getTokenAccountsByOwner');
      assert.equal(query.params[1].mint, mint);
      const wallet = query.params[0];
      result = { value: [{ account: { data: { parsed: { info: { owner: wallet, mint, tokenAmount: { amount: balances.get(wallet) ?? '0' } } } } } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: query.id, result }));
  });
  try {
    rpc.listen(0, '127.0.0.1');
    await once(rpc, 'listening');
    const rpcPort = rpc.address().port;
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: workspace,
      env: { ...process.env, NODE_ENV: 'test', MEMECOIN_MINT: mint, SOLANA_RPC_URL: `http://127.0.0.1:${rpcPort}`, APP_ORIGIN: 'http://localhost:5173', MAINNET_ENABLED: 'false', GAME_HOST: '127.0.0.1', GAME_PORT: '0', GAME_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const origin = await new Promise((resolveOrigin, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Game server startup timed out: ${output}`)), 7000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Game server exited ${code}: ${output}`)); });
      child.stderr.on('data', data => { output += data; });
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timeout); resolveOrigin(match[0]); }
      });
    });
    const request = (path, { cookie, body, originHeader = 'http://localhost:5173', method = body ? 'POST' : 'GET' } = {}) => fetch(`${origin}${path}`, {
      method,
      headers: { Origin: originHeader, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const authenticate = async wallet => {
      const challengeResponse = await request('/api/auth/challenge', { body: { wallet: wallet.address } });
      assert.equal(challengeResponse.status, 200);
      const challenge = await challengeResponse.json();
      assert.match(challenge.message, /does not submit a transaction/);
      const proof = { wallet: wallet.address, nonce: challenge.nonce, signature: sign(null, Buffer.from(challenge.message), wallet.key.privateKey).toString('base64') };
      const response = await request('/api/auth/verify', { body: proof });
      return { response, proof, cookie: response.headers.get('set-cookie')?.split(';')[0], payload: await response.json() };
    };
    const snapshot = await (await request('/api/status')).json();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.site.contractAddress, mint);
    const pingResponse = await request('/api/ping');
    assert.equal(pingResponse.status, 200);
    assert.equal(pingResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await pingResponse.json(), { ok: true });
    assert.equal(snapshot.state.mode, 'live');
    assert.equal(snapshot.state.online, 0);
    assert.equal(snapshot.state.packCounts.total, 0);
    assert.equal(Object.hasOwn(snapshot.state, 'packs'), false);
    const unauthenticatedStatus = await new Promise((resolveStatus, reject) => {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
      sockets.push(socket);
      socket.on('unexpected-response', (_request, response) => { resolveStatus(response.statusCode); socket.terminate(); });
      socket.on('open', () => reject(new Error('Unauthenticated websocket was accepted')));
      socket.on('error', () => {});
    });
    assert.equal(unauthenticatedStatus, 401);
    assert.equal((await request('/api/auth/challenge', { body: { wallet: alice.address }, originHeader: 'https://untrusted.invalid' })).status, 403);
    const low = await authenticate(ineligible);
    assert.equal(low.response.status, 403);
    const boundary = await authenticate(exactEliteBoundary);
    assert.equal(boundary.payload.player.elite, false);
    const first = await authenticate(alice);
    assert.equal(first.response.status, 200);
    assert.equal(first.payload.player.holdPercent, 0.25);
    assert.equal(first.payload.player.elite, false);
    assert.deepEqual(first.payload.collection, []);
    assert.match(first.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await request('/api/auth/verify', { body: first.proof })).status, 401);
    const second = await authenticate(bob);
    assert.equal(second.payload.player.elite, true);
    const session = await (await request('/api/auth/session', { cookie: first.cookie })).json();
    assert.equal(session.player.wallet, alice.address);
    assert.deepEqual(session.collection, []);
    assert.deepEqual((await (await request('/api/collection', { cookie: first.cookie })).json()).collection, []);

    function connect(cookie, name, character) {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie, Origin: 'http://localhost:5173' } });
      sockets.push(socket);
      const messages = [];
      const waiters = [];
      let closed = null;
      socket.on('error', () => {});
      socket.on('message', raw => {
        const message = JSON.parse(raw);
        messages.push(message);
        for (const waiter of [...waiters]) if (waiter.predicate(message)) { clearTimeout(waiter.timeout); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
      });
      socket.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
      socket.on('open', () => socket.send(JSON.stringify({ type: 'join', name, character })));
      return {
        socket, messages, get closed() { return closed; },
        wait(predicate, timeoutMs = 5000) {
          const existing = messages.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((resolveMessage, reject) => {
            const waiter = { predicate, resolve: resolveMessage, timeout: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Expected WebSocket message timed out')); }, timeoutMs) };
            waiters.push(waiter);
          });
        },
      };
    }
    const aliceSocket = connect(first.cookie, 'Alice', 'ranger');
    const aliceWelcome = await aliceSocket.wait(message => message.type === 'welcome');
    aliceSocket.socket.send(JSON.stringify({ type: 'ping', nonce: 72934 }));
    const pong = await aliceSocket.wait(message => message.type === 'pong');
    assert.equal(pong.nonce, 72934);
    assert.ok(Number.isSafeInteger(pong.serverTime));
    const bobSocket = connect(second.cookie, 'Bob', 'sage');
    const bobWelcome = await bobSocket.wait(message => message.type === 'welcome');
    assert.equal(aliceWelcome.id, alice.address);
    assert.equal(bobWelcome.id, bob.address);
    assert.equal(bobWelcome.state.players.length, 2);
    const alicePlayer = bobWelcome.state.players.find(player => player.id === alice.address);
    const bobPlayer = bobWelcome.state.players.find(player => player.id === bob.address);
    assert.equal(alicePlayer.character, 'ranger');
    assert.equal(bobPlayer.character, 'sage');
    assert.notDeepEqual(alicePlayer.base, bobPlayer.base);
    assert.ok(Math.hypot(alicePlayer.base.x - bobPlayer.base.x, alicePlayer.base.z - bobPlayer.base.z) >= 10);
    assert.deepEqual(alicePlayer.collection, []);
    assert.equal(bobWelcome.state.packs.length, 0);
    aliceSocket.socket.send(JSON.stringify({ type: 'profile', tier: 'elite' }));
    const forgedProfile = await aliceSocket.wait(message => message.type === 'action');
    assert.equal(forgedProfile.ok, false);
    assert.match(forgedProfile.reason, /verified token holdings/);
    bobSocket.socket.send(JSON.stringify({ type: 'ability', ability: 'radar' }));
    assert.equal((await bobSocket.wait(message => message.type === 'action')).ok, true);

    // Production revalidation runs every 30 seconds. Do not add an auth bypass
    // or an accelerated test clock to the game server to make this assertion.
    balances.set(alice.address, '2499');
    balances.set(bob.address, '20000');
    const revoked = once(aliceSocket.socket, 'close');
    const downgraded = await bobSocket.wait(message => message.type === 'state' && message.state.players.some(player => player.id === bob.address && !player.elite), 35_000);
    const [closeCode] = await revoked;
    assert.equal(closeCode, 1008);
    assert.equal(downgraded.state.players.find(player => player.id === bob.address).elite, false);
    bobSocket.socket.send(JSON.stringify({ type: 'ability', ability: 'dash' }));
    const deniedTool = await bobSocket.wait(message => message.type === 'action' && message.ok === false);
    assert.match(deniedTool.reason, /above 2%/);
    assert.equal((await request('/api/auth/session', { cookie: first.cookie })).status, 401);
    assert.ok(rpcCalls >= 12);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    if (rpc.listening) await new Promise(resolveClose => rpc.close(resolveClose));
    const absoluteDirectory = resolve(directory);
    const expectedRoot = resolve(tmpdir()) + sep;
    assert.ok(absoluteDirectory.startsWith(expectedRoot) && absoluteDirectory.includes('cards-integration-'));
    rmSync(absoluteDirectory, { recursive: true, force: true });
  }
});
