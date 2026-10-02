/**
 * Deterministic, side-effect-free allocation policy. This module never values,
 * purchases, swaps, signs, or transfers an asset. Inputs are a caller's snapshot.
 */
export const PACK_TIERS = Object.freeze([25, 50, 100, 250, 500]);

export const TREASURY_POLICY = Object.freeze({
  reserveUsd: 500,
  liquidityAllocationBps: 1500,
  feeAllocationBps: 7000,
  maxCycleUsd: 1000,
  dailyRemainingUsd: 1500,
  maxPacks: 8,
  fastCadenceHourlyFeesUsd: 300,
  fastCadenceLiquidUsd: 500,
});

const MINUTE_MS = 60_000;
const DIFFICULTY = { 25: 'courtyard', 50: 'interior', 100: 'rooftop', 250: 'vault', 500: 'summit' };
const PREMIUM_POLICY = {
  250: { liquidUsd: 2000, hourlyFeesUsd: 300, cooldownMs: 2 * 60 * MINUTE_MS },
  500: { liquidUsd: 5000, hourlyFeesUsd: 1200, cooldownMs: 6 * 60 * MINUTE_MS },
};

function nonnegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite nonnegative number`);
  }
  return value;
}

function moneyCents(value, name, roundUp = false) {
  nonnegative(value, name);
  // Drop sub-cent assets; round obligations up. Integer cents prevent a plan
  // spending funds that only exist because of floating-point rounding.
  const amount = roundUp ? Math.ceil(value * 100) : Math.floor(value * 100);
  if (!Number.isSafeInteger(amount) || amount > 1_000_000_000_000) {
    throw new RangeError(`${name} exceeds the supported monetary range`);
  }
  return amount;
}

function timestamp(value, name, nowMs) {
  nonnegative(value, name);
  if (!Number.isSafeInteger(value) || value > nowMs) {
    throw new RangeError(`${name} must be an integer timestamp no later than nowMs`);
  }
  return value;
}

/**
 * @param {object} input
 * @param {number} input.treasuryUsd Confirmed liquid funds, conservatively valued.
 * @param {number} input.recentFeesUsd Realized net fees in feeWindowMinutes.
 * @param {number} input.nowMs Explicit Unix time, making every plan reproducible.
 * @param {number} [input.obligationsUsd=0] Existing purchases and prize commitments.
 * @param {number} [input.reserveUsd=500] Protected funds in addition to obligations.
 * @param {number} [input.feeWindowMinutes=60] Width of the observed fee-flow window.
 * @param {number} [input.accruedFeesUsd] Unallocated fee proceeds; defaults to recent fees.
 * @param {'auto'|10|60} [input.cadenceMinutes='auto'] Fast or hourly drops.
 * @param {number|null} [input.lastDropAtMs=null] Last committed drop, not last poll.
 * @param {Record<string,number>} [input.lastHighTierAtMs={}] Last committed $250/$500 drops.
 * @param {number} [input.dailyRemainingUsd=1500] Actual remaining daily limit.
 * @param {number} [input.maxCycleUsd=1000] Absolute per-cycle limit.
 * @param {number} [input.maxPacks=8] Maximum number of new packs.
 * @param {number[]} [input.availableTiers] Provider-confirmed available tiers.
 * @returns {{eligible:boolean,reason:string,budgetUsd:number,spendUsd:number,packs:Array<{tierUsd:number,quantity:number,difficulty:string}>,cadenceMinutes:number,nextDropAtMs:number,metrics:object}}
 */
export function planDrop(input) {
  if (!input || typeof input !== 'object') throw new TypeError('A treasury snapshot is required');
  const {
    treasuryUsd, recentFeesUsd, nowMs,
    obligationsUsd = 0,
    reserveUsd = TREASURY_POLICY.reserveUsd,
    feeWindowMinutes = 60,
    accruedFeesUsd = recentFeesUsd,
    cadenceMinutes: requestedCadence = 'auto',
    lastDropAtMs = null,
    lastHighTierAtMs = {},
    dailyRemainingUsd = TREASURY_POLICY.dailyRemainingUsd,
    maxCycleUsd = TREASURY_POLICY.maxCycleUsd,
    maxPacks = TREASURY_POLICY.maxPacks,
    availableTiers = PACK_TIERS,
  } = input;

  timestamp(nowMs, 'nowMs', Number.MAX_SAFE_INTEGER);
  if (lastDropAtMs !== null) timestamp(lastDropAtMs, 'lastDropAtMs', nowMs);
  if (!lastHighTierAtMs || typeof lastHighTierAtMs !== 'object' || Array.isArray(lastHighTierAtMs)) {
    throw new TypeError('lastHighTierAtMs must be a map of tier to timestamp');
  }
  for (const tier of [250, 500]) {
    if (lastHighTierAtMs[tier] !== undefined) timestamp(lastHighTierAtMs[tier], `lastHighTierAtMs.${tier}`, nowMs);
  }
  if (!['auto', 10, 60].includes(requestedCadence)) throw new RangeError('cadenceMinutes must be auto, 10 or 60');
  if (!Number.isFinite(feeWindowMinutes) || feeWindowMinutes < 1 || feeWindowMinutes > 1440) {
    throw new RangeError('feeWindowMinutes must be between 1 and 1440');
  }
  if (!Number.isSafeInteger(maxPacks) || maxPacks < 1 || maxPacks > 32) throw new RangeError('maxPacks must be between 1 and 32');
  if (!Array.isArray(availableTiers) || availableTiers.some(tier => !PACK_TIERS.includes(tier))) {
    throw new RangeError('availableTiers must contain supported numeric pack tiers');
  }

  const treasury = moneyCents(treasuryUsd, 'treasuryUsd');
  const obligations = moneyCents(obligationsUsd, 'obligationsUsd', true);
  const reserve = moneyCents(reserveUsd, 'reserveUsd', true);
  const recentFees = moneyCents(recentFeesUsd, 'recentFeesUsd');
  const accruedFees = moneyCents(accruedFeesUsd, 'accruedFeesUsd');
  const dailyRemaining = moneyCents(dailyRemainingUsd, 'dailyRemainingUsd');
  const maxCycle = moneyCents(maxCycleUsd, 'maxCycleUsd');
  const liquid = Math.max(0, treasury - obligations - reserve);
  const hourlyFeesUsd = recentFees / 100 * 60 / feeWindowMinutes;
  const cadenceMinutes = requestedCadence === 'auto'
    ? (hourlyFeesUsd >= TREASURY_POLICY.fastCadenceHourlyFeesUsd && liquid >= TREASURY_POLICY.fastCadenceLiquidUsd * 100 ? 10 : 60)
    : requestedCadence;
  const liquidityBudget = Math.floor(liquid * TREASURY_POLICY.liquidityAllocationBps / 10_000);
  const feeBudget = Math.floor(accruedFees * TREASURY_POLICY.feeAllocationBps / 10_000);
  const budget = Math.min(liquidityBudget, feeBudget, dailyRemaining, maxCycle);
  const dueAtMs = lastDropAtMs === null ? nowMs : lastDropAtMs + cadenceMinutes * MINUTE_MS;
  const result = {
    eligible: false,
    reason: 'insufficient_budget',
    budgetUsd: budget / 100,
    spendUsd: 0,
    packs: [],
    cadenceMinutes,
    nextDropAtMs: dueAtMs > nowMs ? dueAtMs : nowMs + cadenceMinutes * MINUTE_MS,
    metrics: {
      liquidUsd: liquid / 100,
      protectedUsd: (obligations + reserve) / 100,
      hourlyFeesUsd: Math.floor(hourlyFeesUsd * 100) / 100,
      liquidityBudgetUsd: liquidityBudget / 100,
      feeBudgetUsd: feeBudget / 100,
      accruedFeesUsd: accruedFees / 100,
      projectedRemainingUsd: treasury / 100,
      unspentBudgetUsd: budget / 100,
    },
  };

  if (dueAtMs > nowMs) return { ...result, reason: 'cadence' };
  if (budget < 2500) return result;
  if (!availableTiers.length) return { ...result, reason: 'inventory_unavailable' };

  const chosen = [];
  let remaining = budget;
  const add = tier => { chosen.push(tier); remaining -= tier * 100; };

  // One premium pack per drop at most. Cross-tier cooldown prevents a $250
  // drop immediately following a $500 event (or vice versa).
  const previousPremium = Math.max(...[250, 500].map(tier => lastHighTierAtMs[tier] ?? -Infinity));
  for (const tier of [500, 250]) {
    const policy = PREMIUM_POLICY[tier];
    if (availableTiers.includes(tier) && remaining >= tier * 100 && liquid >= policy.liquidUsd * 100
      && hourlyFeesUsd >= policy.hourlyFeesUsd && nowMs - previousPremium >= policy.cooldownMs) {
      add(tier);
      break;
    }
  }

  // Common tiers favor variety while retaining several accessible objectives.
  // Fallback to a smaller available tier whenever the desired one is unfunded.
  const commonCycle = [100, 50, 25, 50, 25];
  let slot = 0;
  while (chosen.length < maxPacks) {
    const desired = commonCycle[slot++ % commonCycle.length];
    const tier = [100, 50, 25].find(value => value <= desired && availableTiers.includes(value) && value * 100 <= remaining);
    if (tier !== undefined) add(tier);
    else if (![25, 50, 100].some(value => availableTiers.includes(value) && value * 100 <= remaining)) break;
  }
  if (!chosen.length) return { ...result, reason: 'inventory_unavailable' };

  const packs = [...new Set(chosen)].map(tierUsd => ({
    tierUsd,
    quantity: chosen.filter(value => value === tierUsd).length,
    difficulty: DIFFICULTY[tierUsd],
  }));
  const spendUsd = (budget - remaining) / 100;
  return {
    ...result,
    eligible: true,
    reason: 'ready',
    spendUsd,
    packs,
    metrics: {
      ...result.metrics,
      projectedRemainingUsd: (treasury - budget + remaining) / 100,
      unspentBudgetUsd: remaining / 100,
    },
  };
}
