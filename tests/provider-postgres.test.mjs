import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Keypair } from '@solana/web3.js';
import { createProvider } from '../server/provider.mjs';
import { Jobs, PendingOperation, ReviewRequired, PurchaseRefunded } from '../server/integrations/jobs.mjs';
import { Providers } from '../server/integrations/providers.mjs';
import { configure, config } from '../server/integrations/config.mjs';
import { coinKey } from '../server/coin-profiles.mjs';

// Optional integration coverage. This must point to a dedicated test database,
// never the app's DATABASE_URL. Only a randomly named, marked schema is removed.
const testDatabaseUrl = process.env.LOOTMON_TEST_DATABASE_URL;
test('PostgreSQL persists provider recovery, excludes another authority, and credits verified refunds exactly once', {
  skip: !testDatabaseUrl && 'Set LOOTMON_TEST_DATABASE_URL for the dedicated lootmon_test database',
  timeout: 45_000,
}, async () => {
  const url = new URL(testDatabaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'A PostgreSQL test URL is required');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'lootmon_test', 'Refusing to use a database other than lootmon_test');
  const schema = `lootmon_provider_test_${randomUUID().replaceAll('-', '')}`;
  const marker = `Isolated Lootmon provider test ${schema}`;
  assert.match(schema, /^lootmon_provider_test_[0-9a-f]{32}$/);
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 2, connectionTimeoutMillis: 5000 });
  let schemaCreated = false;
  let provider;
  let clock = Date.now();
  const state = { purchaseReady: false, transferReady: false, eligible: true, refundReady: false, refundReservation: null, transferBuilds: 0 };
  const treasury = Keypair.generate().publicKey.toBase58();
  const coin = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  const winner = Keypair.generate().publicKey.toBase58();
  const signature = 'offline-fixture-transfer';
  const env = {
    MAINNET_ENABLED: 'true', MEMECOIN_MINT: coin, TREASURY_PRIVATE_KEY: 'offline-fixture-key-never-parsed',
    DATABASE_URL: testDatabaseUrl, SOLANA_RPC_URL: 'https://offline-fixture.invalid',
    JUPITER_API_KEY: 'offline-fixture-unused', COLLECTOR_CRYPT_PAYMENT_WALLET: recipient,
  };
  class IsolatedPool extends Pool {
    constructor(options) { super({ ...options, options: `-c search_path=${schema}` }); }
  }
  const query = (sql, args) => admin.query(sql.replace(/\b(jobs|ledger|prizes|reservations|awards|drops)\b/g, name => `"${schema}".cards_provider_${name}`), args);
  class OfflineChain {
    constructor(jobs) { this.jobs = jobs; }
    address = treasury;
    rpc = { ok: true };
    async init() {}
    async health() {}
    async eligibility() { return { eligible: state.eligible }; }
    async balance(mint) {
      if (mint === 'So11111111111111111111111111111111111111112') return 1_000_000_000n;
      if (mint !== config.USDC_MINT) return 0n;
      const totals = (await this.jobs.db.query(`SELECT
        COALESCE(SUM(amount_micros) FILTER (WHERE kind='pack'),0)::text AS spent,
        COALESCE(SUM(amount_micros) FILTER (WHERE kind='refund' AND data->>'verified'='true'),0)::text AS refunded
        FROM ledger`)).rows[0];
      return 5_000_000_000n - BigInt(totals.spent) + BigInt(totals.refunded);
    }
    async transferNft(id, mint, wallet) {
      let job = await this.jobs.get(id);
      if (!job) {
        state.transferBuilds++;
        await this.jobs.put(id, 'nft-transfer', 'submitted', { signature, mint, wallet });
        job = await this.jobs.get(id);
      }
      assert.equal(job.data.mint, mint);
      assert.equal(job.data.wallet, wallet);
      if (!state.transferReady) throw new PendingOperation('Offline fixture awaiting confirmation');
      await this.jobs.put(id, 'nft-transfer', 'confirmed', job.data);
      return job.data.signature;
    }
    async verifyRefund(intent) {
      assert.equal(intent.recipient, recipient);
      assert.equal(intent.mint, config.USDC_MINT);
      assert.equal(intent.amount, 25_000_000n);
      if (!state.refundReady) throw new PendingOperation('Offline fixture lacks refund confirmation', 'refund_pending');
      return { signature: 'offline-fixture-verified-refund', slot: 200, amountMicros: '25000000', receivedMicros: '25000000' };
    }
  }
  class OfflineProviders {
    constructor(chain, jobs) { this.chain = chain; this.jobs = jobs; state.currentJobs = jobs; }
    async machines() { return [{ price: 25 }]; }
    async collectFees() {
      await this.jobs.db.query("INSERT INTO ledger(id,kind,amount_micros,created_at) VALUES('fixture-fee','fee',1000000000,$1) ON CONFLICT(id) DO NOTHING", [clock]);
    }
    async purchase(id, tier) {
      const operation = `pack:${id}`;
      if (id === state.refundReservation) {
        await this.jobs.db.query("INSERT INTO ledger(id,kind,amount_micros,signature,created_at) VALUES($1,'pack',$2,'offline-refunded-payment',$3) ON CONFLICT(id) DO NOTHING", [operation, tier * 1_000_000, clock]);
        const proof = await new Providers(this.chain, this.jobs).recordRefund(operation, { paymentSignature: 'offline-refunded-payment', memo: 'original-refunded-order' }, tier, 'offline-fixture-verified-refund');
        throw new PurchaseRefunded(proof);
      }
      if (!state.purchaseReady) throw new PendingOperation('Offline fixture awaits custody', 'custody_pending');
      const stored = await this.jobs.get(operation);
      if (stored?.status === 'complete') return stored.data.prize;
      const prize = {
        id: `prize:${id}`, mint: Keypair.generate().publicKey.toBase58(), name: 'Offline PostgreSQL fixture', image: '',
        value: 25, purchaseSignature: `offline-purchase:${id}`, coinMint: coin,
      };
      await this.jobs.db.query("INSERT INTO ledger(id,kind,amount_micros,signature,created_at) VALUES($1,'pack',$2,$3,$4) ON CONFLICT(id) DO NOTHING", [operation, tier * 1_000_000, prize.purchaseSignature, clock]);
      await this.jobs.db.query("INSERT INTO prizes(id,mint,data,status) VALUES($1,$2,$3,'available')", [prize.id, prize.mint, JSON.stringify(prize)]);
      await this.jobs.put(operation, 'pack', 'complete', { tier, prize });
      return prize;
    }
  }
  const open = () => createProvider({ env, runtime: { Pool: IsolatedPool, Chain: OfflineChain, Providers: OfflineProviders, now: () => clock } });
  try {
    const identity = (await admin.query('SELECT current_database() AS database, current_user AS owner')).rows[0];
    assert.equal(identity.database, 'lootmon_test', 'Connected server must confirm the test database identity');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    // Marker contains only a fixed prefix and a generated lowercase hex name.
    await admin.query(`COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
    provider = await open();
    await assert.rejects(open(), /Another game authority/);
    assert.deepEqual(await provider.tick(), []);
    let reservations = (await query('SELECT * FROM reservations ORDER BY id')).rows;
    assert.ok(reservations.length > 0);
    assert.ok(reservations.every(row => row.status === 'pending' && row.recovery.attempts === 1 && row.recovery.code === 'custody_pending'));
    const reservationCount = reservations.length;
    const drop = (await query('SELECT id FROM drops')).rows[0].id;

    await provider.close(); provider = await open();
    assert.deepEqual(await provider.tick(), [], 'restart preserves the durable retry deadline');
    assert.equal((await query('SELECT COUNT(*)::int AS count FROM reservations')).rows[0].count, reservationCount);
    clock += 15_000;
    state.purchaseReady = true;
    const inventory = await provider.tick();
    assert.equal(inventory.length, reservationCount);
    reservations = (await query('SELECT * FROM reservations')).rows;
    assert.ok(reservations.every(row => row.status === 'complete' && row.recovery.attempts === 2));
    await provider.close(); provider = await open();
    assert.deepEqual((await provider.tick()).map(prize => prize.id), inventory.map(prize => prize.id), 'purchased inventory is replayed after ingestion interruption');
    assert.equal((await query("SELECT COUNT(*)::int AS count FROM ledger WHERE kind='pack'")).rows[0].count, reservationCount);

    const intent = { id: inventory[0].id, mint: inventory[0].mint, wallet: winner };
    const pending = await provider.award(intent);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.nextAttemptAt, clock + 15_000);
    await provider.close(); provider = await open();
    await assert.rejects(provider.award({ ...intent, wallet: recipient }), ReviewRequired);
    assert.equal((await provider.award(intent)).status, 'pending');
    clock += 15_000;
    state.transferReady = true;
    state.eligible = false; // Reconcile an already signed transfer even after holdings change.
    assert.deepEqual(await provider.award(intent), { status: 'confirmed', signature });
    assert.deepEqual(await provider.award(intent), { status: 'confirmed', signature });
    assert.equal(state.transferBuilds, 1);
    assert.equal((await query('SELECT COUNT(*)::int AS count FROM awards')).rows[0].count, 1);
    assert.equal((await provider.tick()).length, inventory.length, 'one secured pack is replaced by one new funded pack');

    state.refundReservation = 'fixture-refund-reservation';
    await query("INSERT INTO reservations(id,drop_id,tier,status,created_at) VALUES($1,$2,25,'pending',$3)", [state.refundReservation, drop, clock]);
    // Historical unverified refund rows must not restore any spending capacity.
    await query("INSERT INTO ledger(id,kind,amount_micros,created_at) VALUES($1,'refund',25000000,$2)", [`pack:${state.refundReservation}:refund`, clock]);
    await provider.tick();
    assert.equal(provider.status.refundsVerifiedUsd, 0);
    assert.equal((await query('SELECT recovery FROM reservations WHERE id=$1', [state.refundReservation])).rows[0].recovery.code, 'refund_pending');
    const budgetBeforeRefund = provider.status.budgetUsd;
    clock += 60_000;
    state.refundReady = true;
    await provider.tick();
    assert.equal(provider.status.refundsVerifiedUsd, 25);
    assert.ok(provider.status.budgetUsd <= 1000, 'verified refund never bypasses the per-cycle cap');
    assert.equal((await query('SELECT status FROM reservations WHERE id=$1', [state.refundReservation])).rows[0].status, 'refunded');
    await provider.close(); provider = await open();
    await provider.tick();
    assert.equal(provider.status.refundsVerifiedUsd, 25, 'restarts cannot credit the same refund again');
    const realJobs = new Jobs({ query });
    const refunds = new Providers(new OfflineChain(realJobs), realJobs);
    await assert.rejects(refunds.recordRefund('pack:second-refund', { paymentSignature: 'different-payment', memo: 'different-order' }, 25, 'offline-fixture-verified-refund'), ReviewRequired);
    assert.equal((await query("SELECT COUNT(*)::int AS count FROM ledger WHERE kind='refund' AND data->>'verified'='true'")).rows[0].count, 1);

    const restoredInventory = (await provider.tick()).map(p => p.id);
    // Same deployment/database: unsettled payments cannot be hidden by changing CA.
    const otherCoin = Keypair.generate().publicKey.toBase58();
    const openOther = () => createProvider({ env: { ...env, MEMECOIN_MINT: otherCoin }, runtime: { Pool: IsolatedPool, Chain: OfflineChain, Providers: OfflineProviders, now: () => clock } });
    await provider.close(); provider = null;
    await query("INSERT INTO jobs(id,kind,status,data,created_at,updated_at) VALUES('unsettled','swap','submitted','{}',0,0)");
    await assert.rejects(openOther(), /CA switch blocked/);

    // A separate wallet has no access to this profile's reserved funds. Allow
    // its own new CA to start, preserving all old operations byte for byte.
    const isolatedCoin = Keypair.generate().publicKey.toBase58();
    const isolatedTreasury = Keypair.generate().publicKey.toBase58();
    class SeparateWalletChain extends OfflineChain { address = isolatedTreasury; }
    const snapshot = async () => Promise.all(['jobs', 'reservations', 'awards', 'prizes', 'ledger'].map(async table =>
      (await query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows));
    const beforeSwitch = await snapshot();
    provider = await createProvider({ env: { ...env, MEMECOIN_MINT: isolatedCoin }, runtime: { Pool: IsolatedPool, Chain: SeparateWalletChain, Providers: OfflineProviders, now: () => clock } });
    assert.deepEqual(provider.pausedMints, [coin]);
    assert.equal(provider.legacyMint, coin);
    assert.deepEqual(await snapshot(), beforeSwitch, 'different-wallet startup must not change old payment, recovery or prize records');
    for (const table of ['jobs', 'reservations', 'awards', 'prizes', 'ledger']) {
      const count = (await admin.query(`SELECT COUNT(*)::int AS count FROM "${schema}".lc_${coinKey(isolatedCoin)}_${table}`)).rows[0].count;
      assert.equal(count, 0, 'a separate CA starts with an empty financial ledger and no inherited inventory');
    }
    await provider.close(); provider = null;
    await assert.rejects(createProvider({ env: { ...env, MEMECOIN_MINT: isolatedCoin }, runtime: { Pool: IsolatedPool, Chain: OfflineChain, Providers: OfflineProviders } }), /different treasury wallet/);
    await query("UPDATE jobs SET status='confirmed' WHERE id='unsettled'");
    provider = await openOther();
    assert.equal(provider.legacyMint, coin);
    const crossCoinRefund = new Providers(new OfflineChain(state.currentJobs), state.currentJobs);
    await assert.rejects(crossCoinRefund.recordRefund('pack:other-coin', { paymentSignature: 'different-payment', memo: 'different-order' }, 25, 'offline-fixture-verified-refund'), /already credited to another CA/);
    const otherQuery = (sql, args) => admin.query(sql.replace(/\b(jobs|ledger|prizes|reservations|awards|drops)\b/g, name => `"${schema}".lc_${coinKey(otherCoin)}_${name}`), args);
    assert.equal((await otherQuery('SELECT COUNT(*)::int AS count FROM prizes')).rows[0].count, 0);
    assert.equal((await otherQuery('SELECT COUNT(*)::int AS count FROM ledger')).rows[0].count, 0, 'new CA does not inherit recorded fees');
    // Existing wallet spending consumes the same daily cap after changing CA.
    await query("INSERT INTO ledger(id,kind,amount_micros,created_at) VALUES('daily-cap-fixture','pack',1500000000,$1)", [clock]);
    assert.deepEqual(await provider.tick(), []);
    assert.equal((await otherQuery('SELECT COUNT(*)::int AS count FROM reservations')).rows[0].count, 0, 'CA switch cannot reset wallet daily spending');
    await provider.close(); provider = await open();
    assert.deepEqual((await provider.tick()).map(p => p.id), restoredInventory, 'switching back restores original unclaimed inventory');
  } finally {
    await provider?.close();
    configure({});
    try {
      if (schemaCreated) {
        const identity = (await admin.query("SELECT current_database() AS database, current_user AS owner, n.nspname, pg_get_userbyid(n.nspowner) AS schema_owner, obj_description(n.oid,'pg_namespace') AS marker FROM pg_namespace n WHERE n.nspname=$1", [schema])).rows[0];
        assert.equal(identity?.database, 'lootmon_test');
        assert.equal(identity?.nspname, schema);
        assert.equal(identity?.schema_owner, identity?.owner);
        assert.equal(identity?.marker, marker, 'Only this test-created schema may be removed');
        assert.match(schema, /^lootmon_provider_test_[0-9a-f]{32}$/);
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally { await admin.end(); }
  }
});
