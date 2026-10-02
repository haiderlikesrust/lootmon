import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { Game } from '../server/game.mjs';
import { Community, buildLeaderboard, COMMUNITY_LIMITS } from '../server/community.mjs';
import { mapGrid } from '../shared/map-grid.mjs';

const START = 1_000_000;
const identity = wallet => ({ wallet, eligible: true, elite: false, holdPercent: .25 });
const signatureFor = id => bs58.encode(createHash('sha512').update(id).digest());
const join = (game, wallet, name = wallet) => game.addPlayer(wallet, name, START, identity(wallet));
const prize = id => ({ id, mint: `private-mint-${id}`, purchaseSignature: `private-purchase-${id}`,
  tierUsd: 25, value: 68.5, name: 'PRIVATE CARD NAME', image: 'https://private.invalid/card' });
const confirmed = (id, value = 25, extra = {}) => ({ id, status: 'transferred', signature: signatureFor(id),
  tier: 25, value, securedAt: START, confirmedAt: START + 500, mint: `private-mint-${id}`, name: 'PRIVATE CARD NAME', ...extra });
const account = (name, collection = []) => ({ name, collection, score: 99_999, character: 'ranger' });

test('Looter gives shared coarse common-pack clues without exposing premium or carried locations', () => {
  const game = new Game({ now: START });
  const community = new Community(game);
  join(game, 'hunter-one'); join(game, 'hunter-two');
  game.packs = [
    { id:'common', tier:25, x:-23.456, z:24.567, difficulty:'interior', status:'hidden', mint:'private-mint' },
    { id:'rare', tier:100, x:104, z:-111, status:'hidden' },
    { id:'carried', tier:50, x:73, z:81, status:'carried' },
    { id:'won', tier:25, x:0, z:0, status:'secured' },
  ];
  const clue = community.command('/hint');
  assert.match(clue, /\$25: C4 — inside a house/);
  for (const secret of ['23.456', '24.567', 'private-mint', '$100', '$50', 'F1', 'E5']) assert.ok(!clue.includes(secret));
  assert.equal(community.submit('hunter-one', '/hint', START).ok, true);
  assert.equal(community.submit('hunter-two', '/hint', START).ok, true);
  assert.deepEqual(community.chat.filter(message => message.kind === 'bot').map(message => message.text), [clue, clue]);
  assert.equal(community.submit('unverified', '/hint', START).ok, false);
  game.packs[0].status = 'carried';
  assert.match(community.command('/hint'), /No hidden \$25\/\$50/);
  community.close();
});

test('shared map grids agree at edges, center and the player screenshot location', () => {
  assert.equal(mapGrid(-124, -124), 'A1');
  assert.equal(mapGrid(124, 124), 'F6');
  assert.equal(mapGrid(0, 0), 'D4');
  assert.equal(mapGrid(-65, 26), 'B4');
  assert.equal(mapGrid(NaN, 0), null);
});

test('Looter announces opening and verified insured value once, without exposing hiding coordinates', () => {
  const community = new Community(new Game({ now: START }));
  community.packEvent({ kind: 'opening', id: 'funded-order', tier: 25 }, START);
  community.packEvent({ kind: 'opening', id: 'funded-order', tier: 25 }, START + 1);
  community.packEvent({ kind: 'opened', id: 'funded-order', tier: 25, name: '<Rare card>', insuredValue: 68.5, x: 99, z: 45 }, START + 2);
  const snapshot = community.snapshot();
  assert.equal(snapshot.chat.length, 2);
  assert.match(snapshot.chat[0].text, /Opening a \$25 pack/);
  assert.match(snapshot.chat[1].text, /insured value \$68\.50 \(provider-reported\)/);
  assert.equal(snapshot.activity[0].insuredValue, 68.5);
  assert.equal(snapshot.activity[0].x, undefined);
  assert.equal(snapshot.activity[0].z, undefined);
  community.packEvent({ kind: 'opened', id: 'missing-value', tier: 25, insuredValue: null });
  assert.match(community.snapshot().activity[0].text, /insured value unavailable/);
  assert.equal(community.leaderboard().entries.length, 0, 'opening is not a player win');
  community.close();
});

test('an unfunded new world has an empty community and no fabricated leaderboard rows', () => {
  const game = new Game({ now: START });
  let changes = 0;
  const community = new Community(game, { onChange: () => changes++ });
  assert.deepEqual(community.snapshot(), { chat: [], activity: [] });
  assert.equal(community.leaderboard().totalCollectors, 0);
  assert.deepEqual(community.leaderboard().entries, []);
  join(game, 'empty-wallet');
  game.tick(START + 1000);
  assert.equal(community.leaderboard().totalCollectors, 0);
  assert.equal(changes, 0, 'Joining or movement must not broadcast unchanged community history');
  community.close();
});

test('standings count only signed transferred collectibles and publish aggregate fields with stable ties', () => {
  const game = new Game({ now: START });
  game.accounts = {
    zeta: account('Zeta', [confirmed('zeta', 30)]),
    beta: account('Beta', [confirmed('beta', 30)]),
    alpha: account('Alpha', [confirmed('a1', 0), confirmed('a2', 5), confirmed('a2', 5),
      confirmed('unsigned', 9000, { signature: '' }), { id: 'pending', status: 'pending_transfer', value: 2000 },
      { id: 'quarantined', status: 'delivery_quarantined', value: 5000, signature: 'not-a-delivery' }]),
    pending: account('Pending', [{ id: 'pending-only', status: 'pending_transfer', value: 500 }]),
    empty: account('Empty'),
  };
  const board = buildLeaderboard(game, START);
  assert.equal(board.updatedAt, START);
  assert.equal(board.totalCollectors, 4);
  assert.deepEqual(board.entries.map(entry => entry.wallet), ['alpha', 'beta', 'zeta', 'pending']);
  assert.deepEqual(board.entries[0], { rank: 1, wallet: 'alpha', name: 'Alpha', character: 'ranger',
    wins: 2, totalValue: 5, secured: 5, pending: 3, online: false });
  assert.equal(board.entries[3].wins, 0);
  assert.equal(board.entries[3].totalValue, 0, 'Pending insured values must not count as won value');
  const serialized = JSON.stringify(board);
  for (const secret of ['private-mint', 'PRIVATE CARD NAME', 'not-a-delivery', 'signature', 'collection', 'score', 'base', 'x', 'z']) {
    assert.equal(serialized.includes(`"${secret}"`), false);
  }
  assert.equal(serialized.includes('private-mint'), false);
  assert.equal(serialized.includes('PRIVATE CARD NAME'), false);
});

test('malformed legacy transaction signatures cannot create confirmed wins or bot announcements', () => {
  const game = new Game({ now: START });
  game.accounts.legacy = account('Legacy', [
    confirmed('invalid-text', 500, { signature: 'not-a-Solana-transaction' }),
    confirmed('invalid-base58', 500, { signature: '0'.repeat(88) }),
    confirmed('wrong-byte-length', 500, { signature: bs58.encode(new Uint8Array(63).fill(7)) }),
  ]);
  const community = new Community(game);
  assert.equal(community.leaderboard().entries[0].wins, 0);
  assert.equal(community.leaderboard().entries[0].totalValue, 0);
  assert.equal(community.leaderboard().entries[0].pending, 3);
  assert.deepEqual(community.snapshot(), { chat: [], activity: [] });
  community.close();
});

test('pickup, theft and deposit are distinct from a confirmed win; retries and restart preserve one announcement', () => {
  let saved = { version: 1, packs: [], accounts: {}, awards: [] };
  const store = { load: () => structuredClone(saved), save: value => { saved = structuredClone(value); } };
  const game = new Game({ now: START, store, randomIndex: () => 0 });
  let broadcasts = 0;
  const community = new Community(game, { onChange: () => broadcasts++ });
  game.addFundedPack(prize('real-fixture'), START);
  Object.assign(game.packs[0], { x: 0, z: 12 });
  const alice = join(game, 'alice', 'Alice'), bob = join(game, 'bob', 'Bob');
  alice.x = 0; alice.z = 12; bob.x = 1; bob.z = 12;
  assert.equal(game.interact('alice', START).action, 'picked_up');
  assert.equal(game.interact('bob', START + 3000).action, 'stolen');
  bob.x = bob.base.x; bob.z = bob.base.z;
  assert.equal(game.deliver(bob, START + 4000), true);
  assert.deepEqual(community.snapshot().activity.map(event => event.kind), ['deposit', 'stolen', 'pickup', 'spawned']);
  assert.match(community.snapshot().chat[0].text, /now hidden on the island/);
  assert.equal(community.leaderboard().entries[0].wins, 0);
  assert.equal(community.leaderboard().entries[0].pending, 1);
  game.markAward('real-fixture', { status: 'pending', code: 'confirmation_pending' });
  assert.equal(community.snapshot().chat.length, 1);
  const signature = signatureFor('real-fixture');
  assert.equal(game.markAward('real-fixture', { status: 'confirmed', signature }, START + 5000), true);
  const message = community.snapshot().chat.at(-1);
  assert.equal(message.id, 'win:real-fixture');
  assert.equal(message.kind, 'bot');
  assert.equal(message.name, 'Looter');
  assert.equal(message.signature, signature);
  assert.equal(message.time, START + 5000);
  assert.match(message.text, /Bob won a \$25 pack/);
  assert.ok(message.text.includes(signature));
  assert.equal(community.snapshot().activity[0].kind, 'win');
  assert.equal(community.leaderboard().entries[0].wins, 1);
  assert.equal(community.leaderboard().entries[0].totalValue, 68.5, 'Actual collectible value, not pack tier or player score');
  assert.equal(community.leaderboard().entries[0].pending, 0);
  const count = broadcasts;
  assert.equal(game.markAward('real-fixture', { status: 'confirmed', signature }, START + 6000), false);
  assert.equal(broadcasts, count);
  const restored = new Game({ now: START + 7000, store });
  let restartBroadcasts = 0;
  const recovered = new Community(restored, { onChange: () => restartBroadcasts++ });
  assert.deepEqual(recovered.snapshot().chat, [message]);
  assert.equal(recovered.snapshot().activity.length, 1);
  assert.equal(restartBroadcasts, 0, 'Restored history is an initial snapshot, not a fresh win broadcast');
  assert.equal(recovered.leaderboard().entries[0].name, 'Bob');
  assert.equal(recovered.leaderboard().entries[0].online, false);
  const serialized = JSON.stringify(community.snapshot());
  for (const secret of ['private-mint', 'private-purchase', 'PRIVATE CARD NAME', 'private.invalid', 'carrierId', 'base', 'collection']) assert.equal(serialized.includes(secret), false);
  community.close(); recovered.close();
});

test('wallet chat limits survive reconnect and reject malformed, duplicate, or excessive text', () => {
  const game = new Game({ now: START, randomIndex: () => 0 });
  const community = new Community(game);
  assert.equal(community.submit('unknown', 'Hello', START).ok, false);
  join(game, 'alice', 'Alice');
  for (const raw of [null, 2, true, [], { toString: null }, 'x'.repeat(241), '', ' \u0000<>\n ']) {
    assert.equal(community.submit('alice', raw, START).ok, false);
  }
  assert.equal(community.submit('alice', 'Hello world', START).ok, true);
  assert.equal(community.submit('alice', 'Another message', START + 2999).ok, false);
  assert.equal(community.submit('alice', ' hello   WORLD ', START + 3000).ok, false);
  assert.equal(community.submit('alice', 'Another message', START + 3000).ok, true);
  assert.equal(community.submit('alice', 'HELLO WORLD', START + 6000).ok, false, 'Alternating messages cannot evade duplicate detection');
  game.removePlayer('alice', START + 3100); join(game, 'alice', 'Renamed');
  assert.equal(community.submit('alice', 'Reconnected', START + 4000).ok, false);
  for (let i = 2; i < 8; i++) assert.equal(community.submit('alice', `Message ${i}`, START + i * 3000).ok, true);
  assert.equal(community.submit('alice', 'Ninth message', START + 24000).ok, false);
  assert.equal(community.submit('alice', 'Window renewed', START + 60000).ok, true);
  assert.equal(community.snapshot().chat.length, 9);
  const last = community.snapshot().chat.at(-1);
  assert.equal(last.kind, 'player'); assert.equal(last.wallet, 'alice'); assert.equal(last.name, 'Renamed');
  assert.equal(Object.hasOwn(last, 'signature'), false);
  community.close();
});

test('Looter commands are deterministic public guidance without private pack or base coordinates', () => {
  const game = new Game({ now: START, randomIndex: () => 0 });
  const player = join(game, 'alice', 'Looter');
  const community = new Community(game);
  const commands = ['/help', '/rules', '/base', '/drops', '/leaderboard', '/spawn 500'];
  for (const [index, command] of commands.entries()) {
    assert.equal(community.submit('alice', command, START + index * 3000).ok, true);
    const [sent, bot] = community.snapshot().chat.slice(-2);
    assert.equal(sent.kind, 'player'); assert.notEqual(sent.name, 'Looter');
    assert.equal(bot.kind, 'bot'); assert.equal(bot.name, 'Looter');
    assert.equal(Object.hasOwn(bot, 'wallet'), false);
    assert.equal(Object.hasOwn(bot, 'signature'), false);
    assert.ok(bot.text.length > 20);
  }
  assert.match(community.command('/rules'), /0\.25%/);
  assert.match(community.command('/base'), /YOUR BASE/);
  assert.match(community.command('/drops'), /0 funded packs hidden/);
  assert.match(community.command('/leaderboard'), /No confirmed wins/);
  assert.equal(community.command('/base').includes(`${player.base.x},`), false);
  assert.equal(game.packs.length, 0, 'Chat commands cannot spawn or award inventory');
  community.close();
});

test('visible history stays bounded and evicting a win never permits its typed event to announce it again', () => {
  const game = new Game({ now: START, randomIndex: () => 0 });
  game.accounts.alice = account('Alice', [confirmed('original-win')]);
  join(game, 'alice', 'Alice');
  let broadcasts = 0;
  const community = new Community(game, { onChange: () => broadcasts++ });
  for (let index = 0; index < 130; index++) assert.equal(community.submit('alice', `Chat ${index}`, START + index * 10_000).ok, true);
  for (let index = 0; index < 25; index++) game.addEvent('Fixture pickup', START + index, { kind: 'pickup', name: 'Alice', wallet: 'alice', tier: 25 });
  assert.equal(community.snapshot().chat.length, COMMUNITY_LIMITS.chat);
  assert.equal(community.snapshot().activity.length, COMMUNITY_LIMITS.activity);
  assert.equal(community.snapshot().chat.some(message => message.id === 'win:original-win'), false);
  assert.equal(community.snapshot().activity.some(event => event.id === 'win:original-win'), false);
  const count = broadcasts;
  game.notifyListeners(null, { kind: 'win', wallet: 'alice', awardId: 'original-win' });
  assert.equal(broadcasts, count);
  assert.equal(community.snapshot().chat.some(message => message.id === 'win:original-win'), false);
  const snapshot = community.snapshot(); snapshot.chat[0].text = 'tampered'; snapshot.activity.length = 0;
  assert.notEqual(community.snapshot().chat[0].text, 'tampered');
  assert.equal(community.snapshot().activity.length, 20);
  community.close();
});

test('restored confirmed history and the leaderboard have bounded public responses', () => {
  const game = new Game({ now: START });
  for (let index = 0; index < 150; index++) game.accounts[`wallet-${String(index).padStart(3, '0')}`] = account(`Hunter ${index}`, [confirmed(`win-${index}`, index, { confirmedAt: START + index })]);
  const community = new Community(game);
  assert.equal(community.snapshot().chat.length, 120);
  assert.equal(community.snapshot().activity.length, 20);
  assert.equal(community.snapshot().chat[0].id, 'win:win-30');
  assert.equal(community.snapshot().activity[0].id, 'win:win-149');
  assert.equal(community.leaderboard().totalCollectors, 150);
  assert.equal(community.leaderboard().entries.length, 100);
  assert.equal(community.leaderboard().entries[0].wallet, 'wallet-149');
  game.notifyListeners(null, { kind: 'win', wallet: 'wallet-000', awardId: 'win-0' });
  assert.equal(community.snapshot().chat.length, 120);
  assert.equal(community.snapshot().chat.some(message => message.id === 'win:win-0'), false);
  community.close();
});

test('public leaderboard reads reuse the cache until a real profile or award transition occurs', () => {
  const game = new Game({ now: START, randomIndex: () => 0 });
  game.accounts.alice = account('Alice', [confirmed('one-win')]);
  join(game, 'alice', 'Alice');
  const collection = game.accounts.alice.collection;
  let reads = 0;
  Object.defineProperty(game.accounts.alice, 'collection', { get() { reads++; return collection; }, configurable: true });
  const community = new Community(game);
  const initialReads = reads;
  const before = community.leaderboard().updatedAt;
  for (let index = 0; index < 50; index++) { community.leaderboard(START + index); community.snapshot(); }
  assert.equal(reads, initialReads, 'Anonymous polling must not rescan durable reward collections');
  assert.equal(community.leaderboard().updatedAt, before);
  game.setCharacter('alice', 'sage');
  assert.equal(community.leaderboard(START + 100).entries[0].character, 'sage');
  assert.ok(reads > initialReads);
  game.removePlayer('alice', START + 200);
  assert.equal(community.leaderboard(START + 200).entries[0].online, false);
  community.close();
});
