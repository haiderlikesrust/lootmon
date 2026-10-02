// Adapted from the user-owned grailshot reference project. No runtime configuration was copied.
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, unpackMint } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from './config.mjs';
import { eligible } from './rules.mjs';
import { PendingOperation, ReviewRequired } from './jobs.mjs';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { treasurySigner } from './treasury-signer.mjs';
import { validatePackPayment } from './pack-policy.mjs';
export const CORE_PROGRAM = MPL_CORE_PROGRAM_ID;
/** Validate actual USDC movement, never a provider's refund flag alone. */
export function validateRefundEvidence({ transaction, paymentSlot, treasury, provider, mint, amount }) {
    if (!transaction?.meta || transaction.meta.err || !Number.isSafeInteger(transaction.slot)
        || transaction.slot < paymentSlot) throw new ReviewRequired('Refund transaction is not valid settlement evidence.');
    const keys = transaction.transaction?.message?.accountKeys ?? [];
    const address = key => typeof key === 'string' ? key : String(key?.pubkey ?? key);
    const owners = new Map();
    for (const row of [...(transaction.meta.preTokenBalances ?? []), ...(transaction.meta.postTokenBalances ?? [])]) {
        if (row.mint === mint && row.owner) owners.set(address(keys[row.accountIndex]), row.owner);
    }
    const sum = (rows, owner) => (rows ?? []).filter(row => row.mint === mint && row.owner === owner)
        .reduce((total, row) => total + BigInt(row.uiTokenAmount.amount), 0n);
    const credit = sum(transaction.meta.postTokenBalances, treasury) - sum(transaction.meta.preTokenBalances, treasury);
    const debit = sum(transaction.meta.preTokenBalances, provider) - sum(transaction.meta.postTokenBalances, provider);
    const instructions = [...(transaction.transaction?.message?.instructions ?? []),
        ...(transaction.meta.innerInstructions ?? []).flatMap(group => group.instructions)];
    let transferred = 0n;
    for (const instruction of instructions) {
        const parsed = instruction.parsed, info = parsed?.info;
        if (String(instruction.programId) !== TOKEN_PROGRAM_ID.toBase58() || !['transfer', 'transferChecked'].includes(parsed?.type)) continue;
        if (owners.get(info?.source) !== provider || owners.get(info?.destination) !== treasury || info?.authority !== provider) continue;
        if (parsed.type === 'transferChecked' && info.mint !== mint) continue;
        const raw = String(info.amount ?? info.tokenAmount?.amount ?? '');
        if (!/^\d+$/.test(raw)) throw new ReviewRequired('Invalid refund transfer amount.');
        transferred += BigInt(raw);
    }
    if (credit < amount || debit < amount || transferred < amount) throw new ReviewRequired('Refund does not prove the expected provider-to-treasury payment.');
    return { amountMicros: amount.toString(), receivedMicros: credit.toString(), slot: transaction.slot };
}
export class Chain {
    jobs;
    connection;
    signer = null;
    rpc = { ok: false, latency: null, checkedAt: null };
    constructor(jobs) {
        this.jobs = jobs;
        this.connection = config.SOLANA_RPC_URL ? new Connection(config.SOLANA_RPC_URL, { commitment: 'confirmed', confirmTransactionInitialTimeout: 20_000, disableRetryOnRateLimit: true, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(8000)]) }) }) : null;
    }
    async init() { this.signer = treasurySigner(config.TREASURY_PRIVATE_KEY); }
    get address() { return this.signer?.publicKey.toBase58() ?? null; }
    require() { if (!config.live || !this.connection || !this.signer)
        throw new Error('Mainnet signing is disabled or not configured.'); return { rpc: this.connection, signer: this.signer }; }
    async health() { if (!this.connection)
        return; const start = Date.now(); try {
        await this.connection.getSlot('confirmed');
        this.rpc = { ok: true, latency: Date.now() - start, checkedAt: Date.now() };
    }
    catch {
        this.rpc = { ok: false, latency: null, checkedAt: Date.now() };
    } }
    async eligibility(wallet) {
        if (!this.connection || !config.MEMECOIN_MINT)
            return { eligible: false, balance: '0', required: '0', supply: '0', percent: '0', configured: false };
        const mint = new PublicKey(config.MEMECOIN_MINT);
        const [supply, accounts] = await Promise.all([this.connection.getTokenSupply(mint, 'confirmed'), this.connection.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint }, 'confirmed')]);
        const amounts = accounts.value.map(a => String(a.account.data.parsed.info.tokenAmount.amount));
        const balance = amounts.reduce((s, a) => s + BigInt(a), 0n);
        const total = BigInt(supply.value.amount);
        const decimals = supply.value.decimals;
        const display = (n) => `${n / 10n ** BigInt(decimals)}.${(n % 10n ** BigInt(decimals)).toString().padStart(decimals, '0')}`;
        return { eligible: eligible(amounts, total.toString()), balance: display(balance), required: display((total + 399n) / 400n), supply: display(total), percent: total ? String(Number(balance * 1000000n / total) / 10_000) : '0', configured: true };
    }
    async balance(mint, owner = this.address) { if (!this.connection || !owner)
        return 0n; if (mint === NATIVE_MINT.toBase58())
        return BigInt(await this.connection.getBalance(new PublicKey(owner), 'confirmed')); const accounts = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed'); return accounts.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n); }
    async verifyRefund({ signature, paymentSignature, recipient, mint, amount }) {
        if (typeof signature !== 'string' || !signature) throw new PendingOperation('Waiting for refund transaction evidence.', 'refund_pending');
        try { if (bs58.decode(signature).length !== 64 || signature === paymentSignature) throw new Error(); }
        catch { throw new ReviewRequired('Invalid refund transaction identity.'); }
        const { rpc } = this.require();
        const state = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (!state || state.err || !['confirmed', 'finalized'].includes(state.confirmationStatus)) throw new PendingOperation('Refund is not confirmed.', 'refund_pending');
        const [transaction, payment] = await Promise.all([
            rpc.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
            rpc.getTransaction(paymentSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
        ]);
        if (!transaction?.meta || !payment?.meta) throw new PendingOperation('Waiting for complete refund accounting.', 'refund_pending');
        if (payment.meta.err || !Number.isSafeInteger(payment.slot)) throw new ReviewRequired('Original pack payment is not valid.');
        return { signature, ...validateRefundEvidence({ transaction, paymentSlot: payment.slot, treasury: this.address, provider: recipient, mint, amount }) };
    }
    async build(instructions) { const { rpc, signer } = this.require(); const block = await rpc.getLatestBlockhash('confirmed'); return new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: block.blockhash, instructions }).compileToV0Message()); }
    async validateExternal(tx, policy, settings) {
        const { rpc, signer } = this.require();
        if (policy.kind === 'pack') {
            if (!policy.recipient || !policy.memo || policy.inputMint !== config.USDC_MINT || policy.minInput !== policy.maxInput)
                throw new ReviewRequired('Configure and verify the complete pack payment intent.');
            validatePackPayment(tx, signer.publicKey, new PublicKey(policy.recipient), new PublicKey(config.USDC_MINT), policy.maxInput, policy.memo);
        }
        const lookups = await Promise.all(tx.message.addressTableLookups.map(async (l) => { const table = await rpc.getAddressLookupTable(l.accountKey); if (!table.value)
            throw new Error('Missing transaction address table.'); return table.value; }));
        const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: lookups });
        if (policy.kind !== 'pack' && !message.payerKey.equals(signer.publicKey))
            throw new Error('Transaction fee payer does not match the treasury.');
        const programs = new Set(policy.allowedPrograms ?? []);
        for (const ix of message.instructions) {
            const program = ix.programId.toBase58();
            if (programs.size && !programs.has(program))
                throw new ReviewRequired(`Unexpected transaction program ${program}`);
            if ([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program) && ![3, 9, 12, 17].includes(ix.data[0]))
                throw new ReviewRequired('Unexpected token authority operation.');
        }
        // Simulate every existing treasury token account and both expected ATAs. This checks
        // actual post-balances, retained owners/delegates, gas reserve and unauthorized debits.
        const groups = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(programId => rpc.getTokenAccountsByOwner(signer.publicKey, { programId })));
        const owned = groups.flatMap(g => g.value);
        const addresses = [signer.publicKey, ...owned.map(a => a.pubkey)];
        for (const mint of [policy.inputMint, policy.outputMint].filter(Boolean)) {
            if (mint === NATIVE_MINT.toBase58())
                continue;
            const info = await rpc.getAccountInfo(new PublicKey(mint));
            if (!info)
                throw new Error('Token mint not found.');
            const ata = getAssociatedTokenAddressSync(new PublicKey(mint), signer.publicKey, false, info.owner);
            if (!addresses.some(a => a.equals(ata)))
                addresses.push(ata);
        }
        if (addresses.length > 90)
            throw new ReviewRequired('Use a dedicated treasury with fewer than 90 token accounts.');
        const before = await rpc.getMultipleAccountsInfo(addresses, 'confirmed');
        const simulation = await rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: addresses.map(a => a.toBase58()) }, commitment: 'confirmed' });
        if (simulation.value.err)
            throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
        const after = simulation.value.accounts;
        if (!after || after.length !== addresses.length)
            throw new Error('Missing simulation account results.');
        const deltas = new Map();
        for (let i = 1; i < addresses.length; i++) {
            const old = before[i]?.data, newBytes = after[i]?.data?.[0] ? Buffer.from(after[i].data[0], 'base64') : null;
            const a = old && old.length >= 165 ? AccountLayout.decode(old) : null, b = newBytes && newBytes.length >= 165 ? AccountLayout.decode(newBytes) : null;
            if (a && b && !a.mint.equals(b.mint))
                throw new ReviewRequired('Treasury token mint changed.');
            if (before[i] && after[i] && before[i].owner.toBase58() !== after[i].owner)
                throw new ReviewRequired('Treasury token program changed.');
            if (b && (!b.owner.equals(signer.publicKey) || b.delegateOption !== a?.delegateOption && b.delegateOption !== 0 || b.closeAuthorityOption !== a?.closeAuthorityOption && b.closeAuthorityOption !== 0))
                throw new ReviewRequired('Treasury ownership or authority changed.');
            if (a && b && (a.delegateOption !== b.delegateOption || !a.delegate.equals(b.delegate) || a.closeAuthorityOption !== b.closeAuthorityOption || !a.closeAuthority.equals(b.closeAuthority)))
                throw new ReviewRequired('Treasury token authority changed.');
            const mint = (a?.mint ?? b?.mint)?.toBase58();
            if (mint)
                deltas.set(mint, (deltas.get(mint) ?? 0n) + (b?.amount ?? 0n) - (a?.amount ?? 0n));
        }
        const solDelta = BigInt(after[0]?.lamports ?? 0) - BigInt(before[0]?.lamports ?? 0);
        const maxNative = policy.inputMint === NATIVE_MINT.toBase58() ? (policy.maxInput ?? 0n) : 0n;
        if (solDelta < -(maxNative + 20000000n) || BigInt(after[0]?.lamports ?? 0) < BigInt(Math.round(settings.gasReserveSol * 1e9)))
            throw new ReviewRequired('Transaction exceeds gas allowance or treasury reserve.');
        for (const [mint, delta] of deltas) {
            if (delta < 0n && (mint !== policy.inputMint || -delta > (policy.maxInput ?? 0n)))
                throw new ReviewRequired('Unexpected treasury token debit.');
        }
        if (policy.inputMint && policy.inputMint !== NATIVE_MINT.toBase58() && -(deltas.get(policy.inputMint) ?? 0n) < (policy.minInput ?? 0n))
            throw new ReviewRequired('Payment amount does not match the pack.');
        if (policy.outputMint && (deltas.get(policy.outputMint) ?? 0n) < (policy.minOutput ?? 0n))
            throw new ReviewRequired('Swap output is below the minimum.');
    }
    async execute(id, kind, build, settings, policy = { kind: 'internal' }) {
        const { rpc, signer } = this.require();
        let job = await this.jobs.get(id);
        if (job?.status === 'confirmed')
            return job.data.signature;
        if (job?.status === 'failed') {
            if (!job.data.automaticRetry || !job.data.signature)
                throw new ReviewRequired(job.error || 'Transaction needs review.');
            if (Date.now() - Number(job.updated_at) < 30_000)
                throw new PendingOperation('Retrying the failed transaction after reconciliation.');
            await this.recover(id);
            job = await this.jobs.get(id);
            if (job.status === 'confirmed')
                return job.data.signature;
            if (job.status !== 'retryable')
                throw new PendingOperation('Waiting for the previous transaction to settle.');
        }
        if (!job?.data.raw) {
            // Older versions could discard an expired signed attempt merely
            // because RPC history was empty. Its archived signature remains a
            // possible payment; never silently rebuild those legacy records.
            if (job?.data.attempts?.some(attempt => attempt.signature && attempt.finalizedFailure !== true))
                throw new PendingOperation('An earlier signed attempt has no final failure proof; retaining the reserved intent.', 'payment_ambiguous');
            const tx = await build();
            if (policy.kind !== 'internal')
                await this.validateExternal(tx, policy, settings);
            tx.sign([signer]);
            const signature = bs58.encode(tx.signatures[0]);
            const data = { ...(job?.data ?? {}), raw: Buffer.from(tx.serialize()).toString('base64'), signature, blockhash: tx.message.recentBlockhash };
            await this.jobs.put(id, kind, 'prepared', data);
            job = await this.jobs.get(id);
        }
        const data = job.data;
        const status = (await rpc.getSignatureStatuses([data.signature], { searchTransactionHistory: true })).value[0];
        if (status?.err) {
            if (!['confirmed', 'finalized'].includes(status.confirmationStatus ?? ''))
                throw new PendingOperation('Waiting for the failed transaction to reach confirmation.');
            await this.jobs.put(id, kind, 'failed', { ...data, automaticRetry: true }, JSON.stringify(status.err));
            throw new PendingOperation('Transaction failed on-chain; automatic recovery is scheduled.');
        }
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            await this.jobs.put(id, kind, 'confirmed', data);
            return data.signature;
        }
        const valid = await rpc.isBlockhashValid(data.blockhash, { commitment: 'confirmed' });
        if (!valid.value && !status) {
            const landed = await rpc.getTransaction(data.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (landed?.meta && !landed.meta.err) {
                await this.jobs.put(id, kind, 'confirmed', data);
                return data.signature;
            }
            if (landed?.meta?.err) {
                await this.jobs.put(id, kind, 'failed', { ...data, automaticRetry: true }, JSON.stringify(landed.meta.err));
                throw new PendingOperation('Waiting for the failed transaction to finalize before retrying.');
            }
            // Null history is not proof of non-execution: an RPC can lag or
            // prune a transaction that already spent funds. Keep the original
            // signed identity indefinitely until settlement evidence arrives.
            throw new PendingOperation('Signed transaction settlement is unknown; retaining the original payment.', 'payment_ambiguous');
        }
        if (!status)
            await rpc.sendRawTransaction(Buffer.from(data.raw, 'base64'), { skipPreflight: false, maxRetries: 2 });
        await this.jobs.put(id, kind, 'submitted', data);
        throw new PendingOperation('Waiting for transaction confirmation.');
    }
    async recover(id) {
        const job = await this.jobs.get(id);
        if (!job)
            throw new Error('Job not found.');
        if (job.data.signature) {
            const { rpc } = this.require();
            const status = (await rpc.getSignatureStatuses([job.data.signature], { searchTransactionHistory: true })).value[0];
            if (status?.err && status.confirmationStatus !== 'finalized')
                throw new PendingOperation('Waiting for the failed transaction to finalize before retrying.');
            if (status && !status.err) {
                if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
                    await this.jobs.put(id, job.kind, 'confirmed', job.data);
                return;
            }
            if (!status && (await rpc.isBlockhashValid(job.data.blockhash, { commitment: 'confirmed' })).value)
                throw new PendingOperation('Transaction is still valid; reconciliation must finish first.');
            if (!status?.err) {
                const landed = await rpc.getTransaction(job.data.signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
                if (!landed?.meta)
                    throw new PendingOperation('Signed transaction settlement is unknown; retaining the original payment.', 'payment_ambiguous');
                if (!landed.meta.err) {
                    await this.jobs.put(id, job.kind, 'confirmed', job.data);
                    return;
                }
            }
        }
        await this.jobs.put(id, job.kind, 'retryable', { attempts: [...(job.data.attempts ?? []), { signature: job.data.signature, error: job.error, finalizedFailure: Boolean(job.data.signature) }], ...Object.fromEntries(Object.entries(job.data).filter(([key]) => !['raw', 'signature', 'blockhash', 'attempts', 'automaticRetry'].includes(key))) });
    }
    async ownsNft(mint, wallet = this.address) {
        const { rpc } = this.require();
        const account = await rpc.getAccountInfo(new PublicKey(mint));
        if (!account)
            return false;
        if (account.owner.toBase58() === CORE_PROGRAM) {
            const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
            const { fetchAsset } = await import('@metaplex-foundation/mpl-core');
            const asset = await fetchAsset(createUmi(config.SOLANA_RPC_URL), mint);
            return asset.owner === wallet;
        }
        if (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID))
            throw new ReviewRequired('Collectible is not owned by a supported NFT token program.');
        let tokenMint;
        try { tokenMint = unpackMint(new PublicKey(mint), account, account.owner); }
        catch { throw new ReviewRequired('Collectible has invalid mint account data.'); }
        if (!tokenMint.isInitialized || tokenMint.decimals !== 0 || tokenMint.supply !== 1n)
            throw new ReviewRequired('Collectible must have a unique indivisible NFT supply.');
        return (await this.balance(mint, wallet)) === 1n;
    }
    async transferNft(id, mint, winner, settings) {
        return this.execute(id, 'nft-transfer', async () => {
            if (!await this.ownsNft(mint))
                throw new PendingOperation('Waiting for verified treasury custody.', 'custody_pending');
            const { signer, rpc } = this.require();
            const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
            const { keypairIdentity, publicKey } = await import('@metaplex-foundation/umi');
            const umi = createUmi(config.SOLANA_RPC_URL);
            umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(signer.secretKey)));
            const info = await rpc.getAccountInfo(new PublicKey(mint));
            let builder;
            if (info?.owner.toBase58() === CORE_PROGRAM) {
                const core = await import('@metaplex-foundation/mpl-core');
                umi.use(core.mplCore());
                const asset = await core.fetchAsset(umi, mint), collectionKey = core.collectionAddress(asset), collection = collectionKey ? await core.fetchCollection(umi, collectionKey) : undefined;
                builder = core.transfer(umi, { asset, collection, newOwner: publicKey(winner) });
            }
            else {
                const mpl = await import('@metaplex-foundation/mpl-token-metadata');
                umi.use(mpl.mplTokenMetadata());
                const asset = await mpl.fetchDigitalAsset(umi, publicKey(mint));
                const tokenStandard = asset.metadata.tokenStandard.__option === 'Some' ? asset.metadata.tokenStandard.value : mpl.TokenStandard.NonFungible;
                const rules = asset.metadata.programmableConfig.__option === 'Some' && asset.metadata.programmableConfig.value.ruleSet.__option === 'Some' ? asset.metadata.programmableConfig.value.ruleSet.value : undefined;
                builder = mpl.transferV1(umi, { mint: publicKey(mint), tokenOwner: umi.identity.publicKey, destinationOwner: publicKey(winner), tokenStandard, authorizationRules: rules, amount: 1 });
            }
            const instructions = builder.getInstructions().map(ix => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) }));
            return this.build([ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }), ...instructions]);
        }, settings);
    }
}
