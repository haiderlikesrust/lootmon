import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../server/storage.mjs';
import { coinKey, profileSql } from '../server/coin-profiles.mjs';

const A = 'So11111111111111111111111111111111111111112';
const B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const empty = () => ({ version: 1, packs: [], awards: [], accounts: {} });

test('CA-specific worlds restore exactly, with legacy inventory assigned only to its database identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lootmon-coins-'));
  let store;
  try {
    store = new FileStore(dir);
    const original = { ...empty(), packs: [{ id: 'real-prize' }], accounts: { alice: { score: 25 } } };
    store.save(original);
    store.selectMint(B, A);
    assert.deepEqual(store.load(), empty(), 'new CA must not inherit any original prize or leaderboard');
    store.save({ ...empty(), accounts: { bob: { score: 50 } } });
    store.close();
    store = new FileStore(dir);
    store.selectMint(A, A);
    assert.deepEqual(store.load(), original);
    store.save(original);
    store.close();
    store = new FileStore(dir);
    store.selectMint(B, A);
    assert.equal(store.load().accounts.bob.score, 50);
    assert.equal(store.load().accounts.alice, undefined);
    assert.throws(() => new FileStore(dir), /Another game authority/);
    const corrupt = { ...empty(), coinMint: A };
    writeFileSync(store.path, JSON.stringify(corrupt));
    assert.throws(() => store.load(), /different CA/);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('migration refuses to guess the CA of real legacy prizes; invalid mint cannot escape the data directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lootmon-coins-'));
  const store = new FileStore(dir);
  try {
    store.save({ ...empty(), awards: [{ id: 'pending-award' }] });
    const original = readFileSync(store.path, 'utf8');
    assert.throws(() => store.selectMint(B), /original CA verified/);
    assert.equal(readFileSync(store.path, 'utf8'), original);
    assert.throws(() => store.selectMint('../../escape'), /valid MEMECOIN_MINT/);
    assert.notEqual(coinKey(A), coinKey(B));
    assert.throws(() => profileSql('SELECT 1', 'evil;'), /Invalid coin table/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
