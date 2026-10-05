import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { selectProviderProfile, coinKey } from '../server/coin-profiles.mjs';

const address = () => Keypair.generate().publicKey.toBase58();

function database(profiles, pendingMints = []) {
  const writes = [];
  return {
    writes,
    async query(sql, args) {
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS lootmon_coin_profiles')) return { rows: [] };
      if (sql.includes("to_regclass('cards_provider_identity')")) return { rows: [{ relation: null }] };
      if (sql === 'SELECT * FROM lootmon_coin_profiles') return { rows: structuredClone(profiles) };
      if (sql.includes(' AS pending')) {
        const profile = profiles.find(row => sql.includes(`${row.table_prefix}reservations`));
        assert.ok(profile, 'pending queries stay in a registered profile');
        return { rows: [{ pending: pendingMints.includes(profile.coin_mint) }] };
      }
      if (sql.startsWith('INSERT INTO lootmon_coin_profiles')) { writes.push(args); return { rows: [] }; }
      throw new Error(`Unexpected test query: ${sql}`);
    },
  };
}

test('a fresh CA and different wallet start with isolated tables while old recovery remains paused', async () => {
  const old = { coin_mint: address(), treasury_wallet: address(), table_prefix: 'cards_provider_' };
  const mint = address(), wallet = address();
  const db = database([old], [old.coin_mint]);
  const profile = await selectProviderProfile(db, mint, wallet);
  assert.deepEqual(profile.pausedMints, [old.coin_mint]);
  assert.equal(profile.legacyMint, old.coin_mint);
  assert.deepEqual(profile.selected, { coin_mint: mint, treasury_wallet: wallet, table_prefix: `lc_${coinKey(mint)}_` });
  assert.deepEqual(db.writes, [], 'startup must not rewrite old financial records or register before schema initialization');
  await profile.register();
  assert.deepEqual(db.writes, [[mint, wallet, profile.selected.table_prefix]]);
});

test('shared-wallet obligations still block even if a different-wallet profile also has pending recovery', async () => {
  const wallet = address();
  const profiles = [
    { coin_mint: address(), treasury_wallet: address(), table_prefix: 'cards_provider_' },
    { coin_mint: address(), treasury_wallet: wallet, table_prefix: `lc_${'a'.repeat(24)}_` },
  ];
  const db = database(profiles, profiles.map(p => p.coin_mint));
  await assert.rejects(selectProviderProfile(db, address(), wallet), error => error.message.includes(`MEMECOIN_MINT=${profiles[1].coin_mint}`));
  assert.deepEqual(db.writes, []);
});

test('returning to a registered CA retains its wallet binding and original tables', async () => {
  const first = { coin_mint: address(), treasury_wallet: address(), table_prefix: 'cards_provider_' };
  const second = { coin_mint: address(), treasury_wallet: address(), table_prefix: `lc_${'b'.repeat(24)}_` };
  const db = database([first, second], [first.coin_mint, second.coin_mint]);
  await assert.rejects(selectProviderProfile(db, first.coin_mint, second.treasury_wallet), /different treasury wallet/);
  const profile = await selectProviderProfile(db, first.coin_mint, first.treasury_wallet);
  assert.deepEqual(profile.selected, first);
  assert.deepEqual(profile.pausedMints, [second.coin_mint], 'the active CA can resume its own pending recovery');
  assert.deepEqual(db.writes, []);
});
