import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../server/provider.mjs';
import { createDropWorker } from '../server/drop-worker.mjs';
import { eligible } from '../server/integrations/rules.mjs';
import { configure } from '../server/integrations/config.mjs';
import { Chain, validateRefundEvidence } from '../server/integrations/chain.mjs';
import { Providers } from '../server/integrations/providers.mjs';
import { PendingOperation, ReviewRequired, PurchaseRefunded } from '../server/integrations/jobs.mjs';
import { beginRecoveryAttempt, finishRecoveryAttempt, recoveryDue } from '../server/integrations/recovery.mjs';
import { Game } from '../server/game.mjs';
import bs58 from 'bs58';
import { validatePackPayment } from '../server/integrations/pack-policy.mjs';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';

test('missing configuration returns an offline adapter and no prizes or fabricated accounting', async () => {
  const provider = await createProvider({ env: {} });
  assert.equal(provider.status.enabled, false);
  assert.equal(provider.status.ready, false);
  assert.equal(provider.status.balance, null);
  assert.equal(provider.status.fees10m, null);
  assert.ok(provider.status.blockers.includes('Configure MEMECOIN_MINT'));
  assert.deepEqual(await provider.tick(), []);
  assert.equal((await provider.award({})).status, 'pending');
  await provider.close();
});

test('an enable flag alone never starts the provider', async () => {
  const provider = await createProvider({ env: { MAINNET_ENABLED: 'true' } });
  assert.equal(provider.status.enabled, true);
  assert.equal(provider.status.ready, false);
  assert.deepEqual(await provider.tick(), []);
});

test('reference eligibility was upgraded to exact 0.25% with integer arithmetic', () => {
  assert.equal(eligible(['2499'], '1000000'), false);
  assert.equal(eligible(['2000', '500'], '1000000'), true);
  assert.equal(eligible(['2501'], '1000000'), true);
  assert.equal(eligible(['0'], '0'), false);
});

test('worker only delivers backed records and replays IDs for durable deduplication', async () => {
  const prize = { id: 'prize-1', mint: 'mint-1', purchaseSignature: 'confirmed-tx', tierUsd: 25 };
  const persisted = new Map();
  let attempts = 0;
  const provider = { status: { ready: true }, tick: async () => [prize] };
  const worker = createDropWorker({ provider, onPrize: async item => { attempts++; persisted.set(item.id, item); } });
  await worker.tick();
  await worker.tick();
  assert.equal(attempts, 2);
  assert.equal(persisted.size, 1);
  await worker.stop();
  await worker.tick();
  assert.equal(attempts, 2);
});

test('worker rejects inventory without settlement proof and retries after an ingestion error', async () => {
  let valid = false;
  const provider = { status: {}, tick: async () => [{ id: 'a', mint: 'b', tierUsd: 25, ...(valid ? { purchaseSignature: 'tx' } : {}) }] };
  let writes = 0;
  const worker = createDropWorker({ provider, onPrize: async () => { writes++; } });
  await assert.rejects(worker.tick(), /unverified/);
  assert.equal(writes, 0);
  valid = true;
  await worker.tick();
  assert.equal(writes, 1);
});

test('worker does not run overlapping purchase reconciliations', async () => {
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = { status: {}, async tick() { calls++; await gate; return []; } };
  const worker = createDropWorker({ provider, onPrize: async () => {} });
  const first = worker.tick();
  await worker.tick();
  assert.equal(calls, 1);
  release();
  await first;
});

test('pack signing accepts the exact $250 intent and rejects tampered payment, recipient, memo, or signature', () => {
  const treasury = Keypair.generate();
  const provider = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const wrong = Keypair.generate().publicKey;
  const amount = 250_000_000n;
  const memo = 'cc-00000000-0000-4000-8000-000000000000';
  function transaction({ paid = amount, recipient = provider.publicKey, paymentMemo = `${memo}:open`, tamper = false } = {}) {
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: provider.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, treasury.publicKey), mint, getAssociatedTokenAddressSync(mint, recipient), treasury.publicKey, paid, 6),
        new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [{ pubkey: provider.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(paymentMemo) }),
      ],
    }).compileToV0Message());
    tx.sign([provider]);
    if (tamper) tx.signatures[0][0] ^= 1;
    return tx;
  }
  const validate = tx => validatePackPayment(tx, treasury.publicKey, provider.publicKey, mint, amount, memo);
  assert.doesNotThrow(() => validate(transaction()));
  for (const options of [{ paid: amount + 1n }, { recipient: wrong }, { paymentMemo: `${memo}:turbo` }, { tamper: true }]) {
    assert.throws(() => validate(transaction(options)), ReviewRequired);
  }
});

test('transaction execution persists a signature before broadcast and recovers it without rebuilding or paying twice', async () => {
  configure({ MAINNET_ENABLED: 'true', SOLANA_RPC_URL: 'https://example.invalid' });
  const entries = new Map();
  const jobs = {
    async get(id) { return entries.get(id); },
    async put(id, kind, status, data) { entries.set(id, { id, kind, status, data, updated_at: Date.now() }); },
  };
  const signer = Keypair.generate();
  let confirmed = false;
  let broadcasts = 0;
  let builds = 0;
  const rpc = {
    async getSignatureStatuses() { return { value: [confirmed ? { err: null, confirmationStatus: 'confirmed' } : null] }; },
    async isBlockhashValid() { return { value: true }; },
    async sendRawTransaction() {
      broadcasts++;
      assert.equal(entries.get('fixture-transfer').status, 'prepared');
      assert.ok(entries.get('fixture-transfer').data.signature);
      assert.ok(entries.get('fixture-transfer').data.raw);
    },
  };
  const makeChain = () => { const chain = new Chain(jobs); chain.signer = signer; chain.connection = rpc; return chain; };
  const build = async () => {
    builds++;
    return new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message());
  };
  await assert.rejects(makeChain().execute('fixture-transfer', 'nft-transfer', build, {}), PendingOperation);
  const savedSignature = entries.get('fixture-transfer').data.signature;
  confirmed = true;
  assert.equal(await makeChain().execute('fixture-transfer', 'nft-transfer', build, {}), savedSignature);
  assert.equal(await makeChain().execute('fixture-transfer', 'nft-transfer', build, {}), savedSignature);
  assert.equal(broadcasts, 1);
  assert.equal(builds, 1);
  configure({});
});

test('provider reserves available tiers before purchase, waits for custody, replays inventory, and pins recoverable awards', async () => {
  const treasury = Keypair.generate().publicKey.toBase58();
  const coin = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  const winner = Keypair.generate().publicKey.toBase58();
  let database;
  let purchasePending = true;
  let transferPending = true;
  let transferCalls = 0;
  let purchases = 0;
  let clock = Date.now();
  let quarantinedPurchase;
  let winnerEligible = true;
  let transferUnsafe = false;
  let feesUnavailable = false;
  class MemoryPool {
    constructor() {
      database = this;
      this.reservations = new Map(); this.prizes = new Map(); this.awards = new Map(); this.drops = []; this.jobs = new Map();
      this.spent = 0;
    }
    on() {}
    async end() {}
    async connect() { return { query: this.query.bind(this), release() {} }; }
    async query(sql, args = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      const result = rows => ({ rows });
      if (text.startsWith('CREATE TABLE') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return result([]);
      if (text.includes('pg_try_advisory_lock')) return result([{ locked: true }]);
      if (text.includes('pg_advisory_unlock')) return result([]);
      if (text.startsWith('INSERT INTO cards_provider_identity')) { this.identity = { coin_mint: args[0], treasury_wallet: args[1] }; return result([]); }
      if (text.startsWith('SELECT coin_mint,treasury_wallet')) return result([this.identity]);
      if (text.startsWith('SELECT * FROM cards_provider_jobs')) return result(this.jobs.has(args[0]) ? [this.jobs.get(args[0])] : []);
      if (text.startsWith('INSERT INTO cards_provider_jobs')) { this.jobs.set(args[0], { id: args[0], kind: args[1], status: args[2], data: JSON.parse(args[3]), updated_at: args[4] }); return result([]); }
      if (text.startsWith('SELECT * FROM cards_provider_reservations')) return result([...this.reservations.values()].filter(row => ['pending', 'review'].includes(row.status) && recoveryDue(row.recovery, args[0])));
      if (text.includes('AS purchases_pending')) return result([{ purchases_pending: [...this.reservations.values()].filter(r => r.status === 'pending').length, purchases_quarantined: [...this.reservations.values()].filter(r => r.status === 'quarantined').length, purchases_refunded: [...this.reservations.values()].filter(r => r.status === 'refunded').length, awards_quarantined: [...this.awards.values()].filter(r => r.status === 'quarantined').length }]);
      if (text.startsWith('SELECT COUNT(*)')) return result([{ count: 0 }]);
      if (text.includes('AS fees_total')) {
        const reserved = [...this.reservations.values()].filter(row => row.status !== 'complete').reduce((sum, row) => sum + row.tier * 1_000_000, 0);
        return result([{ fees_total: '1000000000', fees_recent: '126000000', spent_total: String(this.spent), spent_today: String(this.spent), refunds_total: '0', refunds_today: '0', reserved: String(reserved), reserved_today: String(reserved), last_drop: this.drops.at(-1)?.created_at ?? null, last_250: null, last_500: null }]);
      }
      if (text.startsWith('INSERT INTO cards_provider_drops')) { this.drops.push({ id: args[0], created_at: args[1], plan: JSON.parse(args[2]) }); return result([]); }
      if (text.startsWith('INSERT INTO cards_provider_reservations')) { this.reservations.set(args[0], { id: args[0], tier: args[2], status: 'pending', created_at: args[3] }); return result([]); }
      if (text.startsWith('UPDATE cards_provider_prizes SET data')) { this.prizes.get(args[0]).data = JSON.parse(args[1]); return result([]); }
      if (text.startsWith('UPDATE cards_provider_reservations SET recovery')) { Object.assign(this.reservations.get(args[0]), { recovery: JSON.parse(args[1]), status: args[2] }); return result([]); }
      if (text.startsWith("UPDATE cards_provider_reservations SET status='complete'")) { Object.assign(this.reservations.get(args[0]), { status: 'complete', recovery: JSON.parse(args[2]) }); return result([]); }
      if (text.startsWith('SELECT p.data FROM cards_provider_prizes')) return result([...this.prizes.values()].filter(row => row.status === 'available' && row.data.tierUsd && !this.awards.has(row.id)).map(row => ({ data: row.data })));
      if (text.startsWith('SELECT * FROM cards_provider_prizes')) return result(this.prizes.has(args[0]) ? [this.prizes.get(args[0])] : []);
      if (text.startsWith('SELECT * FROM cards_provider_awards')) return result(this.awards.has(args[0]) ? [this.awards.get(args[0])] : []);
      if (text.startsWith('INSERT INTO cards_provider_awards')) { this.awards.set(args[0], { prize_id: args[0], wallet: args[1], mint: args[2], status: 'pending' }); return result([]); }
      if (text.startsWith('UPDATE cards_provider_awards SET recovery')) { Object.assign(this.awards.get(args[0]), { recovery: JSON.parse(args[1]), status: args[2] }); return result([]); }
      if (text.startsWith("UPDATE cards_provider_awards SET status='confirmed'")) { Object.assign(this.awards.get(args[0]), { status: 'confirmed', signature: args[1], recovery: JSON.parse(args[2]) }); return result([]); }
      if (text.startsWith("UPDATE cards_provider_prizes SET status='awarded'")) { this.prizes.get(args[0]).status = 'awarded'; return result([]); }
      throw new Error(`Unexpected test SQL: ${text}`);
    }
  }
  class MemoryChain {
    address = treasury;
    rpc = { ok: true };
    async init() {}
    async health() {}
    async balance(mint) { return mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? BigInt(5_000_000_000 - database.spent) : mint === 'So11111111111111111111111111111111111111112' ? 1_000_000_000n : 0n; }
    async eligibility() { return { eligible: winnerEligible }; }
    async ownsNft() { return false; } // A winner may forward an already-delivered collectible.
    async transferNft(id, mint, wallet) {
      transferCalls++;
      const record = database.awards.get(id.slice('award:'.length));
      assert.equal(record.wallet, wallet, 'recipient intent must be durable before signing');
      assert.equal(record.mint, mint);
      if (transferUnsafe) throw new ReviewRequired('fixture changed NFT intent');
      if (transferPending) throw new PendingOperation('fixture awaiting confirmation');
      return 'fixture-confirmed-transfer';
    }
  }
  class MemoryProviders {
    async collectFees() { if (feesUnavailable) throw new Error('fixture transient fee RPC outage'); }
    async machines() { return [{ price: 25 }]; }
    async purchase(id, tier) {
      assert.equal(database.reservations.get(id).tier, tier, 'money must be reserved before purchase');
      if (purchasePending) throw new PendingOperation('fixture waiting for payment/custody');
      if (id === quarantinedPurchase) throw new ReviewRequired('fixture tampered pack recipient');
      purchases++;
      const prize = { id: `prize:${id}`, mint: Keypair.generate().publicKey.toBase58(), coinMint: coin, name: 'Fixture collectible', image: '', value: 0, purchaseSignature: `fixture-purchase:${id}` };
      database.spent += tier * 1_000_000;
      database.prizes.set(prize.id, { id: prize.id, mint: prize.mint, data: prize, status: 'available' });
      return prize;
    }
  }
  const provider = await createProvider({
    env: { MAINNET_ENABLED: 'true', MEMECOIN_MINT: coin, TREASURY_PRIVATE_KEY: 'fixture-never-parsed', DATABASE_URL: 'postgresql://fixture.invalid/test', SOLANA_RPC_URL: 'https://fixture.invalid', JUPITER_API_KEY: 'fixture', COLLECTOR_CRYPT_PAYMENT_WALLET: recipient },
    runtime: { Pool: MemoryPool, Chain: MemoryChain, Providers: MemoryProviders, now: () => clock },
  });
  assert.deepEqual(await provider.tick(), [], 'pending purchases cannot become gameplay prizes');
  assert.equal(database.drops.length, 1);
  assert.ok(database.reservations.size > 0);
  assert.ok([...database.reservations.values()].every(row => row.tier === 25));
  purchasePending = false;
  quarantinedPurchase = [...database.reservations.keys()][0];
  assert.deepEqual(await provider.tick(), [], 'persisted backoff prevents an immediate retry');
  clock += 15_000;
  const inventory = await provider.tick();
  assert.equal(inventory.length, database.reservations.size - 1);
  assert.equal(provider.status.ready, true);
  assert.equal(provider.status.recovery.purchasesQuarantined, 1);
  assert.equal(database.reservations.get(quarantinedPurchase).status, 'quarantined');
  assert.equal(provider.status.reserved, 25, 'unsafe unsent order retains its budget obligation');
  assert.deepEqual(await provider.tick(), inventory, 'inventory must survive a game-ingest crash');
  assert.equal(purchases, inventory.length, 'reconciliation must not purchase again');
  const intent = { id: inventory[0].id, mint: inventory[0].mint, wallet: winner };
  assert.equal((await provider.award(intent)).status, 'pending');
  await assert.rejects(provider.award({ ...intent, wallet: recipient }), /recipient cannot change/);
  transferPending = false;
  assert.equal((await provider.award(intent)).status, 'pending');
  assert.equal(transferCalls, 1, 'award polling respects the persisted retry deadline');
  clock += 15_000;
  assert.deepEqual(await provider.award(intent), { status: 'confirmed', signature: 'fixture-confirmed-transfer' });
  assert.deepEqual(await provider.award(intent), { status: 'confirmed', signature: 'fixture-confirmed-transfer' });
  assert.equal(transferCalls, 2, 'confirmed award must not re-enter transfer execution');
  assert.equal((await provider.tick()).length, inventory.length - 1);
  const secondIntent = { id: inventory[1].id, mint: inventory[1].mint, wallet: winner };
  winnerEligible = false;
  const ineligible = await provider.award(secondIntent);
  assert.equal(ineligible.code, 'eligibility_pending');
  assert.equal(database.awards.get(secondIntent.id).wallet, winner, 'eligibility outages must retain the original recipient');
  assert.equal(transferCalls, 2, 'ineligible winner cannot start an unsigned transfer');
  winnerEligible = true;
  transferUnsafe = true;
  clock += 60_000;
  assert.equal((await provider.award(secondIntent)).status, 'quarantined');
  const unsafeCalls = transferCalls;
  clock += 600_000;
  assert.equal((await provider.award(secondIntent)).status, 'quarantined');
  assert.equal(transferCalls, unsafeCalls, 'quarantine never bypasses intent validation or silently retries');
  feesUnavailable = true;
  await provider.tick();
  assert.equal(database.drops.length, 2, 'one quarantined purchase must not freeze unrelated funded drops');
  assert.equal(provider.status.ready, true);
  assert.equal(provider.status.feeRecovery.state, 'retrying', 'fee outages are recorded and retried independently');
  assert.equal(provider.status.recovery.awardsQuarantined, 1);
  await provider.close();
  configure({});
});

test('a second game authority cannot open the same prize database', async () => {
  const treasury = Keypair.generate().publicKey.toBase58();
  let released = false;
  let ended = false;
  class ContendedPool {
    on() {}
    async connect() { return { query: async () => ({ rows: [{ locked: false }] }), release() { released = true; } }; }
    async end() { ended = true; }
  }
  class MemoryChain { address = treasury; async init() {} }
  await assert.rejects(createProvider({
    env: { MAINNET_ENABLED: 'true', MEMECOIN_MINT: treasury, TREASURY_PRIVATE_KEY: 'fixture-not-parsed', DATABASE_URL: 'postgresql://fixture.invalid/db', SOLANA_RPC_URL: 'https://fixture.invalid', JUPITER_API_KEY: 'fixture', COLLECTOR_CRYPT_PAYMENT_WALLET: treasury },
    runtime: { Pool: ContendedPool, Chain: MemoryChain },
  }), /Another game authority/);
  assert.equal(released, true);
  assert.equal(ended, true);
  configure({});
});

test('recovery persists bounded attempts, backs off outages, and never turns unsafe intent into an automatic retry', () => {
  let state = {};
  let clock = 1000;
  for (let index = 0; index < 20; index++) {
    state = finishRecoveryAttempt(beginRecoveryAttempt(state, clock), new Error('https://provider.invalid?secret=DO_NOT_STORE'), clock);
    assert.equal(recoveryDue(state, state.nextAttemptAt - 1), false);
    assert.equal(recoveryDue(state, state.nextAttemptAt), true);
    assert.ok(state.nextAttemptAt - clock <= 300_000);
    clock = state.nextAttemptAt;
  }
  assert.equal(state.attempts, 20);
  assert.equal(state.history.length, 12);
  assert.equal(JSON.stringify(state).includes('DO_NOT_STORE'), false);
  const ambiguous = finishRecoveryAttempt(beginRecoveryAttempt(state, clock), new PendingOperation('external status', 'payment_ambiguous'), clock);
  assert.equal(ambiguous.nextAttemptAt, clock + 60_000);
  assert.match(ambiguous.reason, /no replacement payment/);
  const quarantined = finishRecoveryAttempt(beginRecoveryAttempt(state, clock), new ReviewRequired('tampered recipient'), clock);
  assert.equal(recoveryDue(quarantined, clock + 999_999_999), false);
  assert.equal(quarantined.state, 'quarantined');
  const refunded = finishRecoveryAttempt(beginRecoveryAttempt(state, clock), new PurchaseRefunded({ signature: 'proof' }), clock);
  assert.equal(recoveryDue(refunded, clock + 999_999_999), false);
  assert.equal(refunded.code, 'refund_verified');
});

function refundFixture() {
  const treasury = Keypair.generate().publicKey.toBase58();
  const provider = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const source = Keypair.generate().publicKey.toBase58();
  const destination = Keypair.generate().publicKey.toBase58();
  const row = (accountIndex, owner, amount) => ({ accountIndex, owner, mint, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const transaction = {
    slot: 103,
    transaction: { message: { accountKeys: [{ pubkey: source }, { pubkey: destination }], instructions: [
      { programId: TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info: { source, destination, authority: provider, mint, tokenAmount: { amount: '25000000', decimals: 6 } } } },
    ] } },
    meta: { err: null, preTokenBalances: [row(0, provider, 90_000_000), row(1, treasury, 10_000_000)],
      postTokenBalances: [row(0, provider, 65_000_000), row(1, treasury, 35_000_000)], innerInstructions: [] },
  };
  return { transaction, paymentSlot: 100, treasury, provider, mint, amount: 25_000_000n };
}

test('refund settlement requires successful actual USDC movement from the pinned recipient into treasury', () => {
  const fixture = refundFixture();
  assert.deepEqual(validateRefundEvidence(fixture), { amountMicros: '25000000', receivedMicros: '25000000', slot: 103 });
  const validateMutation = mutate => {
    const copy = structuredClone(fixture);
    // PublicKey is not preserved by structuredClone; parsed RPC returns strings.
    copy.transaction.transaction.message.instructions[0].programId = TOKEN_PROGRAM_ID.toBase58();
    mutate(copy);
    assert.throws(() => validateRefundEvidence(copy), ReviewRequired);
  };
  validateMutation(copy => { copy.transaction.meta.err = { InstructionError: [0, 'failure'] }; });
  validateMutation(copy => { copy.transaction.slot = 99; });
  validateMutation(copy => { copy.mint = Keypair.generate().publicKey.toBase58(); });
  validateMutation(copy => { copy.transaction.transaction.message.instructions = []; });
  validateMutation(copy => { copy.transaction.transaction.message.instructions[0].parsed.info.authority = copy.treasury; });
  validateMutation(copy => { copy.transaction.meta.postTokenBalances[1].uiTokenAmount.amount = '34999999'; });
  validateMutation(copy => { copy.transaction.transaction.message.instructions[0].parsed.info.destination = copy.transaction.transaction.message.instructions[0].parsed.info.source; });
});

test('a provider refund signature remains pending until RPC confirms and exposes complete payment and refund evidence', async () => {
  configure({ MAINNET_ENABLED: 'true', SOLANA_RPC_URL: 'https://fixture.invalid' });
  const fixture = refundFixture();
  const signer = Keypair.generate();
  fixture.treasury = signer.publicKey.toBase58();
  fixture.transaction.meta.preTokenBalances[1].owner = fixture.treasury;
  fixture.transaction.meta.postTokenBalances[1].owner = fixture.treasury;
  const chain = new Chain({});
  chain.signer = signer;
  let confirmed = false;
  let complete = false;
  chain.connection = {
    getSignatureStatuses: async () => ({ value: [confirmed ? { err: null, confirmationStatus: 'confirmed' } : null] }),
    getParsedTransaction: async () => complete ? fixture.transaction : null,
    getTransaction: async () => ({ slot: 100, meta: { err: null } }),
  };
  const intent = { signature: bs58.encode(new Uint8Array(64).fill(3)), paymentSignature: bs58.encode(new Uint8Array(64).fill(4)), recipient: fixture.provider, mint: fixture.mint, amount: fixture.amount };
  await assert.rejects(chain.verifyRefund(intent), error => error.code === 'refund_pending');
  confirmed = true;
  await assert.rejects(chain.verifyRefund(intent), error => error.code === 'refund_pending');
  complete = true;
  assert.equal((await chain.verifyRefund(intent)).amountMicros, '25000000');
  await assert.rejects(chain.verifyRefund({ ...intent, signature: intent.paymentSignature }), ReviewRequired);
  configure({});
});

test('refund ledger never credits an API-only claim and credits verified recovery exactly once', async () => {
  const records = new Map();
  let verifications = 0;
  let confirmed = false;
  const proof = { signature: 'fixture-verified-refund', slot: 103, amountMicros: '25000000', receivedMicros: '25000000' };
  const chain = { async verifyRefund(intent) { verifications++; assert.equal(intent.amount, 25_000_000n); if (!confirmed) throw new PendingOperation('not confirmed', 'refund_pending'); return proof; } };
  const db = { async query(sql, args) {
    if (sql.startsWith('SELECT')) return { rows: records.has(args[0]) ? [records.get(args[0])] : [] };
    assert.match(sql, /IS DISTINCT FROM 'true'/);
    if ([...records.values()].some(row => row.signature === args[2] && row.id !== args[0])) throw Object.assign(new Error('duplicate'), { code: '23505' });
    records.set(args[0], { id: args[0], amount_micros: args[1], signature: args[2], data: JSON.parse(args[4]) });
    return { rows: [] };
  } };
  const provider = new Providers(chain, { db });
  const data = { paymentSignature: 'fixture-payment', memo: 'same-order' };
  await assert.rejects(provider.recordRefund('pack:a', data, 25, proof.signature), PendingOperation);
  assert.equal(records.size, 0);
  records.set('pack:a:refund', { id: 'pack:a:refund', amount_micros: 25_000_000, signature: null, data: {} }); // legacy unverified row
  confirmed = true;
  assert.deepEqual(await provider.recordRefund('pack:a', data, 25, proof.signature), proof);
  assert.equal(records.get('pack:a:refund').data.verified, true);
  assert.deepEqual(await provider.recordRefund('pack:a', data, 25, proof.signature), proof);
  assert.equal(verifications, 2, 'persisted proof survives a crash before the pack job is marked refunded');
  await assert.rejects(provider.recordRefund('pack:b', data, 25, proof.signature), ReviewRequired);
  assert.equal(records.size, 1, 'the same transaction cannot restore two pack budgets');
  await assert.rejects(provider.recordRefund('pack:a', { ...data, paymentSignature: 'changed' }, 25, proof.signature), ReviewRequired);
});

test('ambiguous expired pack orders only poll the same memo and never generate another payment', async () => {
  const signer = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message());
  const chain = { address: signer.publicKey.toBase58(), require: () => ({ rpc: { isBlockhashValid: async () => ({ value: false }) } }) };
  let writes = 0;
  const provider = new Providers(chain, { get: async () => null, put: async () => { writes++; } });
  const calls = [];
  let status = {};
  provider.cc = async path => { calls.push(path); assert.match(path, /^\/pack\/status\?memo=original-order$/); return status; };
  const data = { transaction: Buffer.from(transaction.serialize()).toString('base64'), memo: 'original-order' };
  await assert.rejects(provider.packPayment('pack:fixture', data, 25), error => error instanceof PendingOperation && error.code === 'payment_ambiguous');
  status = { pack: { status: 'paid', transaction_signature: 'existing-payment' }, send: null };
  await assert.rejects(provider.packPayment('pack:fixture', data, 25), error => error.code === 'payment_ambiguous');
  assert.equal(data.memo, 'original-order');
  assert.equal(writes, 0);
  assert.equal(calls.length, 2);
});

test('a confirmed refund terminates the original purchase and later polls never create a replacement order', async () => {
  const records = new Map([
    ['pack:round', { status: 'opening', data: { tier: 25, funded: true, memo: 'paid-order', paymentSignature: 'confirmed-payment' } }],
    ['pack:round:payment', { status: 'confirmed', data: { signature: 'confirmed-payment' } }],
  ]);
  let refundConfirmed = false;
  let statusCalls = 0;
  let refundChecks = 0;
  const jobs = {
    get: async id => records.get(id),
    put: async (id, kind, status, data) => { records.set(id, { kind, status, data: structuredClone(data) }); },
    db: { query: async sql => { assert.match(sql, /^INSERT INTO ledger/); return { rows: [] }; } },
  };
  const provider = new Providers({}, jobs);
  provider.cc = async path => { statusCalls++; assert.equal(path, '/pack/status?memo=paid-order'); return { pack: { refunded: true, refund_transaction_signature: 'refund-proof' } }; };
  provider.recordRefund = async () => { refundChecks++; if (!refundConfirmed) throw new PendingOperation('awaiting chain', 'refund_pending'); return { signature: 'refund-proof' }; };
  await assert.rejects(provider.purchase('round', 25, {}), error => error.code === 'refund_pending');
  assert.equal(records.get('pack:round').status, 'opening');
  refundConfirmed = true;
  await assert.rejects(provider.purchase('round', 25, {}), PurchaseRefunded);
  assert.equal(records.get('pack:round').status, 'refunded');
  await assert.rejects(provider.purchase('round', 25, {}), PurchaseRefunded);
  assert.equal(statusCalls, 2);
  assert.equal(refundChecks, 2);
  await assert.rejects(provider.purchase('round', 50, {}), ReviewRequired);
});

test('delivery retry deadlines, reasons and quarantine survive game restart without changing the winner', () => {
  let saved = { version: 1, packs: [], accounts: { winner: { collection: [{ id: 'prize', status: 'pending_transfer' }] } }, awards: [{ id: 'prize', wallet: 'winner', mint: 'mint', status: 'pending' }] };
  const store = { load: () => structuredClone(saved), save: state => { saved = structuredClone(state); } };
  const game = new Game({ now: 1000, store });
  game.markAward('prize', { status: 'pending', code: 'confirmation_pending', reason: 'Waiting for confirmation.', attempts: 2, lastAttemptAt: 1000, nextAttemptAt: 16_000, history: [{ at: 1000, state: 'retrying' }], wallet: 'attacker', mint: 'changed' });
  const restarted = new Game({ now: 2000, store });
  assert.equal(restarted.pendingAwards(15_999).length, 0);
  assert.equal(restarted.pendingAwards(16_000)[0].wallet, 'winner');
  assert.equal(restarted.pendingAwards(16_000)[0].mint, 'mint');
  assert.equal(restarted.accounts.winner.collection[0].attempts, 2);
  restarted.markAward('prize', { status: 'quarantined', reason: 'Unsafe intent.', code: 'intent_quarantined' });
  assert.equal(new Game({ now: 99999, store }).pendingAwards().length, 0);
  assert.equal(saved.accounts.winner.collection[0].status, 'delivery_quarantined');
});
