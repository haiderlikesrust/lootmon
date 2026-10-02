import { randomUUID } from 'node:crypto';
import { planDrop } from './treasury.mjs';
import { config, configure, configBlockers } from './integrations/config.mjs';
import { beginRecoveryAttempt, finishRecoveryAttempt, recoveryDue, recoveryResult } from './integrations/recovery.mjs';

const LOCK_ID = 739_214_617;
const AUTHORITY_LOCK_ID = 739_214_618;
const USD_MICROS = 1_000_000;
const asUsd = micros => Number(micros) / USD_MICROS;

// The reference adapter uses concise table names. Namespace every query so it
// cannot alter the game's storage or tables belonging to the reference app.
function namespaceQuery(sql) {
  return sql.replace(/\b(jobs|ledger|prizes)\b/g, name => `cards_provider_${name}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards_provider_identity (
  id INTEGER PRIMARY KEY CHECK (id=1), coin_mint TEXT NOT NULL, treasury_wallet TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards_provider_jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, data JSONB NOT NULL,
  error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards_provider_ledger (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount_micros NUMERIC(30,0) NOT NULL,
  signature TEXT, created_at BIGINT NOT NULL, data JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS cards_provider_prizes (
  id TEXT PRIMARY KEY, mint TEXT NOT NULL UNIQUE, data JSONB NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards_provider_drops (
  id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, plan JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS cards_provider_reservations (
  id TEXT PRIMARY KEY, drop_id TEXT NOT NULL REFERENCES cards_provider_drops(id),
  tier INTEGER NOT NULL CHECK (tier IN (25,50,100,250,500)),
  status TEXT NOT NULL, created_at BIGINT NOT NULL, prize_id TEXT UNIQUE, recovery JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS cards_provider_awards (
  prize_id TEXT PRIMARY KEY REFERENCES cards_provider_prizes(id), wallet TEXT NOT NULL,
  mint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, signature TEXT, created_at BIGINT NOT NULL, recovery JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE cards_provider_reservations ADD COLUMN IF NOT EXISTS recovery JSONB NOT NULL DEFAULT '{}';
ALTER TABLE cards_provider_awards ADD COLUMN IF NOT EXISTS recovery JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS cards_provider_verified_refund_signature ON cards_provider_ledger(signature)
  WHERE kind='refund' AND data->>'verified'='true';
CREATE INDEX IF NOT EXISTS cards_provider_ledger_created ON cards_provider_ledger(created_at);
CREATE INDEX IF NOT EXISTS cards_provider_reservations_status ON cards_provider_reservations(status);
`;

/**
 * Mainnet adapter. Creation stays offline when required configuration is absent.
 * Call only once per server process: integration modules share server config.
 * No secrets or provider response payloads are exposed through status.
 */
export async function createProvider({ env = process.env, runtime = {}, onAuthorityLost = () => {} } = {}) {
  configure(env);
  const blockers = configBlockers();
  const state = {
    enabled: config.live, ready: false, blockers,
    balance: null, fees10m: null, reserved: null,
    nextDropAt: null, budgetUsd: null, cadenceMinutes: null,
    lastUpdatedAt: null, error: null, recovery: { purchasesPending: 0, purchasesQuarantined: 0, purchasesRefunded: 0, awardsQuarantined: 0 },
  };
  if (blockers.length) {
    return {
      status: state,
      async tick() { return []; },
      async award() { return { status: 'pending', reason: 'Treasury integration is not configured' }; },
      async close() {},
    };
  }

  const [{ Pool: PgPool }, { Jobs, PendingOperation, ReviewRequired, PurchaseRefunded }, { Chain: SolanaChain }, { Providers: LiveProviders }, { NATIVE_MINT }, { PublicKey }] = await Promise.all([
    import('pg'), import('./integrations/jobs.mjs'), import('./integrations/chain.mjs'),
    import('./integrations/providers.mjs'), import('@solana/spl-token'), import('@solana/web3.js'),
  ]);
  // Dependency injection allows the same reservation/award workflow to be
  // verified offline. Runtime defaults always use the real adapters.
  const Pool = runtime.Pool ?? PgPool;
  const Chain = runtime.Chain ?? SolanaChain;
  const Providers = runtime.Providers ?? LiveProviders;
  const now = runtime.now ?? Date.now;
  // Validate public identifiers before creating database connections or doing RPC.
  for (const key of ['MEMECOIN_MINT', 'COLLECTOR_CRYPT_PAYMENT_WALLET', 'CARDS_MINT', 'USDC_MINT']) {
    try { new PublicKey(config[key]); } catch { throw new Error(`${key} must be a valid Solana public key`); }
  }
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 });
  pool.on('error', () => { state.ready = false; state.error = 'Treasury database connection failed'; });
  const db = { query: (sql, parameters) => pool.query(namespaceQuery(sql), parameters) };
  const jobs = new Jobs(db);
  const chain = new Chain(jobs);
  let authorityClient;
  let authorityLost = false;
  try {
    await chain.init();
    if (!chain.address) throw new Error('Treasury signing key is required');
    config.FEE_RECIPIENT = chain.address;
    // This session lives for the entire game-server lifetime, not one poll.
    // A different GAME_DATA_DIR must never replay the same prize inventory
    // into another independently authoritative world.
    authorityClient = await pool.connect();
    const lease = (await authorityClient.query('SELECT pg_try_advisory_lock($1) AS locked', [AUTHORITY_LOCK_ID])).rows[0];
    if (!lease.locked) throw new Error('Another game authority already owns this provider database');
    authorityClient.on?.('error', () => {
      authorityLost = true;
      state.ready = false;
      state.error = 'Database authority lease was lost; restart the game server before resuming';
      onAuthorityLost();
    });
    await pool.query(SCHEMA);
    await pool.query('INSERT INTO cards_provider_identity(id,coin_mint,treasury_wallet) VALUES(1,$1,$2) ON CONFLICT(id) DO NOTHING', [config.MEMECOIN_MINT, chain.address]);
    const identity = (await pool.query('SELECT coin_mint,treasury_wallet FROM cards_provider_identity WHERE id=1')).rows[0];
    if (identity.coin_mint !== config.MEMECOIN_MINT || identity.treasury_wallet !== chain.address) {
      throw new Error('Provider ledger belongs to a different coin or treasury; use a separate database');
    }
  } catch (error) {
    authorityClient?.release();
    await pool.end();
    throw error;
  }
  const providers = new Providers(chain, jobs);
  const settings = { paused: false, dailyCapUsd: config.DAILY_CAP_USD, gasReserveSol: config.GAS_RESERVE_SOL, slippageBps: config.SLIPPAGE_BPS };
  let closed = false;
  let activeOperations = 0;
  let resolveDrained;

  async function withLock(fn) {
    if (closed || authorityLost) throw new Error('Treasury provider does not own the game authority lease');
    activeOperations++;
    let client;
    let locked = false;
    try {
      client = await pool.connect();
      locked = (await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID])).rows[0].locked;
      if (!locked) return null;
      return await fn(client);
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
      client?.release();
      activeOperations--;
      if (!activeOperations) resolveDrained?.();
    }
  }

  async function fundedInventory() {
    const rows = (await pool.query(`SELECT p.data FROM cards_provider_prizes p
      WHERE p.status='available' AND p.data ? 'tierUsd'
      AND NOT EXISTS(SELECT 1 FROM cards_provider_awards a WHERE a.prize_id=p.id)
      ORDER BY p.id`)).rows;
    return rows.map(row => row.data);
  }

  async function settleReservations() {
    const reservations = (await pool.query(`SELECT * FROM cards_provider_reservations
      WHERE status IN ('pending','review') AND COALESCE((recovery->>'nextAttemptAt')::bigint,0)<=$1
      ORDER BY created_at,id LIMIT 16`, [now()])).rows;
    for (const reservation of reservations) {
      const attempt = beginRecoveryAttempt(reservation.recovery, now());
      await pool.query('UPDATE cards_provider_reservations SET recovery=$2,status=$3 WHERE id=$1', [reservation.id, JSON.stringify(attempt), 'pending']);
      try {
        const prize = await providers.purchase(reservation.id, reservation.tier, settings);
        const funded = { ...prize, tierUsd: reservation.tier };
        await pool.query("UPDATE cards_provider_prizes SET data=$2 WHERE id=$1", [prize.id, JSON.stringify(funded)]);
        await pool.query("UPDATE cards_provider_reservations SET status='complete',prize_id=$2,recovery=$3 WHERE id=$1", [reservation.id, prize.id, JSON.stringify(finishRecoveryAttempt(attempt, 'confirmed', now()))]);
      } catch (error) {
        const recovery = finishRecoveryAttempt(attempt, error, now());
        const status = error instanceof PurchaseRefunded ? 'refunded' : recovery.state === 'quarantined' ? 'quarantined' : 'pending';
        await pool.query('UPDATE cards_provider_reservations SET recovery=$2,status=$3 WHERE id=$1', [reservation.id, JSON.stringify(recovery), status]);
      }
    }
  }

  async function reconcileFees() {
    const id = 'recovery:fee-collection';
    const record = await jobs.get(id);
    let recovery = record?.data?.recovery ?? {};
    if (recoveryDue(recovery, now())) {
      const attempt = beginRecoveryAttempt(recovery, now());
      await jobs.put(id, 'recovery', 'running', { recovery: attempt });
      try {
        await providers.collectFees(settings);
        // Successful maintenance is due again at the next worker interval.
        recovery = { ...finishRecoveryAttempt(attempt, 'confirmed', now()), state: 'idle', nextAttemptAt: now() + 15_000, attempts: 0 };
      } catch (error) { recovery = finishRecoveryAttempt(attempt, error, now()); }
      await jobs.put(id, 'recovery', recovery.state, { recovery });
    }
    state.feeRecovery = recovery;
  }

  async function refreshRecoveryStatus() {
    const row = (await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM cards_provider_reservations WHERE status IN ('pending','review')) AS purchases_pending,
      (SELECT COUNT(*)::int FROM cards_provider_reservations WHERE status='quarantined') AS purchases_quarantined,
      (SELECT COUNT(*)::int FROM cards_provider_reservations WHERE status='refunded') AS purchases_refunded,
      (SELECT COUNT(*)::int FROM cards_provider_awards WHERE status='quarantined') AS awards_quarantined`)).rows[0];
    state.recovery = { purchasesPending: row.purchases_pending, purchasesQuarantined: row.purchases_quarantined,
      purchasesRefunded: row.purchases_refunded, awardsQuarantined: row.awards_quarantined };
    if (row.purchases_quarantined || row.awards_quarantined) state.error = 'Unsafe operations are quarantined with their obligations protected; other funded operations continue.';
  }

  async function treasurySnapshot(nowMs) {
    await chain.health();
    if (!chain.rpc.ok) throw new Error('Treasury RPC is unavailable');
    const [usdc, cards, sol, machines] = await Promise.all([
      chain.balance(config.USDC_MINT), chain.balance(config.CARDS_MINT),
      chain.balance(NATIVE_MINT.toBase58()), providers.machines(),
    ]);
    if (sol < BigInt(Math.ceil(config.GAS_RESERVE_SOL * 1e9))) throw new Error('Treasury gas reserve is below the configured minimum');
    let cardsValue = 0n;
    if (cards > 0n) {
      const quotedAt = Date.now();
      const quote = await providers.quote(config.CARDS_MINT, config.USDC_MINT, cards);
      if (Date.now() - quotedAt > 10_000 || quote.errorCode || quote.inputMint !== config.CARDS_MINT
        || quote.outputMint !== config.USDC_MINT || String(quote.inAmount) !== cards.toString()
        || !/^\d+$/.test(String(quote.outAmount)) || BigInt(quote.outAmount) <= 0n) throw new Error('Executable CARDS valuation is unavailable');
      cardsValue = BigInt(quote.outAmount) * BigInt(10_000 - config.SLIPPAGE_BPS) / 10_000n;
    }
    const dayStart = Math.floor(nowMs / 86_400_000) * 86_400_000;
    const accounting = (await pool.query(`SELECT
      COALESCE((SELECT SUM(amount_micros) FROM cards_provider_ledger WHERE kind='fee'),0)::text AS fees_total,
      COALESCE((SELECT SUM(amount_micros) FROM cards_provider_ledger WHERE kind='fee' AND created_at>$1),0)::text AS fees_recent,
      COALESCE((SELECT SUM(amount_micros) FROM cards_provider_ledger WHERE kind='pack'),0)::text AS spent_total,
      COALESCE((SELECT SUM(amount_micros) FROM cards_provider_ledger WHERE kind='refund' AND data->>'verified'='true'),0)::text AS refunds_total,
      COALESCE((SELECT SUM(amount_micros) FROM cards_provider_ledger WHERE kind='pack' AND created_at>=$2),0)::text AS spent_today,
      COALESCE((SELECT SUM(r.amount_micros) FROM cards_provider_ledger r JOIN cards_provider_ledger p ON p.id=r.data->>'purchaseId'
        WHERE r.kind='refund' AND r.data->>'verified'='true' AND p.kind='pack' AND p.created_at>=$2),0)::text AS refunds_today,
      COALESCE((SELECT SUM(tier*1000000::bigint) FROM cards_provider_reservations r
        WHERE NOT EXISTS(SELECT 1 FROM cards_provider_ledger l WHERE l.id='pack:'||r.id)),0)::text AS reserved,
      COALESCE((SELECT SUM(tier*1000000::bigint) FROM cards_provider_reservations r WHERE r.created_at>=$2
        AND NOT EXISTS(SELECT 1 FROM cards_provider_ledger l WHERE l.id='pack:'||r.id)),0)::text AS reserved_today,
      (SELECT MAX(created_at) FROM cards_provider_drops) AS last_drop,
      (SELECT MAX(created_at) FROM cards_provider_reservations WHERE tier=250) AS last_250,
      (SELECT MAX(created_at) FROM cards_provider_reservations WHERE tier=500) AS last_500`, [nowMs - 600_000, dayStart])).rows[0];
    // A spent dollar consumes a dollar of the 70% fee allocation; divide the
    // remaining allocation by 0.7 because the pure planner applies that ratio.
    const feeAllocation = BigInt(accounting.fees_total) * 7n / 10n - BigInt(accounting.spent_total) + BigInt(accounting.refunds_total) - BigInt(accounting.reserved);
    const accrued = feeAllocation > 0n ? feeAllocation * 10n / 7n : 0n;
    const plan = planDrop({
      nowMs, treasuryUsd: asUsd(usdc + cardsValue), obligationsUsd: asUsd(accounting.reserved),
      reserveUsd: config.TREASURY_RESERVE_USD,
      recentFeesUsd: asUsd(accounting.fees_recent), feeWindowMinutes: 10,
      accruedFeesUsd: asUsd(accrued),
      lastDropAtMs: accounting.last_drop === null ? null : Number(accounting.last_drop),
      lastHighTierAtMs: Object.fromEntries([[250, accounting.last_250], [500, accounting.last_500]].filter(([, at]) => at !== null).map(([tier, at]) => [tier, Number(at)])),
      dailyRemainingUsd: Math.max(0, config.DAILY_CAP_USD - asUsd(BigInt(accounting.spent_today) - BigInt(accounting.refunds_today) + BigInt(accounting.reserved_today))),
      maxCycleUsd: config.MAX_CYCLE_USD,
      availableTiers: machines.map(machine => machine.price),
    });
    Object.assign(state, {
      ready: true, balance: asUsd(usdc + cardsValue), fees10m: asUsd(accounting.fees_recent),
      reserved: asUsd(accounting.reserved), nextDropAt: plan.nextDropAtMs,
      budgetUsd: plan.budgetUsd, cadenceMinutes: plan.cadenceMinutes, lastUpdatedAt: nowMs, refundsVerifiedUsd: asUsd(accounting.refunds_total),
    });
    return plan;
  }

  async function reservePlan(client, plan, nowMs) {
    if (!plan.eligible) return;
    const id = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query('INSERT INTO cards_provider_drops(id,created_at,plan) VALUES($1,$2,$3)', [id, nowMs, JSON.stringify(plan)]);
      let index = 0;
      for (const pack of plan.packs) {
        for (let count = 0; count < pack.quantity; count++) {
          await client.query("INSERT INTO cards_provider_reservations(id,drop_id,tier,status,created_at) VALUES($1,$2,$3,'pending',$4)", [`${id}:${index++}`, id, pack.tierUsd, nowMs]);
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    state.reserved += plan.spendUsd;
  }

  return {
    status: state,
    async tick() {
      return await withLock(async client => {
        state.error = null;
        try {
          await settleReservations();
          await reconcileFees();
          const nowMs = now();
          const plan = await treasurySnapshot(nowMs);
          await reservePlan(client, plan, nowMs);
          await settleReservations();
        } catch {
          state.ready = false;
          state.error = 'Treasury reconciliation is unavailable; new drops are paused';
        }
        await refreshRecoveryStatus();
        return await fundedInventory();
      }) ?? [];
    },
    async award({ id, mint, wallet }) {
      if (typeof id !== 'string' || !id || id.length > 128 || typeof mint !== 'string' || typeof wallet !== 'string') throw new ReviewRequired('Invalid award intent');
      try { new PublicKey(mint); new PublicKey(wallet); } catch { throw new ReviewRequired('Invalid award address'); }
      return await withLock(async () => {
        const prize = (await pool.query('SELECT * FROM cards_provider_prizes WHERE id=$1', [id])).rows[0];
        if (!prize || prize.mint !== mint) throw new ReviewRequired('Award does not match a funded collectible');
        let award = (await pool.query('SELECT * FROM cards_provider_awards WHERE prize_id=$1', [id])).rows[0];
        if (award && (award.wallet !== wallet || award.mint !== mint)) throw new ReviewRequired('Award recipient cannot change during recovery');
        if (award?.status === 'confirmed') return { status: 'confirmed', signature: award.signature };
        if (!award) {
          // Reserve the recipient before any fallible eligibility/RPC call.
          await pool.query("INSERT INTO cards_provider_awards(prize_id,wallet,mint,status,created_at) VALUES($1,$2,$3,'pending',$4)", [id, wallet, mint, now()]);
          award = { recovery: {} };
        }
        if (!recoveryDue(award.recovery, now())) return recoveryResult(award.recovery);
        const attempt = beginRecoveryAttempt(award.recovery, now());
        await pool.query('UPDATE cards_provider_awards SET recovery=$2,status=$3 WHERE prize_id=$1', [id, JSON.stringify(attempt), 'pending']);
        try {
          // An already signed transaction must be reconciled even if the holder
          // subsequently sells tokens. Before first signing, eligibility applies.
          const transfer = await jobs.get(`award:${id}`);
          if (!transfer?.data?.signature) {
            const eligibility = await chain.eligibility(wallet);
            if (!eligibility.eligible) throw new PendingOperation('Winner no longer eligible', 'eligibility_pending');
          }
          const signature = await chain.transferNft(`award:${id}`, mint, wallet, settings);
          // transferNft reconciles the persisted, recipient-pinned signed
          // transaction. The winner may already have forwarded their asset;
          // current custody must not undo proof of a completed award.
          await pool.query("UPDATE cards_provider_awards SET status='confirmed',signature=$2,recovery=$3 WHERE prize_id=$1", [id, signature, JSON.stringify(finishRecoveryAttempt(attempt, 'confirmed', now()))]);
          await pool.query("UPDATE cards_provider_prizes SET status='awarded' WHERE id=$1", [id]);
          return { status: 'confirmed', signature };
        } catch (error) {
          const recovery = finishRecoveryAttempt(attempt, error, now());
          await pool.query('UPDATE cards_provider_awards SET recovery=$2,status=$3 WHERE prize_id=$1', [id, JSON.stringify(recovery), recovery.state === 'quarantined' ? 'quarantined' : 'pending']);
          return recoveryResult(recovery);
        }
      }) ?? { status: 'pending', reason: 'Treasury is reconciling another operation', code: 'provider_busy', nextAttemptAt: now() + 15_000 };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (activeOperations) await new Promise(resolve => { resolveDrained = resolve; });
      await authorityClient.query('SELECT pg_advisory_unlock($1)', [AUTHORITY_LOCK_ID]).catch(() => {});
      authorityClient.release();
      await pool.end();
    },
  };
}
