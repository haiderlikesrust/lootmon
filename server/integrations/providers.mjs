// Adapted from the user-owned grailshot reference project. No runtime configuration was copied.
import { randomUUID } from 'node:crypto';
import { PublicKey, SystemProgram, ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createRequire } from 'node:module';
const { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, normalizeQuoteMint } = createRequire(import.meta.url)('@pump-fun/pump-sdk');
import { PendingOperation, ReviewRequired, PurchaseRefunded } from './jobs.mjs';
import { config } from './config.mjs';
import { PACK_TIERS } from './rules.mjs';
import { fetchMetadata } from './remote-metadata.mjs';
export async function jsonFetch(url, init = {}) { const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }); const body = await response.json(); if (!response.ok)
    throw new Error(body.error || body.message || `Provider returned HTTP ${response.status}`); return body; }
const CC = 'https://gacha.collectorcrypt.com';
const JUP = 'https://api.jup.ag/swap/v2';
function quoteOutput(quote, inputMint, outputMint, amount, requestedAt) {
    if (Date.now() - requestedAt > 10_000 || quote?.errorCode)
        throw new Error('An executable current valuation is unavailable.');
    if (quote?.inputMint !== inputMint || quote?.outputMint !== outputMint
        || String(quote?.inAmount) !== amount.toString() || !/^\d+$/.test(String(quote?.outAmount))
        || BigInt(quote.outAmount) <= 0n)
        throw new ReviewRequired('Valuation asset or amount does not match the reserved intent.');
    return BigInt(quote.outAmount);
}
export class Providers {
    chain;
    jobs;
    buybackCache = new Map();
    constructor(chain, jobs) {
        this.chain = chain;
        this.jobs = jobs;
    }
    buybackQuote(mint) {
        const cached = this.buybackCache.get(mint);
        if (cached && cached.expires > Date.now())
            return cached.quote;
        if (this.buybackCache.size >= 128)
            this.buybackCache.delete(this.buybackCache.keys().next().value);
        const quote = (async () => {
            try {
                const result = await this.cc(`/buyback/available?nft=${encodeURIComponent(mint)}`);
                if (result.available === false)
                    return { status: 'unavailable', amount: null, checkedAt: Date.now() };
                const amount = Number(result.amount);
                if (result.available !== true || !Number.isSafeInteger(amount) || amount < 10_000 || amount > 280_000_000_000)
                    throw new Error('Invalid buyback quote');
                return { status: 'available', amount: amount / 1e6, checkedAt: Date.now() };
            }
            catch {
                return { status: 'error', amount: null, checkedAt: Date.now() };
            }
        })();
        this.buybackCache.set(mint, { expires: Date.now() + 60_000, quote });
        return quote;
    }
    cc(path, data) { return jsonFetch(`${CC}/api${path}`, { method: data ? 'POST' : 'GET', headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(config.COLLECTOR_CRYPT_API_KEY ? { 'x-api-key': config.COLLECTOR_CRYPT_API_KEY } : {}) }, body: data ? JSON.stringify(data) : undefined }); }
    async machines() { const [catalog, status] = await Promise.all([this.cc('/machines'), this.cc('/status')]); if (status.machineStatus !== 'running')
        return []; return catalog.machines.filter((m) => m.public && PACK_TIERS.includes(m.price) && m.code === `pokemon_${m.price}` && m.contains === 1 && Object.values(m.stock ?? {}).length > 0 && Object.values(m.stock ?? {}).every((n) => Number.isFinite(n) && n > 0) && status.gachas?.some((s) => s.code === m.code && s.isOpen)); }
    quote(inputMint, outputMint, amount, taker, slippageBps = 100) { return jsonFetch(`${JUP}/order?${new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), excludeRouters: 'jupiterz,dflow,okx', ...(taker ? { taker } : {}) })}`, { headers: { 'x-api-key': config.JUPITER_API_KEY } }); }
    async tokenDelta(signature, mint) {
        const { rpc, signer } = this.chain.require();
        const tx = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx || !tx.meta)
            throw new PendingOperation('Waiting for transaction accounting.');
        if (tx.meta.err)
            throw new ReviewRequired('Transaction failed.');
        if (mint === NATIVE_MINT.toBase58()) {
            const index = tx.transaction.message.staticAccountKeys.findIndex(k => k.equals(signer.publicKey));
            if (index < 0)
                return 0n;
            return BigInt(tx.meta.postBalances[index] - tx.meta.preBalances[index] + (index === 0 ? tx.meta.fee : 0));
        }
        const sum = (rows) => rows.filter(a => a.owner === this.chain.address && a.mint === mint).reduce((s, a) => s + BigInt(a.uiTokenAmount.amount), 0n);
        return sum(tx.meta.postTokenBalances ?? []) - sum(tx.meta.preTokenBalances ?? []);
    }
    async swap(id, inputMint, outputMint, amount, settings, minOutput = 1n) {
        if (amount <= 0n)
            throw new Error('Swap amount must be positive.');
        let job = await this.jobs.get(id);
        if (!job)
            await this.jobs.put(id, 'swap', 'queued', { inputMint, outputMint, amount: amount.toString(), minOutput: minOutput.toString() });
        job = await this.jobs.get(id);
        const d = job.data;
        if (d.inputMint !== inputMint || d.outputMint !== outputMint || d.amount !== amount.toString())
            throw new ReviewRequired('Swap intent changed during recovery.');
        const policy = { kind: 'swap', inputMint, maxInput: amount, outputMint, minOutput };
        const signature = await this.chain.execute(id, 'swap', async () => { const requestedAt = Date.now(), order = await this.quote(inputMint, outputMint, amount, this.chain.address, settings.slippageBps); if (Date.now() - requestedAt > 10_000)
            throw new Error('Swap quote is stale. Retry with current pricing.'); if (order.errorCode || !order.transaction)
            throw new Error(order.errorMessage || 'No supported swap route.'); if (order.router !== 'metis' || order.inputMint !== inputMint || order.outputMint !== outputMint || BigInt(order.inAmount) !== amount)
            throw new ReviewRequired('Swap quote route, asset or amount mismatch.'); const guaranteed = BigInt(order.outAmount) * (10000n - BigInt(settings.slippageBps)) / 10000n; if (guaranteed < minOutput)
            throw new Error('Swap no longer funds the selected pack.'); if (BigInt(order.otherAmountThreshold ?? '0') < guaranteed || Number(order.slippageBps) > settings.slippageBps)
            throw new ReviewRequired('Swap exceeds the configured slippage ceiling.'); policy.minOutput = guaranteed; const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64')); if (tx.message.header.numRequiredSignatures !== 1)
            throw new ReviewRequired('Swap requires an unsupported co-signer.'); return tx; }, settings, policy);
        const received = await this.tokenDelta(signature, outputMint);
        if (received < minOutput)
            throw new ReviewRequired('Settled swap output is insufficient.');
        return { signature, received };
    }
    async collectFees(settings) {
        const { rpc, signer } = this.chain.require();
        if (config.FEE_RECIPIENT !== this.chain.address)
            throw new Error('The treasury signer must be the dedicated fee recipient.');
        const unfinished = (await this.jobs.db.query("SELECT * FROM jobs WHERE kind='fee-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];
        let cycle = unfinished;
        if (!cycle) {
            const mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc), curve = await sdk.fetchBondingCurve(mint);
            if (curve.isHolderReward)
                throw new Error('This mint routes fees to holder rewards, not its creator.');
            const quote = normalizeQuoteMint(curve.quoteMint), sharing = curve.creator.equals(feeSharingConfigPda(mint));
            if (!sharing && !curve.creator.equals(signer.publicKey))
                throw new Error('Configured wallet is not the mint’s creator-fee recipient.');
            if (sharing) {
                const info = await rpc.getAccountInfo(curve.creator);
                if (!info)
                    throw new Error('Fee sharing account is missing.');
                const shared = PUMP_SDK.decodeSharingConfig(info);
                if (!shared.shareholders.some(s => s.address.equals(signer.publicKey)))
                    throw new Error('Treasury is not a shareholder of this mint.');
            }
            const balances = await sdk.getCreatorVaultQuoteBalances(curve.creator), balance = balances.find(b => b.mint.equals(quote));
            if (!balance || balance.total.isZero())
                return;
            const id = `fees:${randomUUID()}`;
            await this.jobs.put(id, 'fee-cycle', 'claiming', { quoteMint: quote.toBase58(), creator: curve.creator.toBase58(), sharing, graduated: curve.complete });
            cycle = await this.jobs.get(id);
        }
        const d = cycle.data, quoteMint = new PublicKey(d.quoteMint), mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc);
        if (!d.claimSignature) {
            d.claimSignature = await this.chain.execute(`${cycle.id}:claim`, 'fee-claim', async () => { const quoteTokenProgram = await sdk.fetchQuoteTokenProgram(quoteMint); const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 })]; if (d.sharing) {
                const address = new PublicKey(d.creator), info = await rpc.getAccountInfo(address);
                if (!info)
                    throw new Error('Sharing configuration is missing.');
                const shared = PUMP_SDK.decodeSharingConfig(info);
                if (d.graduated)
                    ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer: signer.publicKey, mint, quoteMint, quoteTokenProgram }));
                ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig: shared, sharingConfigAddress: address, quoteMint, quoteTokenProgram, payer: signer.publicKey, shouldInitializeAta: true }));
            }
            else {
                if (!quoteMint.equals(NATIVE_MINT))
                    ixs.push(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, getAssociatedTokenAddressSync(quoteMint, signer.publicKey, false, quoteTokenProgram), signer.publicKey, quoteMint, quoteTokenProgram));
                ixs.push(...await sdk.collectCoinCreatorFeeV2Instructions(signer.publicKey, quoteMint, quoteTokenProgram, signer.publicKey));
            } return this.chain.build(ixs); }, settings);
            await this.jobs.put(cycle.id, 'fee-cycle', 'routing', d);
        }
        if (!d.amount) {
            const delta = await this.tokenDelta(d.claimSignature, d.quoteMint);
            d.amount = (delta > 0n ? delta : 0n).toString();
            await this.jobs.put(cycle.id, 'fee-cycle', 'routing', d);
        }
        if (BigInt(d.amount) === 0n) {
            await this.jobs.put(cycle.id, 'fee-cycle', 'complete', d);
            return;
        }
        if (!d.cardsAmount) {
            d.cardsAmount = d.quoteMint === config.CARDS_MINT ? d.amount : (await this.swap(`${cycle.id}:cards`, d.quoteMint, config.CARDS_MINT, BigInt(d.amount), settings)).received.toString();
            await this.jobs.put(cycle.id, 'fee-cycle', 'accounting', d);
        }
        const quotedAt = Date.now();
        const valuation = await this.quote(config.CARDS_MINT, config.USDC_MINT, BigInt(d.cardsAmount));
        const feeValue = quoteOutput(valuation, config.CARDS_MINT, config.USDC_MINT, BigInt(d.cardsAmount), quotedAt);
        await this.jobs.db.query("INSERT INTO ledger(id,kind,amount_micros,signature,created_at,data) VALUES($1,'fee',$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [cycle.id, feeValue.toString(), d.claimSignature, Number(cycle.created_at), JSON.stringify({ cardsAmount: d.cardsAmount })]);
        await this.jobs.put(cycle.id, 'fee-cycle', 'complete', d);
    }
    async purchase(roundId, tier, settings) {
        const id = `pack:${roundId}`;
        let job = await this.jobs.get(id);
        if (!PACK_TIERS.includes(tier) || (job && job.data.tier !== tier))
            throw new ReviewRequired('Pack tier changed during recovery.');
        if (job?.status === 'complete')
            return job.data.prize;
        if (job?.status === 'refunded') throw new PurchaseRefunded(job.data.refund);
        if (!job) {
            if (!(await this.machines()).some((m) => m.price === tier))
                throw new Error('Selected pack is temporarily unavailable.');
            await this.jobs.put(id, 'pack', 'funding', { tier });
            job = await this.jobs.get(id);
        }
        const d = job.data;
        if (d.tier !== tier || !PACK_TIERS.includes(tier))
            throw new ReviewRequired('Pack tier changed during recovery.');
        const paymentJob = await this.jobs.get(`${id}:payment`);
        const checkCap = async () => {
            const day = new Date();
            day.setUTCHours(0, 0, 0, 0);
            const spent = BigInt((await this.jobs.db.query(`SELECT (
                COALESCE((SELECT SUM(amount_micros) FROM ledger WHERE kind='pack' AND created_at>=$1),0)
                - COALESCE((SELECT SUM(r.amount_micros) FROM ledger r JOIN ledger p ON p.id=r.data->>'purchaseId'
                  WHERE r.kind='refund' AND r.data->>'verified'='true' AND p.kind='pack' AND p.created_at>=$1),0)
                )::text AS amount`, [day.getTime()])).rows[0].amount);
            if (settings.dailyCapUsd !== null && spent + BigInt(tier) * 1000000n > BigInt(Math.floor(settings.dailyCapUsd * 1e6)))
                throw new PendingOperation('Waiting for room under the daily spending cap.');
        };
        if (!paymentJob?.data.raw && !['submitted', 'confirmed'].includes(paymentJob?.status))
            await checkCap();
        // A landed swap can update the wallet before its job is marked confirmed.
        // Reconcile that same transaction even when the USDC balance already covers the pack.
        const funding = await this.jobs.get(`${id}:usdc`);
        if (funding && funding.status !== 'confirmed')
            await this.swap(`${id}:usdc`, config.CARDS_MINT, config.USDC_MINT, BigInt(funding.data.amount), settings, BigInt(funding.data.minOutput));
        if (!d.funded) {
            const price = BigInt(tier) * 1000000n, usdc = await this.chain.balance(config.USDC_MINT);
            if (usdc < price) {
                if (funding)
                    throw new PendingOperation('Waiting for confirmed swap funds to be available.');
                const cards = await this.chain.balance(config.CARDS_MINT);
                if (!cards)
                    throw new Error('Insufficient pack funds.');
                const quotedAt = Date.now(), quote = await this.quote(config.CARDS_MINT, config.USDC_MINT, cards), needed = price - usdc;
                const output = quoteOutput(quote, config.CARDS_MINT, config.USDC_MINT, cards, quotedAt);
                const amount = (cards * needed * 10000n + output * (10000n - BigInt(settings.slippageBps)) - 1n) / (output * (10000n - BigInt(settings.slippageBps)));
                if (amount > cards)
                    throw new Error('Pack funds changed; waiting for fees.');
                await this.swap(`${id}:usdc`, config.CARDS_MINT, config.USDC_MINT, amount, settings, needed);
                if (await this.chain.balance(config.USDC_MINT) < price)
                    throw new PendingOperation('Waiting for confirmed swap funds to be available.');
            }
            d.funded = true;
            await this.jobs.put(id, 'pack', 'purchasing', d);
        }
        if (!d.memo) {
            const order = await this.cc('/generatePack', { playerAddress: this.chain.address, packType: `pokemon_${tier}`, turbo: false });
            if (!order.memo || !order.transaction)
                throw new Error('Invalid pack purchase response.');
            d.memo = order.memo;
            d.transaction = order.transaction;
            await this.jobs.put(id, 'pack', 'purchasing', d);
        }
        if (!d.paymentSignature) {
            const policy = { kind: 'pack', inputMint: config.USDC_MINT, maxInput: BigInt(tier) * 1000000n, minInput: BigInt(tier) * 1000000n, recipient: config.COLLECTOR_CRYPT_PAYMENT_WALLET, memo: d.memo, allowedPrograms: [TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'] };
            d.paymentSignature = await this.chain.execute(`${id}:payment`, 'pack-payment', async () => {
                await checkCap();
                const tx = await this.packPayment(id, d, tier);
                policy.memo = d.memo;
                return tx;
            }, settings, policy);
            await this.jobs.put(id, 'pack', 'opening', d);
        }
        await this.jobs.db.query("INSERT INTO ledger(id,kind,amount_micros,signature,created_at) VALUES($1,'pack',$2,$3,$4) ON CONFLICT(id) DO NOTHING", [id, tier * 1_000_000, d.paymentSignature, Date.now()]);
        const status = await this.cc(`/pack/status?memo=${encodeURIComponent(d.memo)}`);
        if (status.pack?.refunded) {
            d.refund = await this.recordRefund(id, d, tier, status.pack.refund_transaction_signature);
            await this.jobs.put(id, 'pack', 'refunded', d);
            throw new PurchaseRefunded(d.refund);
        }
        if (!d.opened) {
            if (!d.openingAnnounced) {
                d.openingAnnounced = true;
                await this.jobs.put(id, 'pack', 'opening', d);
                try { this.onOpening?.({ id: roundId, tier }); } catch { /* Chat is optional. */ }
            }
            const opened = await this.cc('/openPack', { memo: d.memo });
            if (opened.code === 'WAITING_FOR_WEBHOOK' || !opened.nft_address)
                throw new PendingOperation('Waiting for the pack provider to confirm the payment.');
            if (opened.code === 'TURBO_MODE_BUYBACK')
                throw new ReviewRequired('Unexpected automatic buyback.');
            d.opened = opened;
            await this.jobs.put(id, 'pack', 'verifying', d);
        }
        if (!await this.chain.ownsNft(d.opened.nft_address))
            throw new PendingOperation('Waiting for the prize NFT to reach the treasury.', 'custody_pending');
        const card = d.opened.nftWon, meta = card?.content?.metadata ?? card?.metadata ?? {};
        let image = card?.content?.links?.image ?? card?.content?.files?.[0]?.uri ?? meta.image ?? card?.image;
        if (!image) {
            const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
            const { fetchDigitalAsset } = await import('@metaplex-foundation/mpl-token-metadata');
            const { publicKey } = await import('@metaplex-foundation/umi');
            try {
                const asset = await fetchDigitalAsset(createUmi(config.SOLANA_RPC_URL), publicKey(d.opened.nft_address));
                const metadata = await fetchMetadata(asset.metadata.uri);
                image = metadata.image;
            }
            catch { /* Asset may be Core; provider metadata remains authoritative for display. */ }
        }
        const insured = Number(status.send?.insured_value ?? meta.attributes?.find((a) => /insured.?value/i.test(a.trait_type))?.value ?? 0);
        const prize = { id: randomUUID(), coinMint: config.MEMECOIN_MINT, mint: d.opened.nft_address, name: meta.name ?? card?.name ?? 'Pokémon collectible', image: typeof image === 'string' && image.startsWith('https://') ? image : '', value: Number.isFinite(insured) && insured >= 0 ? insured : 0, insuredValue: Number.isFinite(insured) && insured >= 0 ? insured : null, rarity: d.opened.rarity ?? 'Unrated', purchaseSignature: d.paymentSignature, purchaseId: id, purchaseMemo: d.memo };
        await this.jobs.db.query("INSERT INTO prizes(id,mint,data,status) VALUES($1,$2,$3,'available') ON CONFLICT(mint) DO NOTHING", [prize.id, prize.mint, JSON.stringify(prize)]);
        const stored = (await this.jobs.db.query('SELECT data FROM prizes WHERE mint=$1', [prize.mint])).rows[0].data;
        // Mint uniqueness is a custody invariant, not permission to attach an
        // existing collectible to a different paid order. Same-order recovery
        // may reuse the persisted row; a provider returning a duplicate asset
        // must never overwrite that asset's tier or create a second award.
        if (stored.mint !== prize.mint || stored.coinMint !== config.MEMECOIN_MINT
            || stored.purchaseSignature !== d.paymentSignature
            || stored.purchaseId && stored.purchaseId !== id
            || stored.purchaseMemo && stored.purchaseMemo !== d.memo)
            throw new ReviewRequired('Collectible mint is already bound to a different paid purchase.');
        d.prize = stored;
        await this.jobs.put(id, 'pack', 'complete', d);
        return stored;
    }
    async recordRefund(id, data, tier, signature) {
        const prior = (await this.jobs.db.query('SELECT * FROM ledger WHERE id=$1', [`${id}:refund`])).rows[0];
        if (prior?.data?.verified === true) {
            if (prior.data.purchaseId !== id || prior.data.paymentSignature !== data.paymentSignature
                || BigInt(prior.amount_micros) !== BigInt(tier) * 1_000_000n) throw new ReviewRequired('Refund intent changed during reconciliation.');
            return prior.data.refund;
        }
        const proof = await this.chain.verifyRefund({ signature, paymentSignature: data.paymentSignature,
            recipient: config.COLLECTOR_CRYPT_PAYMENT_WALLET, mint: config.USDC_MINT, amount: BigInt(tier) * 1_000_000n });
        const evidence = { verified: true, purchaseId: id, paymentSignature: data.paymentSignature, memo: data.memo, refund: proof };
        try {
            await this.jobs.db.query(`INSERT INTO ledger(id,kind,amount_micros,signature,created_at,data)
              VALUES($1,'refund',$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE
              SET amount_micros=EXCLUDED.amount_micros,signature=EXCLUDED.signature,data=EXCLUDED.data
              WHERE ledger.data->>'verified' IS DISTINCT FROM 'true'`,
              [`${id}:refund`, tier * 1_000_000, proof.signature, Date.now(), JSON.stringify(evidence)]);
        } catch (error) {
            if (error.code === '23505') throw new ReviewRequired('Refund transaction was already credited to another purchase.');
            throw error;
        }
        return proof;
    }
    async packPayment(id, data, tier) {
        const tx = VersionedTransaction.deserialize(Buffer.from(data.transaction, 'base64'));
        const payment = await this.jobs.get(`${id}:payment`);
        if (payment?.data.raw || payment?.data.signature)
            throw new ReviewRequired('Reconcile the existing pack payment before refreshing it.');
        const { rpc } = this.chain.require();
        if ((await rpc.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' })).value) {
            if (payment?.data.attempts?.length)
                throw new PendingOperation('Waiting for the previous pack order to expire before renewing it.');
            return tx;
        }
        // The treasury has never signed this order. Confirm that the provider has no
        // payment or award before replacing its expired, partially signed message.
        const status = await this.cc(`/pack/status?memo=${encodeURIComponent(data.memo)}`);
        if (!status || !('pack' in status) || !('send' in status))
            throw new PendingOperation('Pack status could not be verified before refreshing payment.', 'payment_ambiguous');
        if (status.pack && (status.pack.status !== null || status.pack.transaction_signature || status.pack.webhook_received || status.pack.refunded) || status.send)
            throw new PendingOperation('Provider has activity for the existing pack. Reconcile it before creating another payment.', 'payment_ambiguous');
        const order = await this.cc('/generatePack', { playerAddress: this.chain.address, packType: `pokemon_${tier}`, turbo: false });
        if (!order.memo || !order.transaction)
            throw new Error('Invalid refreshed pack response.');
        const replacement = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
        data.previousMemos = [...(data.previousMemos ?? []), data.memo];
        data.memo = order.memo;
        data.transaction = order.transaction;
        await this.jobs.put(id, 'pack', 'purchasing', data);
        return replacement;
    }
}
