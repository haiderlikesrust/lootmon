import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { mapGrid } from '../shared/map-grid.mjs';

export const COMMUNITY_LIMITS = Object.freeze({ chat: 120, activity: 20, text: 240, cooldownMs: 3000,
  messagesPerMinute: 8, duplicateMs: 30_000, leaderboard: 100 });
const CHARACTERS = new Set(['scout', 'ranger', 'sage']);
const clean = value => typeof value === 'string' ? value.normalize('NFKC')
  .replace(/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/gu, ' ').trim() : '';
const nameFor = (account, wallet) => {
  const name = clean(account?.name).slice(0, 18);
  return name && name.toLowerCase() !== 'looter' ? name : `Hunter ${wallet.slice(0, 4)}`;
};
const signatureFor = reward => {
  const signature = reward?.signature;
  if (typeof signature !== 'string' || signature.length < 64 || signature.length > 88 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(signature)) return '';
  try { return bs58.decode(signature).length === 64 ? signature : ''; } catch { return ''; }
};
const isConfirmed = reward => reward?.status === 'transferred' && Boolean(signatureFor(reward));
const validReward = reward => reward && typeof reward.id === 'string' && reward.id.length > 0 && reward.id.length <= 128;
const recordedTime = reward => [reward.confirmedAt, reward.securedAt].find(value => Number.isSafeInteger(value) && value >= 0) ?? 0;
const rewardValue = reward => Number.isFinite(reward.value) && reward.value >= 0 ? reward.value : 0;

/** Public aggregate only: never include mint, image, card name, positions,
 * purchase signatures, delivery diagnostics, or a private collection array. */
export function buildLeaderboard(game, now = Date.now()) {
  const entries = [], seenRewards = new Set();
  for (const [wallet, account] of Object.entries(game.accounts).sort(([a], [b]) => a.localeCompare(b))) {
    const collection = (Array.isArray(account.collection) ? account.collection : []).filter(reward => {
      if (!validReward(reward) || seenRewards.has(reward.id)) return false;
      seenRewards.add(reward.id); return true;
    });
    if (!collection.length) continue;
    const confirmed = collection.filter(isConfirmed);
    entries.push({ wallet, name: nameFor(game.players.get(wallet) ?? account, wallet),
      character: CHARACTERS.has(account.character) ? account.character : 'scout',
      wins: confirmed.length, totalValue: confirmed.reduce((sum, reward) => sum + rewardValue(reward), 0),
      secured: collection.length, pending: collection.length - confirmed.length, online: game.players.has(wallet) });
  }
  entries.sort((a, b) => b.wins - a.wins || b.totalValue - a.totalValue || a.wallet.localeCompare(b.wallet));
  return { updatedAt: now, totalCollectors: entries.length,
    entries: entries.slice(0, COMMUNITY_LIMITS.leaderboard).map((entry, index) => ({ rank: index + 1, ...entry })) };
}

/** Persisted conversation and confirmed-win history. All author identity and
 * notification kinds originate here or from committed authority events. */
export class Community {
  constructor(game, { onChange = () => {}, history = null } = {}) {
    this.game = game; this.onChange = onChange;
    this.chat = []; this.activity = []; this.rates = new Map();
    this.announcedWins = new Set();
    this.announcedPacks = new Set();
    const valid = item => item && typeof item.id === 'string' && typeof item.name === 'string' && Number.isSafeInteger(item.time) && item.time >= 0;
    this.chat = (history?.chat ?? []).filter(item => valid(item) && ['bot','player'].includes(item.kind) && typeof item.text === 'string' && !item.id.startsWith('win:')).slice(-COMMUNITY_LIMITS.chat);
    this.activity = (history?.activity ?? []).filter(item => valid(item) && ['pickup','stolen','deposit','opening','opened','spawned'].includes(item.kind)).slice(0, COMMUNITY_LIMITS.activity);
    for (const item of [...this.chat, ...this.activity]) if (item.id.startsWith('pack:')) this.announcedPacks.add(item.id);
    this.runId = randomUUID(); this.sequence = 0;
    this.leaderboardCache = buildLeaderboard(game);
    this.leaderboardDirty = false;
    const confirmed = [], seen = new Set();
    for (const [wallet, account] of Object.entries(game.accounts).sort(([a], [b]) => a.localeCompare(b))) {
      for (const reward of account.collection ?? []) {
        if (!validReward(reward) || !isConfirmed(reward) || seen.has(reward.id)) continue;
        seen.add(reward.id); confirmed.push({ wallet, reward });
      }
    }
    confirmed.sort((a, b) => recordedTime(a.reward) - recordedTime(b.reward) || a.reward.id.localeCompare(b.reward.id));
    const restoredChat = this.chat, restoredActivity = this.activity;
    this.chat = []; this.activity = [];
    for (const { wallet, reward } of confirmed.slice(-COMMUNITY_LIMITS.chat)) this.recordWin(wallet, reward, false);
    this.chat.push(...restoredChat); this.activity.push(...restoredActivity);
    this.chat.sort((a,b) => a.time - b.time); this.chat = this.chat.slice(-COMMUNITY_LIMITS.chat);
    this.activity.sort((a,b) => b.time - a.time); this.activity = this.activity.slice(0, COMMUNITY_LIMITS.activity);
    // Dedup identity follows durable awards, not the short visible history.
    for (const { reward } of confirmed) this.announcedWins.add(`win:${reward.id}`);
    this.unsubscribe = game.subscribeEvents((event, details) => this.gameEvent(event, details));
  }
  snapshot() { return { chat: this.chat.map(item => ({ ...item })), activity: this.activity.map(item => ({ ...item })) }; }
  leaderboard(now = Date.now()) {
    if (this.leaderboardDirty) { this.leaderboardCache = buildLeaderboard(this.game, now); this.leaderboardDirty = false; }
    return { ...this.leaderboardCache, entries: this.leaderboardCache.entries.map(entry => ({ ...entry })) };
  }
  changed() { this.onChange(this.snapshot()); }
  appendChat(message) { this.chat.push(message); if (this.chat.length > COMMUNITY_LIMITS.chat) this.chat.shift(); }
  appendActivity(event) { this.activity.unshift(event); if (this.activity.length > COMMUNITY_LIMITS.activity) this.activity.pop(); }
  gameEvent(event, details) {
    if (!details) return;
    if (['profile', 'deposit', 'win'].includes(details.kind)) this.leaderboardDirty = true;
    if (details.kind === 'profile') return;
    if (details.kind === 'spawned') {
      this.packEvent({ kind: 'spawned', id: details.prizeId, tier: details.tier }, event.time);
      return;
    }
    if (details.kind === 'win') {
      const reward = this.game.accounts[details.wallet]?.collection?.find(item => item.id === details.awardId);
      if (validReward(reward) && isConfirmed(reward)) this.recordWin(details.wallet, reward);
      return;
    }
    if (!['pickup', 'stolen', 'deposit'].includes(details.kind) || ![25, 50, 100, 250, 500].includes(details.tier)) return;
    this.appendActivity({ id: `${this.runId}:${event.id}`, kind: details.kind,
      name: nameFor({ name: details.name }, details.wallet ?? ''), tier: details.tier, time: event.time });
    this.changed();
  }
  recordWin(wallet, reward, broadcast = true) {
    const id = `win:${reward.id}`;
    if (this.announcedWins.has(id)) return;
    this.announcedWins.add(id);
    const name = nameFor(this.game.accounts[wallet], wallet), signature = signatureFor(reward), time = recordedTime(reward);
    const tier = [25, 50, 100, 250, 500].includes(reward.tier) ? reward.tier : 0;
    this.appendChat({ id, kind: 'bot', name: 'Looter', text: `${name} won ${tier ? `a $${tier} pack` : 'a collectible'}. Wallet transfer confirmed. TX: ${signature}`, time, signature });
    this.appendActivity({ id, kind: 'win', name, tier, time, signature });
    if (broadcast) this.changed();
  }
  packEvent(event, time = Date.now()) {
    if (!['opening', 'opened', 'spawned'].includes(event.kind) || typeof event.id !== 'string' || ![25,50,100,250,500].includes(event.tier)) return;
    const id = `pack:${event.kind}:${event.id}`;
    if (this.announcedPacks.has(id)) return;
    this.announcedPacks.add(id);
    if (this.announcedPacks.size > 1000) this.announcedPacks.delete(this.announcedPacks.values().next().value);
    const insuredValue = typeof event.insuredValue === 'number' && Number.isFinite(event.insuredValue) && event.insuredValue >= 0 ? event.insuredValue : null;
    const card = clean(event.name).slice(0, 100) || 'Collectible';
    const value = insuredValue === null ? 'insured value unavailable' : `insured value $${insuredValue.toFixed(2)}`;
    const text = event.kind === 'opening' ? `Opening a $${event.tier} pack…` : event.kind === 'spawned'
      ? `A $${event.tier} pack is now hidden on the island! Search inside houses and along the trails. Discovered packs glow and appear on your map.`
      : `Opened a $${event.tier} pack: ${card} — ${value} (provider-reported). Custody verified; preparing the island drop.`;
    this.appendChat({ id, kind: 'bot', name: 'Looter', text, time });
    this.appendActivity({ id, kind: event.kind, name: 'Looter', tier: event.tier, time, text, insuredValue });
    this.changed();
  }
  submit(wallet, raw, now = Date.now()) {
    const player = this.game.players.get(wallet);
    if (!player) return { ok: false, reason: 'Join the hunt with your verified wallet before chatting.' };
    if (typeof raw !== 'string' || raw.length > COMMUNITY_LIMITS.text)
      return { ok: false, reason: 'Messages must be text with no more than 240 characters.' };
    const text = clean(raw);
    if (!text || text.length > COMMUNITY_LIMITS.text) return { ok: false, reason: 'Write a message between 1 and 240 characters.' };
    for (const [id, rate] of this.rates) if (now - rate.lastAt >= 60_000) this.rates.delete(id);
    const rate = this.rates.get(wallet) ?? { lastAt: -Infinity, recent: [] };
    if (now - rate.lastAt < COMMUNITY_LIMITS.cooldownMs) return { ok: false, reason: 'Wait 3 seconds between messages.' };
    rate.recent = rate.recent.filter(message => now - message.at < 60_000);
    if (rate.recent.length >= COMMUNITY_LIMITS.messagesPerMinute) return { ok: false, reason: 'Chat limit reached. Try again in a minute.' };
    if (rate.recent.some(message => message.text === text.toLowerCase() && now - message.at < COMMUNITY_LIMITS.duplicateMs))
      return { ok: false, reason: 'You already sent that message. Give the conversation a moment.' };
    rate.lastAt = now; rate.recent.push({ at: now, text: text.toLowerCase() }); this.rates.set(wallet, rate);
    this.appendChat({ id: `chat:${this.runId}:${++this.sequence}`, kind: 'player', wallet,
      name: nameFor(player, wallet), character: CHARACTERS.has(player.character) ? player.character : 'scout', text, time: now });
    if (text.startsWith('/')) this.appendChat({ id: `bot:${this.runId}:${++this.sequence}`, kind: 'bot', name: 'Looter', text: this.command(text), time: now });
    this.changed();
    return { ok: true };
  }
  command(text) {
    const command = text.trim().toLowerCase();
    if (command === '/help') return 'Commands: /hint — map-square clues for $25/$50 packs; /rules — how to play; /base — secure your pack; /drops — funded packs; /leaderboard — confirmed winners.';
    if (command === '/hint') {
      // Fixed grid clues are public to every hunter. Never use distance/bearing,
      // which would let repeated queries triangulate an undiscovered location.
      const clues = [...new Set(this.game.packs.filter(pack => pack.status === 'hidden' && [25,50].includes(pack.tier) && mapGrid(pack.x, pack.z))
        .map(pack => `$${pack.tier}: ${mapGrid(pack.x, pack.z)} — ${pack.difficulty === 'interior' ? 'inside a house; go through the doorway' : 'outdoors; search the trees and trail edges'}`))].sort();
      return clues.length ? `Hunt clues: ${clues.join(' · ')}. Your map shows YOUR current square. Get close for the gold marker, then right-click to grab. Clues are shared with everyone.`
        : 'No hidden $25/$50 packs to hint at right now. A pack may be carried or waiting to spawn; check /drops. Higher tiers keep their locations secret.';
    }
    if (command === '/rules') return 'Hold at least 0.25% to hunt. Right-click nearby packs or carriers. Bring a pack to your base to secure it. Above 2% unlocks tools for 8 seconds, with a 45-second cooldown. A win is confirmed only after wallet transfer.';
    if (command === '/base') return 'Your assigned home beacon is marked YOUR BASE on the map. Carry a pack within 4 metres to deposit it. Deposit reserves your prize; wallet transfer confirmation makes it a win.';
    if (command === '/drops') {
      const counts = this.game.publicStatus().packCounts;
      return `${counts.hidden} funded packs hidden, ${counts.carried} being carried, ${counts.queued ?? 0} waiting for a safe hiding place. Locations stay secret. New drops depend on verified treasury funding.`;
    }
    if (command === '/leaderboard') {
      const top = this.leaderboard().entries.filter(entry => entry.wins > 0).slice(0, 3);
      return top.length ? `Confirmed winners: ${top.map((entry, index) => `${index + 1}. ${entry.name} (${entry.wins} ${entry.wins === 1 ? 'win' : 'wins'})`).join(' · ')}. Open Leaderboard for the full standings.`
        : 'No confirmed wins yet. Deposits appear as pending until the prize transfer is confirmed.';
    }
    return 'I can help with /hint, /help, /rules, /base, /drops and /leaderboard. I never request a seed phrase or a payment in chat.';
  }
  close() { this.unsubscribe(); }
}
