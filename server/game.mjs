import { createHash, randomInt } from 'node:crypto';
import { collidesWithWorld } from '../shared/collision-index.mjs';
import { HOME_LAYOUT_VERSION } from '../shared/world-layout.mjs';
import { getWorldPlacement, SPAWN_POLICY, SPAWN_REUSE_MS, MAX_PLAYERS } from './world-placement.mjs';

export const GAME_RULES = Object.freeze({
  worldRadius: 124, walkSpeed: 10, sprintSpeed: 15, dashSpeed: 20,
  carrySpeedMultiplier: 0.8, playerRadius: 0.6, pickupRange: 3.8,
  stealRange: 3.5, deliveryRange: 4, stealCooldownMs: 6000,
  pickupProtectionMs: 2000, abilityDurationMs: 8000, abilityCooldownMs: 45000,
  jumpDurationMs: 800, jumpRecoveryMs: 120,
  eligibilityPercent: 0.25, eliteAbovePercent: 2, discoveryRadius: 13, radarRadius: 42,
});
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const CHARACTER_VARIANTS = ['scout', 'ranger', 'sage'];

/** Authoritative multiplayer state. Only purchased, custodied inventory enters
 * this world. No client may create packs, choose privilege, or award a prize. */
export class Game {
  constructor({ now = Date.now(), colliders = [], store = null, randomIndex = randomInt } = {}) {
    this.store = store;
    const persisted = store?.load() ?? { version: 1, packs: [], accounts: {}, awards: [] };
    this.packs = persisted.packs.map(pack => pack.status === 'carried' ? { ...pack, status: 'hidden', carrierId: null, protectedUntil: 0 } : pack);
    this.accounts = persisted.accounts;
    this.awards = persisted.awards;
    this.pendingSpawns = persisted.pendingSpawns ?? [];
    this.spawnHistory = persisted.spawnHistory ?? {};
    if (!Array.isArray(this.pendingSpawns) || !this.spawnHistory || typeof this.spawnHistory !== 'object') throw new Error('Invalid durable spawn queue.');
    this.randomIndex = randomIndex;
    this.nextSpawnCheckAt = now;
    this.spawnQueueCursor = 0;
    this.players = new Map();
    this.events = [];
    this.eventListeners = new Set();
    this.colliders = colliders;
    this.lastTick = now;
    this.roundEndsAt = now + 30 * 60_000;
    this.eventSequence = 0;
    this.treasury = { balance: 0, fees10m: 0, reserved: 0, nextDropAt: null, enabled: false, ready: false, blockers: ['Live pack funding has not been configured.'] };
    this.recoverUnreachableHiddenPacks(now);
    this.persist();
  }
  recoverUnreachableHiddenPacks(now) {
    // Restart drops carried packs at their saved position. Validate those drops
    // too: a geometry update may have placed a wall over the old carrier route.
    // Any reachable saved location remains unchanged.
    const hidden = this.packs.filter(pack => pack.status === 'hidden');
    if (!hidden.length) return;
    const navigation = this.placement();
    const blocked = hidden.filter(pack => {
      if (this.collides(pack.x, pack.z)) return true;
      if (navigation.reachable(pack)) return false;
      // A dropped pack may rest between grid cells or against the world edge.
      // Preserve it if the actual movement rules connect it to the main grid;
      // the conservative spawn clearance must not relocate a reachable drop.
      for (let z = Math.round(pack.z) - 3; z <= Math.round(pack.z) + 3; z++) {
        for (let x = Math.round(pack.x) - 3; x <= Math.round(pack.x) + 3; x++) {
          const point = { x, z };
          if (navigation.reachable(point) && this.clearLine(pack, point)) return false;
        }
      }
      return true;
    });
    for (const pack of blocked) {
      if (!pack.id || !pack.mint || !pack.purchaseSignature || !SPAWN_POLICY[pack.tier]) {
        throw new Error('An unreachable stored pack has incomplete custody information. Refusing to replace the prize ledger.');
      }
      if (!this.pendingSpawns.some(prize => prize.id === pack.id)) this.pendingSpawns.push({
        id: pack.id, mint: pack.mint, name: pack.name, image: pack.image,
        purchaseSignature: pack.purchaseSignature, tierUsd: pack.tier, value: pack.value,
        queuedAt: now, recoveryReason: 'unreachable_saved_location', previousLocation: { x: pack.x, z: pack.z },
      });
    }
    const blockedIds = new Set(blocked.map(pack => pack.id));
    this.packs = this.packs.filter(pack => !blockedIds.has(pack.id));
  }
  persist() {
    for (const player of this.players.values()) {
      const account = this.accounts[player.id];
      if (account) Object.assign(account, {
        stamina: player.stamina, ability: player.ability, abilityUntil: player.abilityUntil,
        abilityReadyAt: player.abilityReadyAt, stealReadyAt: player.stealReadyAt,
        jumpReadyAt: player.jumpReadyAt,
      });
    }
    this.store?.save({ version: 1, packs: this.packs, accounts: this.accounts, awards: this.awards,
      pendingSpawns: this.pendingSpawns, spawnHistory: this.spawnHistory });
  }
  subscribeEvents(listener) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  notifyListeners(event, details) {
    // Presentation listeners cannot undo an already committed game transition.
    for (const listener of this.eventListeners) { try { listener(event, details); } catch { /* Community can recover confirmed wins from durable collections. */ } }
  }
  addEvent(text, now = Date.now(), details = null) {
    const event = { id: `event-${++this.eventSequence}`, text, time: now };
    this.events.unshift(event);
    this.events.length = Math.min(this.events.length, 14);
    this.notifyListeners(event, details);
  }
  addFundedPack(prize, now = Date.now()) {
    if (!prize?.id || !prize.mint || !prize.purchaseSignature || ![25, 50, 100, 250, 500].includes(prize.tierUsd)) throw new Error('A purchased, custodied prize is required to create a world pack.');
    if (this.packs.some(pack => pack.id === prize.id)) return false;
    // The provider deliberately replays funded inventory. A crowded or camped
    // world durably queues it rather than stacking packs or dropping an award.
    if (!this.pendingSpawns.some(item => item.id === prize.id)) this.pendingSpawns.push({
      id: prize.id, mint: prize.mint, name: prize.name, image: prize.image,
      purchaseSignature: prize.purchaseSignature, tierUsd: prize.tierUsd,
      value: Number.isFinite(prize.value) ? prize.value : prize.tierUsd, queuedAt: now,
    });
    const queued = this.pendingSpawns.find(item => item.id === prize.id);
    const spawned = this.spawnPrize(queued, now);
    if (spawned) this.pendingSpawns = this.pendingSpawns.filter(item => item.id !== prize.id);
    this.persist();
    return spawned;
  }
  placement() { return getWorldPlacement(this.colliders); }
  shuffled(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) { const j = this.randomIndex(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  }
  spawnPrize(prize, now) {
    const policy = SPAWN_POLICY[prize.tierUsd];
    const occupied = this.packs.filter(pack => pack.status !== 'secured');
    const candidates = this.shuffled(this.placement().spotsForTier(prize.tierUsd));
    const position = candidates.find(spot => {
      if (this.spawnHistory[spot.id] !== undefined && now - this.spawnHistory[spot.id] < SPAWN_REUSE_MS) return false;
      if (occupied.some(pack => distance(spot, pack) < Math.max(policy.spacing, SPAWN_POLICY[pack.tier]?.spacing ?? 10))) return false;
      if ([...this.players.values()].some(player => distance(spot, player) < (prize.tierUsd >= 250 ? 28 : 18))) return false;
      return true;
    });
    if (!position) return false;
    const { x, z, kind: difficulty } = position;
    this.packs.push({
      id: prize.id, mint: prize.mint, name: prize.name, image: prize.image,
      purchaseSignature: prize.purchaseSignature, tier: prize.tierUsd,
      value: Number.isFinite(prize.value) ? prize.value : prize.tierUsd,
      x, z, difficulty, spawnSite: position.id, status: 'hidden', carrierId: null, protectedUntil: 0,
    });
    this.spawnHistory[position.id] = now;
    this.addEvent(`A funded $${prize.tierUsd} pack has been hidden in the world.`, now, { kind: 'spawned', tier: prize.tierUsd, prizeId: prize.id });
    return true;
  }
  retryPendingSpawns(now) {
    if (!this.pendingSpawns.length) return;
    let changed = false;
    const start = this.spawnQueueCursor % this.pendingSpawns.length;
    const batch = Array.from({ length: Math.min(16, this.pendingSpawns.length) }, (_, index) =>
      this.pendingSpawns[(start + index) % this.pendingSpawns.length]);
    this.spawnQueueCursor = (start + batch.length) % this.pendingSpawns.length;
    // Rotate through blocked tiers too: a full premium chamber must not prevent
    // a later common prize from ever receiving an otherwise available site.
    for (const prize of batch) {
      if (!this.spawnPrize(prize, now)) continue;
      this.pendingSpawns = this.pendingSpawns.filter(item => item.id !== prize.id);
      changed = true;
    }
    if (changed) this.persist();
  }
  addPlayer(id, name = 'HUNTER', now = Date.now(), identity) {
    if (!identity?.eligible || identity.wallet !== id) throw new Error('Verified eligible wallet required.');
    if (this.players.has(id)) return this.players.get(id);
    if (this.players.size >= MAX_PLAYERS) throw new Error('This world is full. Please try again shortly.');
    if (!this.accounts[id]) this.accounts[id] = { score: 0, collection: [], base: this.allocateBase(), baseLayoutVersion: HOME_LAYOUT_VERSION };
    const account = this.accounts[id];
    if (!CHARACTER_VARIANTS.includes(account.character)) account.character = CHARACTER_VARIANTS[createHash('sha256').update(id).digest()[0] % CHARACTER_VARIANTS.length];
    // Existing connected hunters (including carriers) returned above. Only an
    // offline account may migrate from the old perimeter layout at re-entry.
    const currentPad = this.placement().bases.some(pad => pad.x === account.base?.x && pad.z === account.base?.z);
    if (account.baseLayoutVersion !== HOME_LAYOUT_VERSION || !currentPad || [...this.players.values()].some(player => distance(player.base, account.base) < 10)) {
      account.base = this.allocateBase(); account.baseLayoutVersion = HOME_LAYOUT_VERSION;
    }
    const player = {
      // Join names are untrusted JSON. String(object) can call attacker-supplied
      // toString/valueOf properties and throw out of the websocket handler.
      id, name: (typeof name === 'string' ? name : '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18) || 'HUNTER',
      x: account.base.x, z: account.base.z, yaw: 0, carrying: null, base: account.base,
      score: account.score, elite: identity.elite, bot: false, character: account.character,
      stamina: clamp(account.stamina ?? 100, 0, 100), sprinting: false,
      ability: identity.elite && account.abilityUntil > now ? account.ability : null,
      abilityUntil: account.abilityUntil ?? 0, abilityReadyAt: account.abilityReadyAt ?? 0,
      lastMoveAt: now, lastMovementAt: 0, lastSprintAt: 0, stealReadyAt: account.stealReadyAt ?? 0,
      jumpStartedAt: 0, jumpUntil: 0, jumpReadyAt: account.jumpReadyAt ?? 0,
      collection: account.collection, holdPercent: identity.holdPercent,
    };
    if (player.name.toLowerCase() === 'looter') player.name = 'HUNTER';
    account.name = player.name;
    this.players.set(id, player);
    this.persist();
    this.notifyListeners(null, { kind: 'profile' });
    return player;
  }
  setCharacter(id, variant) {
    const player = this.players.get(id);
    if (!player || !CHARACTER_VARIANTS.includes(variant)) return false;
    player.character = variant;
    this.accounts[id].character = variant;
    this.persist();
    this.notifyListeners(null, { kind: 'profile' });
    return true;
  }
  allocateBase() {
    const candidates = this.placement().bases.filter(point => ![...this.players.values()].some(player => distance(point, player.base) < 10));
    if (!candidates.length) throw new Error('No safe home bases are available in this world.');
    const point = candidates[this.randomIndex(candidates.length)];
    return { x: point.x, z: point.z };
  }
  updateIdentity(id, identity) {
    const player = this.players.get(id);
    if (!player) return;
    player.elite = identity.elite;
    player.holdPercent = identity.holdPercent;
    if (!player.elite) { player.ability = null; player.abilityUntil = 0; }
    this.persist();
  }
  removePlayer(id, now = Date.now()) {
    const player = this.players.get(id);
    if (!player) return;
    if (player.carrying) {
      const pack = this.packs.find(item => item.id === player.carrying);
      if (pack) Object.assign(pack, { x: player.x, z: player.z, status: 'hidden', carrierId: null, protectedUntil: 0 });
      this.addEvent(`${player.name} disconnected and dropped their pack.`, now);
    }
    this.persist();
    this.players.delete(id);
    this.notifyListeners(null, { kind: 'profile' });
  }
  collides(x, z, radius = GAME_RULES.playerRadius) {
    if (Math.abs(x) > GAME_RULES.worldRadius || Math.abs(z) > GAME_RULES.worldRadius) return true;
    return collidesWithWorld(this.colliders, x, z, radius);
  }
  clearLine(from, to) {
    const steps = Math.max(1, Math.ceil(distance(from, to) / 0.5));
    for (let step = 1; step <= steps; step++) {
      const factor = step / steps;
      if (this.collides(from.x + (to.x - from.x) * factor, from.z + (to.z - from.z) * factor)) return false;
    }
    return true;
  }
  move(id, message, now = Date.now()) {
    const player = this.players.get(id);
    if (!player || !Number.isFinite(message.x) || !Number.isFinite(message.z) || !Number.isFinite(message.yaw)) return false;
    const elapsed = clamp((now - player.lastMoveAt) / 1000, 0, 0.25);
    player.lastMoveAt = Math.max(player.lastMoveAt, now);
    player.yaw = ((message.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    player.sprinting = Boolean(message.sprinting) && player.stamina > 3;
    const dashing = player.ability === 'dash' && player.abilityUntil > now;
    let speed = dashing ? GAME_RULES.dashSpeed : player.sprinting ? GAME_RULES.sprintSpeed : GAME_RULES.walkSpeed;
    if (player.carrying) speed *= GAME_RULES.carrySpeedMultiplier;
    const dx = message.x - player.x;
    const dz = message.z - player.z;
    const travel = Math.hypot(dx, dz);
    if (travel < 0.001 || elapsed <= 0) return true;
    const scale = Math.min(1, speed * elapsed / travel);
    const destination = { x: player.x + dx * scale, z: player.z + dz * scale };
    if (this.clearLine(player, destination)) { player.x = destination.x; player.z = destination.z; }
    else {
      const slideX = { x: destination.x, z: player.z };
      const slideZ = { x: player.x, z: destination.z };
      if (this.clearLine(player, slideX)) player.x = slideX.x;
      else if (this.clearLine(player, slideZ)) player.z = slideZ.z;
      else return false;
    }
    player.lastMovementAt = now;
    if (player.sprinting && !dashing) {
      player.stamina = clamp(player.stamina - 25 * Math.min(travel, speed * elapsed) / speed, 0, 100);
      player.lastSprintAt = now;
    }
    this.followCarriedPack(player);
    this.deliver(player, now);
    return true;
  }
  followCarriedPack(player) {
    const pack = this.packs.find(item => item.id === player.carrying);
    if (pack) { pack.x = player.x; pack.z = player.z; }
  }
  jump(id, now = Date.now()) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: 'Deploy into the world first.' };
    if (player.jumpUntil > now) return { ok: false, reason: 'Land before jumping again.' };
    if (player.jumpReadyAt > now) return { ok: false, reason: 'Your next jump is not ready yet.' };
    // Jump height is visual. Horizontal collision, movement speed, pickup,
    // theft, and delivery remain governed by their existing authority checks.
    player.jumpStartedAt = now;
    player.jumpUntil = now + GAME_RULES.jumpDurationMs;
    player.jumpReadyAt = player.jumpUntil + GAME_RULES.jumpRecoveryMs;
    this.persist();
    return { ok: true, action: 'jump', jumpStartedAt: player.jumpStartedAt, jumpUntil: player.jumpUntil, jumpReadyAt: player.jumpReadyAt };
  }
  interact(id, now = Date.now()) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: 'Deploy into the world first.' };
    if (player.carrying) {
      if (this.deliver(player, now)) return { ok: true, action: 'delivered' };
      return { ok: false, reason: 'Bring your pack to your home beacon to secure it.' };
    }
    const nearby = this.packs.filter(pack => pack.status === 'hidden' && distance(player, pack) <= GAME_RULES.pickupRange && this.clearLine(player, pack))
      .sort((a, b) => distance(player, a) - distance(player, b));
    if (nearby.length) {
      const pack = nearby[0];
      player.carrying = pack.id;
      Object.assign(pack, { status: 'carried', carrierId: id, protectedUntil: now + GAME_RULES.pickupProtectionMs });
      this.followCarriedPack(player);
      this.persist();
      this.addEvent(`${player.name} found a $${pack.tier} pack. Intercept before extraction!`, now, { kind: 'pickup', wallet: id, name: player.name, tier: pack.tier });
      return { ok: true, action: 'picked_up', packId: pack.id };
    }
    const carrier = [...this.players.values()].filter(other => other.id !== id && other.carrying && distance(player, other) <= GAME_RULES.stealRange && this.clearLine(player, other))
      .sort((a, b) => distance(player, a) - distance(player, b))[0];
    if (!carrier) return { ok: false, reason: 'No pack or carrying rival in reach. Move closer and right-click.' };
    if (player.stealReadyAt > now) return { ok: false, reason: 'Your steal is recharging.' };
    const pack = this.packs.find(item => item.id === carrier.carrying);
    if (!pack || pack.protectedUntil > now) return { ok: false, reason: 'That pack has brief pickup protection.' };
    carrier.carrying = null;
    player.carrying = pack.id;
    player.stealReadyAt = now + GAME_RULES.stealCooldownMs;
    Object.assign(pack, { carrierId: id, protectedUntil: now + GAME_RULES.pickupProtectionMs });
    this.followCarriedPack(player);
    this.persist();
    this.addEvent(`${player.name} stole the $${pack.tier} pack from ${carrier.name}!`, now, { kind: 'stolen', wallet: id, name: player.name, tier: pack.tier });
    return { ok: true, action: 'stolen', packId: pack.id };
  }
  deliver(player, now = Date.now()) {
    if (!player.carrying || distance(player, player.base) > GAME_RULES.deliveryRange) return false;
    const pack = this.packs.find(item => item.id === player.carrying);
    if (!pack || pack.status !== 'carried' || pack.carrierId !== player.id) return false;
    Object.assign(pack, { status: 'secured', carrierId: null, x: player.base.x, z: player.base.z, securedBy: player.id });
    player.carrying = null;
    player.score += pack.value;
    const reward = { id: pack.id, mint: pack.mint, name: pack.name, image: pack.image, tier: pack.tier, value: pack.value, securedAt: now, status: 'pending_transfer' };
    player.collection.push(reward);
    this.accounts[player.id].score = player.score;
    this.awards.push({ id: pack.id, mint: pack.mint, wallet: player.id, status: 'pending', securedAt: now });
    this.persist(); // Durable outbox first; token transfer happens asynchronously.
    this.addEvent(`${player.name} extracted a $${pack.tier} pack. Wallet delivery is being processed.`, now, { kind: 'deposit', wallet: player.id, name: player.name, tier: pack.tier });
    return true;
  }
  pendingAwards(now = Date.now()) { return this.awards.filter(award => award.status === 'pending' && (!award.nextAttemptAt || award.nextAttemptAt <= now)).map(award => ({ ...award })); }
  markAward(id, result, now = Date.now()) {
    const award = this.awards.find(item => item.id === id);
    if (!award || award.status === 'confirmed' || !result) return false;
    const reward = this.accounts[award.wallet]?.collection.find(item => item.id === id);
    if (result.status === 'confirmed' && result.signature) {
      Object.assign(award, { status: 'confirmed', signature: result.signature, confirmedAt: now, nextAttemptAt: null, reason: null });
      if (reward) Object.assign(reward, { status: 'transferred', signature: result.signature, confirmedAt: now, nextAttemptAt: null, reason: null });
      this.persist();
      this.addEvent('A collected prize transfer was confirmed.', now, { kind: 'win', wallet: award.wallet, awardId: id });
      return true;
    }
    if (!['pending', 'quarantined'].includes(result.status)) return false;
    // Only server-owned recovery diagnostics are copied; the recipient and NFT
    // recorded at extraction remain immutable across retries and restarts.
    const diagnostics = {
      reason: typeof result.reason === 'string' ? result.reason.slice(0, 240) : 'Delivery is waiting for reconciliation.',
      code: typeof result.code === 'string' ? result.code.slice(0, 64) : 'provider_unavailable',
      attempts: Number.isSafeInteger(result.attempts) ? result.attempts : award.attempts ?? 0,
      lastAttemptAt: Number.isSafeInteger(result.lastAttemptAt) ? result.lastAttemptAt : award.lastAttemptAt ?? null,
      nextAttemptAt: Number.isSafeInteger(result.nextAttemptAt) ? result.nextAttemptAt : null,
      history: Array.isArray(result.history) ? result.history.slice(-12) : award.history ?? [],
    };
    Object.assign(award, diagnostics, { status: result.status });
    if (reward) Object.assign(reward, diagnostics, { status: result.status === 'quarantined' ? 'delivery_quarantined' : 'pending_transfer' });
    this.persist();
    return false;
  }
  useAbility(id, ability, now = Date.now()) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: 'Deploy into the world first.' };
    if (!player.elite) return { ok: false, reason: 'Special tools require a verified holding above 2%.' };
    if (!['radar', 'dash'].includes(ability)) return { ok: false, reason: 'Unknown tool.' };
    if (player.abilityReadyAt > now) return { ok: false, reason: 'Your special tools are recharging.' };
    Object.assign(player, { ability, abilityUntil: now + GAME_RULES.abilityDurationMs, abilityReadyAt: now + GAME_RULES.abilityCooldownMs });
    this.persist();
    return { ok: true, action: 'ability', ability, until: player.abilityUntil };
  }
  tick(now = Date.now()) {
    const elapsed = clamp((now - this.lastTick) / 1000, 0, 0.25);
    this.lastTick = now;
    if (this.pendingSpawns.length && now >= this.nextSpawnCheckAt) {
      this.nextSpawnCheckAt = now + 5000;
      this.retryPendingSpawns(now);
    }
    for (const player of this.players.values()) {
      if (player.abilityUntil <= now) player.ability = null;
      if (now - player.lastSprintAt > 250) player.stamina = clamp(player.stamina + elapsed * 15, 0, 100);
    }
    if (now >= this.roundEndsAt) this.roundEndsAt = now + 30 * 60_000;
  }
  publicStatus() {
    const active = this.packs.filter(pack => pack.status !== 'secured');
    return {
      mode: 'live', online: this.players.size, treasury: { ...this.treasury },
      packCounts: { total: active.length, queued: this.pendingSpawns.length, hidden: active.filter(pack => pack.status === 'hidden').length, carried: active.filter(pack => pack.status === 'carried').length, tiers: Object.fromEntries([25, 50, 100, 250, 500].map(tier => [tier, active.filter(pack => pack.tier === tier).length])) },
    };
  }
  state(viewerId, now = Date.now()) {
    const viewer = this.players.get(viewerId);
    const radar = viewer?.ability === 'radar' && viewer.abilityUntil > now;
    const radius = radar ? GAME_RULES.radarRadius : GAME_RULES.discoveryRadius;
    return {
      ...this.publicStatus(), serverTime: now, roundEndsAt: this.roundEndsAt, rules: GAME_RULES,
      players: viewer ? [...this.players.values()].map(player => ({
        id: player.id, name: player.name, x: player.x, z: player.z, yaw: player.yaw,
        carrying: player.carrying, base: player.base, score: player.score, elite: player.elite,
        bot: false, character: player.character, stamina: Math.round(player.stamina), ability: player.ability,
        abilityUntil: player.abilityUntil, abilityReadyAt: player.abilityReadyAt,
        stealReadyAt: player.stealReadyAt, holdPercent: player.holdPercent,
        jumpStartedAt: player.jumpStartedAt, jumpUntil: player.jumpUntil, jumpReadyAt: player.jumpReadyAt,
        collection: player.id === viewerId ? player.collection : [],
      })) : [],
      packs: viewer ? this.packs.filter(pack => pack.status === 'carried' || pack.status === 'hidden' && distance(viewer, pack) <= radius && (radar || this.clearLine(viewer, pack)))
        .map(({ protectedUntil, purchaseSignature, securedBy, mint, name, image, ...pack }) => pack) : [],
      events: this.events,
    };
  }
}
