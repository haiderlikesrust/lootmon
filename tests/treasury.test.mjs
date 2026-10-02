import test from 'node:test';
import assert from 'node:assert/strict';
import { planDrop, PACK_TIERS } from '../server/treasury.mjs';

const NOW = 1_800_000_000_000;
const snapshot = (overrides = {}) => ({
  treasuryUsd: 2840, obligationsUsd: 975, reserveUsd: 500,
  recentFeesUsd: 126, feeWindowMinutes: 10, nowMs: NOW,
  ...overrides,
});
const total = plan => plan.packs.reduce((sum, pack) => sum + pack.tierUsd * pack.quantity, 0);

test('funded snapshot respects obligations, reserve, and realized fee budget', () => {
  const plan = planDrop(snapshot());
  assert.equal(plan.eligible, true);
  assert.equal(plan.cadenceMinutes, 10);
  assert.equal(plan.metrics.liquidUsd, 1365);
  assert.equal(plan.budgetUsd, 88.2);
  assert.equal(plan.spendUsd, 75);
  assert.equal(total(plan), plan.spendUsd);
  assert.ok(plan.metrics.projectedRemainingUsd >= 1475);
});

test('stops spending when obligations consume liquidity, fees are absent, or daily cap is exhausted', () => {
  for (const overrides of [{ obligationsUsd: 3000 }, { recentFeesUsd: 0 }, { dailyRemainingUsd: 0 }, { maxCycleUsd: 24.99 }]) {
    const plan = planDrop(snapshot(overrides));
    assert.equal(plan.eligible, false);
    assert.equal(plan.spendUsd, 0);
    assert.deepEqual(plan.packs, []);
  }
});

test('slow fee inflow uses hourly cadence and accumulated realized fees can fund a later drop', () => {
  assert.equal(planDrop(snapshot({ recentFeesUsd: 10, feeWindowMinutes: 60 })).eligible, false);
  const plan = planDrop(snapshot({ recentFeesUsd: 10, feeWindowMinutes: 60, accruedFeesUsd: 50 }));
  assert.equal(plan.cadenceMinutes, 60);
  assert.equal(plan.spendUsd, 25);
});

test('the due timestamp gates allocation and becomes eligible at the exact boundary', () => {
  const waiting = planDrop(snapshot({ lastDropAtMs: NOW - 599_999 }));
  assert.equal(waiting.reason, 'cadence');
  assert.equal(waiting.nextDropAtMs, NOW + 1);
  assert.equal(waiting.spendUsd, 0);
  assert.equal(planDrop(snapshot({ lastDropAtMs: NOW - 600_000 })).eligible, true);
});

test('premium packs require treasury depth, healthy current flow, and cooldowns across premium tiers', () => {
  const rich = snapshot({ treasuryUsd: 20_000, obligationsUsd: 0, recentFeesUsd: 2000, feeWindowMinutes: 60 });
  const plan = planDrop(rich);
  assert.equal(plan.packs.find(pack => pack.tierUsd === 500)?.quantity, 1);
  assert.equal(plan.packs.some(pack => pack.tierUsd === 250), false);
  assert.equal(plan.packs.find(pack => pack.tierUsd === 500)?.difficulty, 'summit');
  const cooling = planDrop({ ...rich, lastHighTierAtMs: { 500: NOW - 60 * 60_000 } });
  assert.equal(cooling.packs.some(pack => pack.tierUsd >= 250), false);
  const mid = planDrop({ ...rich, recentFeesUsd: 500, accruedFeesUsd: 2000 });
  assert.equal(mid.packs.find(pack => pack.tierUsd === 250)?.difficulty, 'vault');
  const staleFlow = planDrop({ ...rich, recentFeesUsd: 0, accruedFeesUsd: 2000 });
  assert.equal(staleFlow.packs.some(pack => pack.tierUsd >= 250), false);
});

test('provider inventory and pack count constrain the same budget', () => {
  const rich = snapshot({ treasuryUsd: 20_000, recentFeesUsd: 2000, availableTiers: [50], maxPacks: 3 });
  const plan = planDrop(rich);
  assert.deepEqual(plan.packs, [{ tierUsd: 50, quantity: 3, difficulty: 'interior' }]);
  assert.equal(plan.spendUsd, 150);
  assert.equal(planDrop({ ...rich, availableTiers: [] }).reason, 'inventory_unavailable');
});

test('fractional cents never inflate funds and liabilities round up', () => {
  const plan = planDrop(snapshot({ treasuryUsd: 500.999, reserveUsd: 0.001, obligationsUsd: 0.001, recentFeesUsd: 1000, maxCycleUsd: 25.999 }));
  assert.equal(plan.metrics.liquidUsd, 500.97);
  assert.equal(plan.budgetUsd, 25.99);
  assert.equal(plan.spendUsd, 25);
});

test('rejects invalid values instead of treating corrupt provider data as spendable funds', () => {
  for (const overrides of [
    { treasuryUsd: NaN }, { recentFeesUsd: Infinity }, { obligationsUsd: -1 },
    { treasuryUsd: '10000' }, { nowMs: undefined }, { feeWindowMinutes: 0 },
    { cadenceMinutes: 30 }, { maxPacks: 0 }, { availableTiers: [75] },
    { lastDropAtMs: NOW + 1 }, { lastHighTierAtMs: { 500: NOW + 1 } },
  ]) assert.throws(() => planDrop(snapshot(overrides)));
});

test('identical snapshots are deterministic and never mutated', () => {
  const input = Object.freeze(snapshot({ lastHighTierAtMs: Object.freeze({}), availableTiers: Object.freeze([25, 50, 100]) }));
  assert.deepEqual(planDrop(input), planDrop(input));
});

test('budget invariants hold over varied fee and treasury conditions', () => {
  for (let i = 0; i < 250; i++) {
    const input = snapshot({
      treasuryUsd: i * 179.19,
      obligationsUsd: (i % 19) * 73.17,
      recentFeesUsd: (i % 31) * 67.31,
      dailyRemainingUsd: (i % 17) * 97.19,
      maxPacks: 1 + i % 12,
    });
    const plan = planDrop(input);
    assert.equal(total(plan), plan.spendUsd);
    assert.ok(plan.spendUsd <= plan.budgetUsd);
    assert.ok(plan.spendUsd <= Math.max(0, input.treasuryUsd - input.obligationsUsd - input.reserveUsd));
    assert.ok(plan.spendUsd <= input.dailyRemainingUsd);
    assert.ok(plan.packs.reduce((sum, pack) => sum + pack.quantity, 0) <= input.maxPacks);
    assert.ok(plan.packs.every(pack => PACK_TIERS.includes(pack.tierUsd)));
    assert.ok(plan.packs.filter(pack => pack.tierUsd >= 250).reduce((sum, pack) => sum + pack.quantity, 0) <= 1);
  }
});
