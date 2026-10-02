import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Evaluate the actual entry module and its wallet/socket callbacks. Rendering,
// browser surfaces and transport are fixtures; authentication logic is not.
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const iconNames = ['Compass', 'Wallet', 'ArrowUpRight', 'Layers', 'MapIcon', 'Backpack', 'Settings2', 'CircleHelp', 'X', 'ShieldCheck', 'Radio', 'Zap', 'Home', 'LockKeyhole', 'Gem', 'ChevronRight', 'Trophy', 'Volume2', 'Crosshair', 'Users', 'Clock3', 'Copy', 'Check', 'Maximize2', 'Leaf', 'ExternalLink', 'LogOut'];
const noop = () => {};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

class Element extends EventTarget {
  textContent = ''; innerHTML = ''; hidden = false; open = false; dataset = {}; style = {}; attributes = new Map();
  classList = { add: noop, remove: noop, toggle: noop };
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.onclick?.({ target: this }); }
}
async function fixture() {
  const nodes = new Map();
  const element = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const document = new EventTarget();
  Object.assign(document, { querySelector: element, querySelectorAll: () => [], body: new Element(), hidden: false });
  const initialSession = deferred(), walletConnect = deferred(), verify = deferred(), requests = [], sockets = [];
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; sent = []; closed = false;
    constructor(url) { this.url = url; sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.closed = true; this.readyState = Socket.CLOSED; this.onclose?.(); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  class Game {
    ready = Promise.resolve(); variant = 'scout'; playing = false; exploring = false; leaveCalls = 0;
    world = { spawn: { x: 0, z: 22 }, landmarks: [] }; controls = { autoRotate: false }; explorationPosition = { x: 0, z: 22, yaw: 0 };
    leave() { this.leaveCalls++; this.playing = false; this.exploring = false; }
    setState(value) { this.state = value; }
    setPlaying(id) { this.playing = true; this.id = id; }
    releasePointer() {} clearInput() {} gesture() {}
  }
  class Audio { enabled = true; step() {} click() {} denied() {} pickup() {} steal() {} deliver() {} ability() {} }
  const response = payload => ({ ok: true, json: async () => payload });
  const fetch = async (path, options = {}) => {
    requests.push({ path, options, body: options.body ? JSON.parse(options.body) : null });
    if (path === '/api/auth/session') return response(await initialSession.promise);
    if (path === '/api/config') return response({ configured: true, site: { contractAddress: null, xUrl: null } });
    if (path === '/api/status') return response({ state: { online: 0, treasury: {}, packCounts: { total: 0 } } });
    if (path === '/api/ping') return response({ ok: true });
    if (path === '/api/auth/challenge') return response({ nonce: 'fixture-nonce', message: 'Fixture proof only' });
    if (path === '/api/auth/verify') return response(await verify.promise);
    if (path === '/api/auth/logout') return response({ ok: true });
    throw new Error(`Unexpected fixture request: ${path}`);
  };
  const window = { setTimeout: () => 1, phantom: { solana: { connect: () => walletConnect.promise, signMessage: async () => ({ signature: new Uint8Array(64) }) } } };
  const dependencies = {
    CHARACTER_OPTIONS: [{ id: 'scout', name: 'Trail Scout', description: '' }, { id: 'ranger', name: 'Ranger', description: '' }, { id: 'sage', name: 'Sage', description: '' }],
    DISTRICT_INFO: [], drawIslandMap: noop, GameAudio: Audio, createIcons: noop, Game, startNavigationHUD: noop,
    createCommunityUI: () => ({ receive: noop, ack: noop, refreshSession: noop, navigate: noop }),
    document, window, fetch, WebSocket: Socket, setInterval: () => 1, clearTimeout: noop,
    matchMedia: () => ({ matches: false }), location: { protocol: 'https:', host: 'lootmon.test' },
    ...Object.fromEntries(iconNames.map(name => [name, noop])),
  };
  const app = new Function(...Object.keys(dependencies), `${compiled}\nreturn { connectWallet, restoreSession, join, leave, game, peek:()=>({ walletAddress, sessionReady, connecting, collection, myId, socket }) };`)(...Object.values(dependencies));
  await flush();
  return { app, element, initialSession, walletConnect, verify, requests, sockets };
}
const walletA = 'AAAA111111111111111111111111111111AAAA';
const walletB = 'BBBB222222222222222222222222222222BBBB';
const reward = id => ({ id, mint: id, tier: 25, value: 25, status: 'transferred', securedAt: 1 });
const session = (wallet, id) => ({ ok: true, player: { wallet, holdPercent: 0.5 }, collection: [reward(id)] });
const welcome = wallet => ({ type: 'welcome', id: wallet, state: { players: [{ id: wallet, name: 'Collector', x: 0, z: 0, yaw: 0, carrying: null, base: { x: 0, z: 0 }, score: 0, elite: false, collection: [reward('card-A')] }], packs: [], treasury: {}, events: [] } });

test('a late initial session restore cannot overwrite the newly verified wallet or its collection', async () => {
  const f = await fixture();
  const signing = f.app.connectWallet();
  f.walletConnect.resolve({ publicKey: { toString: () => walletB } });
  f.verify.resolve(session(walletB, 'card-B'));
  await signing;
  assert.equal(f.app.peek().walletAddress, walletB);
  f.initialSession.resolve(session(walletA, 'card-A'));
  await flush();
  assert.equal(f.app.peek().walletAddress, walletB);
  assert.equal(f.app.peek().sessionReady, true);
  assert.deepEqual(f.app.peek().collection.map(item => item.id), ['card-B']);
  assert.equal(f.element('#wallet-button span').textContent, 'BBBB…BBBB');
});

test('switching wallets closes the old active socket and clears its cards before the new signature completes', async () => {
  const f = await fixture();
  f.initialSession.resolve(session(walletA, 'card-A')); await flush();
  f.app.join();
  const first = f.sockets[0]; first.open(); first.receive(welcome(walletA));
  assert.equal(f.app.peek().myId, walletA);
  assert.equal(f.app.game.playing, true);
  const signing = f.app.connectWallet(true);
  assert.equal(first.closed, true, 'Old wallet authority is left before waiting for another wallet');
  assert.equal(f.app.game.playing, false);
  assert.equal(f.app.peek().myId, null);
  assert.equal(f.app.peek().sessionReady, false);
  assert.equal(f.app.peek().walletAddress, '');
  assert.deepEqual(f.app.peek().collection, []);
  assert.equal(f.element('#collection-count').textContent, '0');
  f.app.join();
  assert.equal(f.sockets.length, 1, 'Cannot deploy during an unverified wallet transition');
  f.walletConnect.resolve({ publicKey: { toString: () => walletB } });
  f.verify.resolve(session(walletB, 'card-B')); await signing;
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open();
  assert.equal(f.sockets[1].sent[0].type, 'join');
  assert.equal(f.sockets[1].sent[0].name, 'BBBB…BBBB');
  assert.deepEqual(f.app.peek().collection.map(item => item.id), ['card-B']);
});

test('late restore during pending signing cannot permit a join, and a cancelled switch stays cleared', async () => {
  const f = await fixture();
  const signing = f.app.connectWallet();
  f.initialSession.resolve(session(walletA, 'card-A')); await flush();
  assert.equal(f.app.peek().sessionReady, false);
  assert.equal(f.app.peek().walletAddress, '');
  f.app.join();
  assert.equal(f.sockets.length, 0);
  f.walletConnect.reject(new Error('User cancelled the new wallet connection')); await signing;
  assert.equal(f.app.peek().sessionReady, false);
  assert.equal(f.app.peek().walletAddress, '');
  assert.deepEqual(f.app.peek().collection, []);
  f.app.join();
  assert.equal(f.sockets.length, 0);
});
