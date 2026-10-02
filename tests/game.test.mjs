import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Game, GAME_RULES } from '../server/game.mjs';
import { FileStore } from '../server/storage.mjs';
import { HOME_PADS, HOME_LAYOUT_VERSION, HOUSES, HIDING_AREAS, HIDING_SPOTS } from '../shared/world-layout.mjs';
import { getWorldPlacement, SPAWN_POLICY, SPAWN_REUSE_MS, MAX_PLAYERS } from '../server/world-placement.mjs';

const START = 1_000_000;
const identity = (wallet, elite = false) => ({ wallet, eligible: true, elite, holdPercent: elite ? 2.5 : 0.25 });
const add = (game, id, elite = false) => game.addPlayer(id, id, START, identity(id, elite));
const fixturePrize = (id, tierUsd = 25) => ({ id, mint: `${id}-mint`, name: 'Test inventory', tierUsd, value: tierUsd, purchaseSignature: 'confirmed-test-transaction' });
const WORLD_COLLIDERS = JSON.parse(readFileSync(new URL('../shared/world-colliders.json', import.meta.url), 'utf8'));
const create = options => {
  const game = new Game({ now: START, ...options });
  game.addFundedPack(fixturePrize('pack-1'), START);
  Object.assign(game.packs[0], { x: 0, z: 12 });
  return game;
};

test('production world starts empty and rejects an unauthenticated identity', () => {
  const game = new Game({ now: START });
  assert.equal(game.packs.length, 0);
  assert.equal(game.players.size, 0);
  assert.equal(game.state(null).mode, 'live');
  assert.throws(() => game.addPlayer('wallet', 'Name', START), /Verified eligible/);
  assert.throws(() => game.addFundedPack({ id: 'unfunded', tierUsd: 500 }), /custodied/);
});

test('malformed JSON join names cannot invoke object conversion or crash the game authority', () => {
  const game = new Game({ now: START });
  const names = [null, 123, [], {}, JSON.parse('{"toString":null}'), JSON.parse('{"toString":"invalid","valueOf":{}}')];
  for (const [index, name] of names.entries()) {
    const wallet = `name-fixture-${index}`;
    const player = game.addPlayer(wallet, name, START, identity(wallet));
    assert.equal(player.name, 'HUNTER');
    assert.equal(player.carrying, null);
    assert.equal(player.elite, false);
  }
  const player = game.addPlayer('valid-name', '  <Explorer>\u0000  ', START, identity('valid-name'));
  assert.equal(player.name, 'Explorer');
  assert.equal(game.players.size, names.length + 1);
});

test('character selection persists across reconnect, is whitelisted, and changes no gameplay privileges', () => {
  const game = create();
  const player = add(game, 'p');
  const originalStats = { elite: player.elite, stamina: player.stamina, score: player.score, abilityReadyAt: player.abilityReadyAt };
  assert.equal(game.setCharacter('p', 'sage'), true);
  assert.equal(game.state('p', START).players[0].character, 'sage');
  assert.equal(game.setCharacter('p', 'admin'), false);
  assert.equal(player.character, 'sage');
  assert.deepEqual({ elite: player.elite, stamina: player.stamina, score: player.score, abilityReadyAt: player.abilityReadyAt }, originalStats);
  game.removePlayer('p', START + 100);
  assert.equal(add(game, 'p').character, 'sage');
});

test('jump requires a joined player, replicates authority timing, and grants no gameplay privileges', () => {
  const game = create();
  assert.deepEqual(game.jump('unknown', START), { ok: false, reason: 'Deploy into the world first.' });
  assert.equal(game.players.size, 0);
  const player = add(game, 'p');
  add(game, 'observer');
  const before = { x: player.x, z: player.z, elite: player.elite, stamina: player.stamina, score: player.score, ability: player.ability, carrying: player.carrying };
  const result = game.jump('p', START);
  assert.deepEqual(result, { ok: true, action: 'jump', jumpStartedAt: START, jumpUntil: START + 800, jumpReadyAt: START + 920 });
  const remote = game.state('observer', START + 50).players.find(item => item.id === 'p');
  assert.equal(remote.jumpStartedAt, START);
  assert.equal(remote.jumpUntil, START + 800);
  assert.equal(remote.jumpReadyAt, START + 920);
  assert.deepEqual({ x: player.x, z: player.z, elite: player.elite, stamina: player.stamina, score: player.score, ability: player.ability, carrying: player.carrying }, before);
  assert.equal(game.useAbility('p', 'dash', START).ok, false);
});

test('jump cannot be retriggered in the air or during grounded recovery, including reconnect', () => {
  const game = create();
  add(game, 'p');
  assert.equal(game.jump('p', START).ok, true);
  assert.equal(game.jump('p', START + 799).ok, false);
  assert.equal(game.jump('p', START + 800).ok, false);
  game.removePlayer('p', START + 850);
  const returning = game.addPlayer('p', 'P', START + 850, identity('p'));
  assert.equal(returning.jumpUntil, 0);
  assert.equal(returning.jumpReadyAt, START + 920);
  assert.equal(game.jump('p', START + 919).ok, false);
  assert.equal(game.jump('p', START + 920).ok, true);
});

test('jump does not bypass wall collision or extend snatch reach', () => {
  const game = create({ colliders: [{ x: 1.2, z: 22, w: 0.4, d: 8 }] });
  const player = add(game, 'p');
  player.x = 0; player.z = 22;
  assert.equal(game.jump('p', START).ok, true);
  game.move('p', { x: 10, z: 22, yaw: 0 }, START + 250);
  assert.equal(player.x, 0);
  const carrier = add(game, 'carrier');
  carrier.x = 0; carrier.z = 12;
  game.interact('carrier', START);
  player.x = GAME_RULES.stealRange + 0.01; player.z = 12;
  game.jump('p', START + 3000);
  assert.equal(game.interact('p', START + 3000).ok, false);
  player.x = GAME_RULES.stealRange;
  assert.equal(game.interact('p', START + 3000).action, 'stolen');
});

test('pickup protection, theft and delivery produce a single durable prize claim', () => {
  const game = create();
  const alice = add(game, 'alice');
  const bob = add(game, 'bob');
  alice.x = 0; alice.z = 12;
  bob.x = 2; bob.z = 12;
  assert.equal(game.interact(alice.id, START).action, 'picked_up');
  assert.equal(game.interact(bob.id, START + 1999).ok, false);
  assert.equal(game.interact(bob.id, START + 2000).action, 'stolen');
  assert.equal(alice.carrying, null);
  assert.equal(bob.carrying, 'pack-1');
  assert.equal(game.deliver(bob, START + 2001), false);
  bob.x = bob.base.x; bob.z = bob.base.z;
  assert.equal(game.deliver(bob, START + 2002), true);
  assert.equal(bob.score, 25);
  assert.equal(bob.collection[0].status, 'pending_transfer');
  assert.equal(game.pendingAwards().length, 1);
  assert.equal(game.pendingAwards()[0].wallet, 'bob');
  assert.equal(game.deliver(bob, START + 2003), false);
  assert.equal(game.packs[0].status, 'secured');
  assert.equal(game.markAward('pack-1', { status: 'pending' }), false);
  assert.equal(game.markAward('pack-1', { status: 'confirmed', signature: 'confirmed-award-signature' }), true);
  assert.equal(bob.collection[0].status, 'transferred');
  assert.equal(game.pendingAwards().length, 0);
});

test('pickup, steal and extraction ranges are checked by the authority', () => {
  const game = create();
  const player = add(game, 'p');
  player.x = GAME_RULES.pickupRange + 0.01; player.z = 12;
  assert.equal(game.interact(player.id, START).ok, false);
  player.x = GAME_RULES.pickupRange;
  assert.equal(game.interact(player.id, START).ok, true);
  const thief = add(game, 't');
  thief.x = player.x + GAME_RULES.stealRange + 0.01; thief.z = player.z;
  assert.equal(game.interact(thief.id, START + 3000).ok, false);
  thief.x = player.x + GAME_RULES.stealRange;
  assert.equal(game.interact(thief.id, START + 3000).action, 'stolen');
  thief.x = thief.base.x + GAME_RULES.deliveryRange + 0.01; thief.z = thief.base.z;
  assert.equal(game.deliver(thief, START + 3100), false);
  thief.x = thief.base.x + GAME_RULES.deliveryRange;
  assert.equal(game.deliver(thief, START + 3100), true);
});

test('teleports are clamped and packet flooding cannot manufacture movement time', () => {
  const game = create();
  const player = add(game, 'p');
  player.x = 0; player.z = 22;
  game.move('p', { x: 100, z: 22, yaw: 0 }, START + 100);
  assert.equal(player.x, 1);
  for (let i = 0; i < 20; i++) game.move('p', { x: 100, z: 22, yaw: 0 }, START + 100);
  assert.equal(player.x, 1);
  game.move('p', { x: 100, z: 22, yaw: 0 }, START + 100000);
  assert.equal(player.x, 3.5);
  assert.equal(game.move('p', { x: Infinity, z: 22, yaw: 0 }, START + 100001), false);
  assert.equal(player.x, 3.5);
});

test('malformed and extreme movement packets cannot corrupt coordinates, forge privileges, or move a carried prize beyond authority speed', () => {
  const game = create();
  const player = add(game, 'packet-fixture');
  player.x = 0; player.z = 12;
  assert.equal(game.interact(player.id, START).action, 'picked_up');
  const home = { ...player.base };
  const original = { x: player.x, z: player.z, yaw: player.yaw, lastMoveAt: player.lastMoveAt, stamina: player.stamina };
  for (const payload of [
    { x: NaN, z: 0, yaw: 0 }, { x: Infinity, z: 0, yaw: 0 }, { x: 0, z: -Infinity, yaw: 0 },
    { x: null, z: 0, yaw: 0 }, { x: '0', z: 0, yaw: 0 }, { x: 0, z: [], yaw: 0 },
    { x: 0, z: 0, yaw: {} }, { x: 0, z: 0 },
  ]) {
    assert.equal(game.move(player.id, payload, START + 250), false);
    assert.deepEqual({ x: player.x, z: player.z, yaw: player.yaw, lastMoveAt: player.lastMoveAt, stamina: player.stamina }, original);
  }
  for (const [index, [x, z]] of [
    [Number.MAX_VALUE, Number.MAX_VALUE], [-Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MAX_VALUE, 1], [0, -1e100], [10000, 10000], [-10000, -10000], [1e100, -1e100],
  ].entries()) {
    const before = { x: player.x, z: player.z };
    game.move(player.id, { x, z, yaw: Number.MAX_VALUE, now: START + 1e12, timestamp: START + 1e12, speed: 1e9, elite: true, base: { x: 0, z: 12 }, carrying: null }, START + (index + 1) * 250);
    assert.ok(Number.isFinite(player.x) && Number.isFinite(player.z) && Number.isFinite(player.yaw));
    assert.ok(Math.hypot(player.x - before.x, player.z - before.z) <= GAME_RULES.walkSpeed * GAME_RULES.carrySpeedMultiplier * .25 + 1e-9);
    assert.equal(game.collides(player.x, player.z), false);
    assert.equal(player.elite, false);
    assert.deepEqual(player.base, home);
    assert.equal(player.carrying, 'pack-1');
    assert.equal(game.packs[0].status, 'carried');
    assert.equal(game.packs[0].x, player.x);
    assert.equal(game.packs[0].z, player.z);
    assert.equal(game.awards.length, 0);
  }
});

test('walls block movement and interactions, carrying imposes a speed penalty', () => {
  const game = create({ colliders: [{ x: 1.2, z: 22, w: 0.4, d: 8 }, { x: 1.5, z: 12, w: 0.4, d: 8 }] });
  const player = add(game, 'p');
  player.x = 0; player.z = 22;
  game.move('p', { x: 10, z: 22, yaw: 0 }, START + 250);
  assert.equal(player.x, 0);
  player.x = 3; player.z = 12;
  assert.equal(game.interact('p', START).ok, false);
  game.colliders = [];
  player.x = 0;
  game.interact('p', START + 300);
  game.move('p', { x: 20, z: 12, yaw: 0 }, START + 350);
  assert.equal(player.x, 0.8);
});

test('elite tools require verified privilege and have shared cooldowns', () => {
  const game = create();
  const player = add(game, 'p');
  assert.equal(game.useAbility('p', 'radar', START).ok, false);
  game.updateIdentity('p', identity('p', true));
  assert.equal(game.useAbility('p', 'radar', START).ok, true);
  assert.equal(player.abilityUntil, START + 8000);
  assert.equal(game.useAbility('p', 'dash', START + 8001).ok, false);
  assert.equal(game.useAbility('p', 'dash', START + 45000).ok, true);
  game.updateIdentity('p', identity('p', false));
  assert.equal(player.ability, null);
  assert.equal(player.elite, false);
});

test('hidden coordinates are private until proximity discovery or elite radar', () => {
  const game = create();
  const player = add(game, 'p', true);
  player.x = 0; player.z = 22;
  Object.assign(game.packs[0], { x: 35, z: 22 });
  assert.equal(game.state(null, START).packs.length, 0);
  assert.equal(game.state('p', START).packs.length, 0);
  assert.equal(game.publicStatus().packCounts.total, 1);
  assert.equal(Object.hasOwn(game.publicStatus(), 'packs'), false);
  game.useAbility('p', 'radar', START);
  assert.equal(game.state('p', START + 1).packs.length, 1);
  assert.equal(game.state('p', START + 8000).packs.length, 0);
  player.x = 23;
  assert.equal(game.state('p', START + 8000).packs.length, 1);
});

test('disconnect drops a pack and purchased inventory ingestion is idempotent', () => {
  const game = create();
  const player = add(game, 'p');
  player.x = 0; player.z = 12;
  game.interact('p', START);
  game.removePlayer('p', START + 100);
  assert.equal(game.players.has('p'), false);
  assert.equal(game.packs[0].status, 'hidden');
  assert.equal(game.packs[0].carrierId, null);
  assert.equal(game.addFundedPack(fixturePrize('pack-1')), false);
  assert.equal(game.packs.length, 1);
});

test('reconnecting cannot reset elite cooldowns, steal cooldowns or spent stamina', () => {
  const game = create();
  const player = add(game, 'p', true);
  game.useAbility('p', 'dash', START);
  player.stamina = 17;
  player.stealReadyAt = START + 6000;
  game.removePlayer('p', START + 1000);
  const returning = game.addPlayer('p', 'P', START + 1000, identity('p', true));
  assert.equal(returning.stamina, 17);
  assert.equal(returning.stealReadyAt, START + 6000);
  assert.equal(returning.abilityUntil, START + 8000);
  assert.equal(returning.abilityReadyAt, START + 45000);
  assert.equal(game.useAbility('p', 'dash', START + 1000).ok, false);
  assert.equal(game.useAbility('p', 'radar', START + 44999).ok, false);
  assert.equal(game.useAbility('p', 'radar', START + 45000).ok, true);
});

test('restart recovers extraction outbox and collection without duplicating a prize', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cards-ledger-'));
  let store;
  try {
    store = new FileStore(directory);
    const game = create({ store });
    assert.throws(() => new FileStore(directory), /Another game authority/);
    const player = add(game, 'p');
    player.x = 0; player.z = 12;
    game.interact('p', START);
    player.x = player.base.x; player.z = player.base.z;
    game.deliver(player, START + 3000);
    store.close();
    store = new FileStore(directory);
    const restored = new Game({ store, now: START + 5000 });
    assert.equal(restored.pendingAwards().length, 1);
    assert.equal(restored.packs[0].status, 'secured');
    const returning = add(restored, 'p');
    assert.equal(returning.collection.length, 1);
    assert.equal(returning.score, 25);
    assert.equal(restored.addFundedPack(fixturePrize('pack-1')), false);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('elite cooldown is persisted at activation and survives an authority restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cards-cooldown-'));
  let store;
  try {
    store = new FileStore(directory);
    const game = create({ store });
    add(game, 'p', true);
    game.useAbility('p', 'dash', START);
    store.close();
    store = new FileStore(directory);
    const restored = new Game({ store, now: START + 5000 });
    const player = restored.addPlayer('p', 'P', START + 5000, identity('p', true));
    assert.equal(player.abilityUntil, START + 8000);
    assert.equal(restored.useAbility('p', 'radar', START + 5000).ok, false);
    assert.equal(player.abilityReadyAt, START + 45000);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the actual island supports 64 distinct reachable home bases with clear extraction circles', () => {
  const game = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0 });
  const navigation = game.placement();
  assert.equal(navigation.bases.length, HOME_PADS.length);
  assert.ok(navigation.bases.length >= MAX_PLAYERS);
  const bases = Array.from({ length: MAX_PLAYERS }, (_, index) => add(game, `hunter-${index}`).base);
  assert.equal(new Set(bases.map(point => `${point.x},${point.z}`)).size, MAX_PLAYERS);
  for (const base of bases) {
    assert.equal(game.collides(base.x, base.z, GAME_RULES.deliveryRange + .1), false, JSON.stringify(base));
    assert.equal(navigation.reachable(base), true, JSON.stringify(base));
    for (const other of bases) if (other !== base) assert.ok(Math.hypot(base.x - other.x, base.z - other.z) >= 10);
  }
  assert.throws(() => add(game, 'overflow'), /world is full/);
  assert.equal(Object.hasOwn(game.accounts, 'overflow'), false);
  assert.equal(game.players.size, MAX_PLAYERS);
});

test('home allocation uses server randomness rather than a wallet-derived location and survives reconnect', () => {
  const first = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0 });
  const second = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0 });
  const differentDraw = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: count => count - 1 });
  const home = { ...add(first, 'wallet-a').base };
  assert.deepEqual(add(second, 'wallet-b').base, home);
  assert.notDeepEqual(add(differentDraw, 'wallet-a').base, home);
  first.removePlayer('wallet-a', START + 100);
  assert.deepEqual(add(first, 'wallet-a').base, home);
  assert.equal(first.accounts['wallet-a'].baseLayoutVersion, HOME_LAYOUT_VERSION);
});

test('only offline accounts migrate legacy or occupied bases; connected carriers keep their exact home', () => {
  const game = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0 });
  game.accounts.legacy = { score: 75, collection: [{ id: 'prior-award' }], base: { x: 123, z: -123 } };
  const legacy = add(game, 'legacy');
  assert.equal(game.placement().bases.some(base => base.x === legacy.base.x && base.z === legacy.base.z), true);
  assert.equal(legacy.score, 75);
  assert.deepEqual(legacy.collection, [{ id: 'prior-award' }]);
  const originalBase = legacy.base;
  legacy.carrying = 'in-transit';
  game.accounts.legacy.baseLayoutVersion = 1;
  assert.equal(add(game, 'legacy'), legacy);
  assert.equal(legacy.base, originalBase);
  assert.equal(legacy.carrying, 'in-transit');
  legacy.carrying = null;
  game.removePlayer('legacy', START + 100);
  const replacement = add(game, 'replacement');
  assert.deepEqual(replacement.base, originalBase);
  const returning = add(game, 'legacy');
  assert.notDeepEqual(returning.base, replacement.base);
  assert.equal(returning.score, 75);
  assert.deepEqual(returning.collection, [{ id: 'prior-award' }]);
});

test('all authored hide sites used by the authority are reachable through actual geometry and have bounded home routes', () => {
  const navigation = getWorldPlacement(WORLD_COLLIDERS);
  const game = new Game({ now: START, colliders: WORLD_COLLIDERS });
  for (const tier of [25, 50, 100, 250, 500]) {
    const sites = navigation.spotsForTier(tier), policy = SPAWN_POLICY[tier];
    assert.ok(sites.length >= (tier >= 250 ? 15 : 50), `Insufficient safe variety for $${tier}: ${sites.length}`);
    for (const site of sites) {
      assert.equal(game.collides(site.x, site.z), false, `${site.id} is inside a collider`);
      assert.equal(navigation.reachable(site), true, `${site.id} has no walking route`);
      const route = navigation.routeMetrics(site);
      assert.equal(route.lengths.length, HOME_PADS.length);
      assert.ok(route.lengths.every(Number.isFinite));
      assert.ok(route.minimum >= policy.minRoute, `${site.id}: shortest home route ${route.minimum}`);
      assert.ok(route.ratio <= policy.maxRatio, `${site.id}: route ratio ${route.ratio}`);
      assert.ok(route.spread <= policy.maxSpread, `${site.id}: route spread ${route.spread}`);
    }
    if (tier <= 100) {
      assert.ok(sites.some(site => site.kind === 'interior'));
      assert.ok(sites.some(site => site.kind === 'woodland'));
    }
  }
  for (const site of navigation.spotsForTier(100).filter(site => site.kind === 'interior')) {
    assert.ok(HOUSES.some(([x, z, w, d]) => Math.abs(site.x - x) < w / 2 - .65 && Math.abs(site.z - z) < d / 2 - .65), site.id);
  }
  assert.ok(navigation.spotsForTier(500).every(site => site.z < -112), 'Top tier must be beyond the river bridges');
  assert.ok(Math.min(...navigation.spotsForTier(500).map(site => navigation.routeMetrics(site).minimum)) >
    Math.min(...navigation.spotsForTier(250).map(site => navigation.routeMetrics(site).minimum)) + 40);
});

test('premium chambers block facade pickup and normal discovery, while the verified radar reveals through walls', () => {
  const game = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0 });
  const area = HIDING_AREAS.find(item => item.id === 'forgotten-court');
  const site = game.placement().spotsForTier(250).find(item => item.id === `${area.id}-2`);
  assert.ok(site);
  assert.equal(game.clearLine({ x: area.x + area.w / 2 - 1.7, z: area.z + area.d / 2 + 1.4 }, site), false);
  assert.equal(game.addFundedPack(fixturePrize('concealed', 250), START), true);
  Object.assign(game.packs[0], { x: site.x, z: site.z });
  const player = add(game, 'ranger', true);
  player.x = site.x; player.z = area.z - area.d / 2 - 1.2;
  assert.ok(Math.hypot(player.x - site.x, player.z - site.z) < GAME_RULES.pickupRange);
  assert.equal(game.state('ranger', START).packs.length, 0);
  assert.equal(game.interact('ranger', START).ok, false);
  assert.equal(game.useAbility('ranger', 'radar', START).ok, true);
  assert.equal(game.state('ranger', START + 1).packs.length, 1);
  assert.equal(game.interact('ranger', START + 1).ok, false, 'Radar must not grant pickup through the wall');
  player.x = site.x; player.z = site.z;
  assert.equal(game.interact('ranger', START + 2).action, 'picked_up');
});

test('randomized funded hides never overlap existing packs across any price tier, even after site cooldown expires', () => {
  const game = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0 });
  for (const tier of [500, 250, 100, 50, 25]) {
    for (let index = 0; index < 35; index++) game.addFundedPack(fixturePrize(`prize-${tier}-${index}`, tier), START);
  }
  assert.ok(game.pendingSpawns.length > 0);
  assert.ok(game.packs.length > 20);
  for (const pack of game.packs) {
    assert.equal(game.placement().reachable(pack), true);
    assert.equal(game.collides(pack.x, pack.z), false);
    for (const other of game.packs) if (pack !== other) {
      assert.ok(Math.hypot(pack.x - other.x, pack.z - other.z) >= Math.max(SPAWN_POLICY[pack.tier].spacing, SPAWN_POLICY[other.tier].spacing), `${pack.id} overlaps ${other.id}`);
    }
  }
  const first = game.packs[0];
  const occupiedPosition = { x: first.x, z: first.z };
  first.status = 'carried'; first.carrierId = 'in-transit';
  const originalIds = new Set(game.packs.map(pack => pack.id));
  game.retryPendingSpawns(START + SPAWN_REUSE_MS + 1);
  for (const pack of game.packs.filter(item => !originalIds.has(item.id))) {
    assert.ok(Math.hypot(pack.x - occupiedPosition.x, pack.z - occupiedPosition.z) >= Math.max(SPAWN_POLICY[pack.tier].spacing, SPAWN_POLICY[first.tier].spacing));
  }
  const allIds = [...game.packs, ...game.pendingSpawns].map(item => item.id);
  assert.equal(allIds.length, 175);
  assert.equal(new Set(allIds).size, 175);
});

test('camping all premium chambers queues a funded prize until a clear chamber becomes available', () => {
  const game = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0 });
  for (const area of HIDING_AREAS.filter(item => item.tier === 500)) Object.assign(add(game, area.id), { x: area.x, z: area.z - area.d / 2 + 1.6 });
  assert.equal(game.addFundedPack(fixturePrize('wait-for-space', 500), START), false);
  assert.equal(game.packs.length, 0);
  assert.equal(game.pendingSpawns.length, 1);
  assert.equal(game.publicStatus().packCounts.queued, 1);
  assert.equal(game.addFundedPack(fixturePrize('wait-for-space', 500), START + 100), false);
  assert.equal(game.pendingSpawns.length, 1);
  const camper = game.players.values().next().value;
  camper.x = camper.base.x; camper.z = camper.base.z;
  game.tick(START + 5000);
  assert.equal(game.pendingSpawns.length, 0);
  assert.equal(game.packs.length, 1);
  assert.equal(game.packs[0].id, 'wait-for-space');
  for (const player of game.players.values()) assert.ok(Math.hypot(game.packs[0].x - player.x, game.packs[0].z - player.z) >= 28);
});

test('funded spawn queue and site history survive restart; blocked premium entries cannot starve later tiers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cards-spawn-queue-'));
  let store;
  try {
    store = new FileStore(directory);
    const game = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0, store });
    for (const site of HIDING_SPOTS) game.spawnHistory[site.id] = START;
    for (let index = 0; index < 20; index++) assert.equal(game.addFundedPack(fixturePrize(`premium-queued-${index}`, 500), START), false);
    assert.equal(game.addFundedPack(fixturePrize('common-queued'), START), false);
    const oldBase = { ...add(game, 'returning').base };
    store.close();
    store = new FileStore(directory);
    const restored = new Game({ now: START + 1000, colliders: WORLD_COLLIDERS, randomIndex: () => 0, store });
    assert.equal(restored.pendingSpawns.length, 21);
    assert.equal(restored.packs.length, 0);
    assert.deepEqual(restored.spawnHistory, game.spawnHistory);
    assert.deepEqual(add(restored, 'returning').base, oldBase);
    // Prior common sites become usable, while all top-tier sites remain cooling down.
    for (const site of restored.placement().spotsForTier(25)) delete restored.spawnHistory[site.id];
    restored.tick(START + 5000);
    assert.equal(restored.packs.length, 0);
    restored.tick(START + 10000);
    assert.equal(restored.packs.length, 1);
    assert.equal(restored.packs[0].id, 'common-queued');
    assert.equal(restored.pendingSpawns.length, 20);
    assert.equal(restored.addFundedPack(fixturePrize('common-queued'), START + 11000), false);
    store.close();
    store = new FileStore(directory);
    const recovered = new Game({ now: START + 12000, colliders: WORLD_COLLIDERS, store });
    assert.equal(recovered.packs.filter(pack => pack.id === 'common-queued').length, 1);
    assert.equal(recovered.pendingSpawns.length, 20);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup requeues unreachable hidden or formerly carried inventory while preserving valid saved locations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cards-hidden-recovery-'));
  let store;
  try {
    store = new FileStore(directory);
    const navigation = getWorldPlacement(WORLD_COLLIDERS);
    const validSite = navigation.spotsForTier(25)[0];
    const wall = WORLD_COLLIDERS.find(box => box.w > 5 && box.d > 5);
    const storedPack = (id, status, point) => {
      const { tierUsd, ...prize } = fixturePrize(id);
      return { ...prize, tier: tierUsd, x: point.x, z: point.z, status,
        carrierId: status === 'carried' ? 'offline-holder' : null, protectedUntil: START + 500 };
    };
    const valid = storedPack('valid-saved', 'hidden', validSite);
    const boundaryDrop = storedPack('boundary-drop', 'hidden', { x: 123.9, z: 0 });
    const carried = storedPack('carried-saved', 'carried', validSite);
    const blockedCarried = storedPack('blocked-carried-saved', 'carried', wall);
    const blocked = storedPack('blocked-saved', 'hidden', wall);
    store.save({ version: 1, accounts: {}, awards: [], packs: [blocked, valid, carried, boundaryDrop, blockedCarried] });
    const restored = new Game({ now: START, colliders: WORLD_COLLIDERS, randomIndex: () => 0, store });
    assert.equal(restored.pendingSpawns.length, 2);
    assert.equal(restored.pendingSpawns[0].id, blocked.id);
    assert.equal(restored.pendingSpawns[0].mint, blocked.mint);
    assert.equal(restored.pendingSpawns[0].purchaseSignature, blocked.purchaseSignature);
    assert.equal(restored.pendingSpawns[0].value, blocked.value);
    assert.equal(restored.pendingSpawns[0].recoveryReason, 'unreachable_saved_location');
    assert.deepEqual(restored.pendingSpawns[0].previousLocation, { x: wall.x, z: wall.z });
    assert.deepEqual(restored.packs.find(pack => pack.id === valid.id), valid);
    assert.deepEqual(restored.packs.find(pack => pack.id === boundaryDrop.id), boundaryDrop);
    assert.deepEqual(restored.packs.find(pack => pack.id === carried.id), { ...carried, status: 'hidden', carrierId: null, protectedUntil: 0 });
    assert.equal(restored.packs.some(pack => pack.id === blockedCarried.id), false);
    assert.equal(restored.pendingSpawns.find(prize => prize.id === blockedCarried.id).mint, blockedCarried.mint);
    assert.equal(restored.pendingSpawns.find(prize => prize.id === blockedCarried.id).purchaseSignature, blockedCarried.purchaseSignature);
    const durable = JSON.parse(readFileSync(store.path, 'utf8'));
    assert.equal(durable.pendingSpawns.length, 2);
    assert.equal(durable.packs.some(pack => pack.id === blocked.id), false);
    assert.equal(durable.packs.some(pack => pack.id === blockedCarried.id), false);
    assert.equal(restored.addFundedPack(fixturePrize(blocked.id), START + 1), true);
    assert.equal(restored.pendingSpawns.length, 1);
    assert.equal(restored.packs.filter(pack => pack.id === blocked.id).length, 1);
    assert.equal(restored.addFundedPack(fixturePrize(blocked.id), START + 2), false);
    assert.equal(navigation.reachable(restored.packs.find(pack => pack.id === blocked.id)), true);
    assert.equal(restored.packs.find(pack => pack.id === blocked.id).mint, blocked.mint);
    assert.equal(restored.addFundedPack(fixturePrize(blockedCarried.id), START + 2), true);
    assert.equal(restored.pendingSpawns.length, 0);
    assert.equal(restored.packs.filter(pack => pack.id === blockedCarried.id).length, 1);
    assert.equal(navigation.reachable(restored.packs.find(pack => pack.id === blockedCarried.id)), true);
    assert.equal(restored.addFundedPack(fixturePrize(blockedCarried.id), START + 3), false);
    assert.equal(restored.awards.length, 0);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('route distances agree with unobstructed walking and disconnected rooms are excluded', () => {
  const navigation = getWorldPlacement([]), point = { x: 0, z: 0 };
  const route = navigation.routeMetrics(point);
  for (const [index, base] of navigation.bases.entries()) {
    const dx = Math.abs(base.x), dz = Math.abs(base.z);
    assert.ok(Math.abs(route.lengths[index] - (Math.max(dx, dz) + .4 * Math.min(dx, dz))) < 1e-9);
  }
  const sealed = getWorldPlacement([
    { x: -5, z: 0, w: 1, d: 11 }, { x: 5, z: 0, w: 1, d: 11 },
    { x: 0, z: -5, w: 11, d: 1 }, { x: 0, z: 5, w: 11, d: 1 },
  ]);
  assert.equal(sealed.clear(0, 0), true);
  assert.equal(sealed.reachable(point), false);
  assert.equal(sealed.routeMetrics(point), null);
  assert.equal(sealed.spotsForTier(25).some(site => Math.abs(site.x) < 5 && Math.abs(site.z) < 5), false);
});
