# Prize funding and production integration

The game uses wallet-gated access and a mainnet provider integration. It does not seed invented balances, token holdings, fee flow, prizes, or awards. Missing runtime configuration disables funding and awards. The treasury planner in `server/treasury.mjs` makes deterministic allocation decisions without network calls or financial side effects; `server/provider.mjs` executes durable, validated provider jobs only when configured. No private configuration or signing material was copied from the reference project. Mainnet operation has not been exercised as part of this build.

## Treasury policy

Call `planDrop(snapshot)` with an explicit `nowMs` and USD-denominated numbers. `treasuryUsd` is confirmed liquid value after conservative execution costs; `obligationsUsd` includes existing reserved purchases, withdrawals, and unpaid prizes. The default separate reserve is $500. Do not include an NFT's estimated resale value or anticipated future fees as liquid funds.

The spending ceiling is the smallest of:

- 15% of liquid funds after obligations and reserve.
- 70% of unallocated, realized fee proceeds (`accruedFeesUsd`).
- The remaining daily limit (default $1,500, supplied by the caller's ledger).
- A $1,000 per-drop cap.

`recentFeesUsd` over `feeWindowMinutes` measures the current fee rate, while `accruedFeesUsd` tracks proceeds still available to allocate. These are different values: the rate should decay when fees slow; accrued funds can accumulate until a $25 pack is affordable. When omitted, accrued fees default to the recent-fee amount for isolated policy calculations. The live adapter subtracts all reserved and completed purchases from the cumulative 70% fee allocation before passing remaining proceeds to the planner.

Automatic cadence is ten minutes when hourly net fees are at least $300 and uncommitted liquid funds are at least $500; otherwise it is hourly. A caller can explicitly select 10 or 60 minutes. Persist `lastDropAtMs` only when a purchase reservation commits; repeatedly asking the planner for a quote must not reset it. `nextDropAtMs` is the next due/recheck time, not a promise that funding will exist then.

Common packs use $25, $50, and $100 tiers and varied placement difficulties. At most one premium pack may appear in each plan. A $250 pack needs $2,000 liquid funds, $300/hour recent fees, and two hours since any premium drop. A $500 pack needs $5,000 liquid funds, $1,200/hour recent fees, and six hours since any premium drop. Their cooldown timestamps are persisted in `lastHighTierAtMs`, keyed by `250` and `500`. The total ceiling still applies. `availableTiers` should be the provider's currently verified inventory, and `maxPacks` bounds the number of new objectives.

The result contains `eligible`, a machine-readable `reason`, `budgetUsd`, `spendUsd`, grouped `packs` with `tierUsd`, `quantity`, and `difficulty`, plus cadence and audit metrics. Invalid numeric data throws before any plan is returned. Computation uses integer cents, floors assets, and rounds obligations up. Pack price is the acquisition cost, not a guarantee of the resulting collectible's resale value.

```js
const plan = planDrop({
  nowMs: Date.now(),
  treasuryUsd: 2840,
  obligationsUsd: 975,
  reserveUsd: 500,
  recentFeesUsd: 126,
  feeWindowMinutes: 10,
  accruedFeesUsd: 126,
  lastDropAtMs: null,
  lastHighTierAtMs: {},
  dailyRemainingUsd: 1500,
  availableTiers: [25, 50, 100, 250, 500],
});
// $88.20 ceiling, one $50 pack and one $25 pack, ten-minute cadence.
```

Production calls must run inside a serialized treasury reservation workflow. Atomically reserve the planned spend, charge that allocation against the accrued-fee ledger, and save the cadence and premium timestamps before dispatching purchase jobs. Reserve transaction and conversion costs separately. Retried requests use the same drop and purchase IDs. A dry-run function cannot by itself prevent two workers from allocating the same money.

`server/provider.mjs` implements this allocation workflow with PostgreSQL advisory locking and atomic reservation transactions. A separate lifetime advisory lease prevents two game authorities, including ones using different local game-data directories, from replaying the same prize inventory concurrently. Losing that lease disables the adapter and invokes `onAuthorityLost` so the host can stop gameplay. Tables use the `cards_provider_` prefix, and the ledger is pinned to its first configured coin mint and treasury wallet to prevent reuse under a different deployment identity. Transaction bytes and signatures are persisted before network submission. Pending operations reconcile on later polls; prizes are replayed to the game only after purchase settlement and treasury custody verification. The game's `onPrize` handler must durably deduplicate IDs because replay after a crash is expected. Award jobs pin the exact prize and recipient and reconcile the same signed transaction. Confirmed transfer evidence completes an award even if the winner has subsequently forwarded the collectible.

Recovery runs automatically. Purchase, fee, and award operations persist their attempt count, retry deadline, sanitized reason, and bounded history. Temporary outages use bounded backoff; incomplete payment evidence is polled without creating a replacement payment. Invalid or changed intents are quarantined with their obligations protected. A quarantined operation does not stop unrelated purchases that remain fully funded. Refunds restore allocation and applicable daily spending capacity only after a confirmed successful transaction proves the full USDC amount moved from the configured provider payment wallet into the treasury after the original payment. A unique refund signature prevents double credit. A provider refund flag alone, a partial refund, or payment from an unverified sender cannot release funding capacity. Refunded purchase jobs are terminal; any later purchase needs a new funded reservation.

The game durably queues purchased inventory when no safe hiding position is available. Queue retries preserve each prize ID across restarts, and `packCounts.queued` reports waiting inventory separately from playable packs. Returning provider inventory is deduplicated against queued, active, and already secured prizes.

## Runtime configuration

Set these server-side variables through deployment secrets and environment configuration; never through a browser build or `VITE_` variables:

| Variable | Purpose |
| --- | --- |
| `MAINNET_ENABLED=true` | Explicitly enables mainnet worker transactions. With this absent, the adapter does no network or financial work. |
| `DATABASE_URL` | PostgreSQL connection for durable provider jobs, ledger, reservations, custody, and awards. |
| `MEMECOIN_MINT` | The launched game coin's verified mint. This is distinct from CARDS. |
| `TREASURY_PRIVATE_KEY` | Backend-only base58 64-byte signing key or JSON array of 64 byte values. |
| `SOLANA_RPC_URL` | Reliable mainnet RPC endpoint. |
| `JUPITER_API_KEY` | CARDS conversion and executable valuation access. |
| `COLLECTOR_CRYPT_PAYMENT_WALLET` | Provider-confirmed payment recipient; mismatched transactions are rejected. |
| `COLLECTOR_CRYPT_API_KEY` | Optional partner API credential. |

The treasury address is derived from the signing key, then its creator-fee recipient/shareholder authority is checked on-chain. No duplicate `FEE_RECIPIENT` variable is required. Public mints, provider API bases, the 0.05 SOL gas reserve, 100 bps slippage cap, $500 liquid reserve, $1,500 daily cap, and $1,000 cycle cap are code defaults in `server/integrations/config.mjs`.

The reference source, README, deploy templates, and allowlisted public-address fields contained **no configured game mint, treasury address, owner address, or provider payment wallet**. Their example entries were empty. CARDS and USDC defaults do not supply those missing identities. Confirm the launched game's exact mint and provider recipient rather than inferring them from a symbol or token search result.

The live adapter uses the reference's Collector Crypt `/machines`, `/status`, `/generatePack`, `/pack/status`, and `/openPack` routes, Jupiter Swap v2 `/order`, and Pump SDK creator-fee methods. Provider availability and transaction intent are checked at runtime; absent inventory or a failure in quote, balance, or custody checks prevents new funded spawns.

## Useful reference implementation

The following files were inspected read-only under `C:\Users\Gamer\Desktop\poke sniper\grailshot`. Their behaviors are useful implementation references, not a claim that provider APIs or mint economics are currently unchanged.

| File and entry point | Reusable behavior |
| --- | --- |
| `server/providers.ts:33`, `Providers.machines()` | Reads Collector Crypt machine catalog and operational status, filters supported Pokémon machine codes, public availability, stock, and open state. |
| `server/providers.ts:48`, `Providers.collectFees()` | Claims configured creator/shared fees, detects quote asset and fee-recipient eligibility, converts quote proceeds to CARDS when necessary, and records idempotent fee ledger entries. It does not assume pump.fun fees are inherently paid in CARDS. |
| `server/providers.ts:68`, `Providers.purchase()` | Reserves an idempotent purchase ID, checks daily spend, funds USDC with CARDS as needed, requests `/generatePack` with `turbo: false`, settles payment, opens with `/openPack`, verifies custody, then stores prize identity and metadata. |
| `server/providers.ts:117`, `Providers.packPayment()` | Reconciles previous payments before replacing expired provider orders; checks provider activity before generating another order. |
| `server/pack-policy.ts:10`, `validatePackPayment()` | Validates recipient, exact amount and mint, memo intent, permitted instructions, provider signatures, and compute/fee bounds before signing. |
| `server/chain.ts:70`, `Chain.execute()` | Persists transaction intent and signature, submits, and reconciles restart/retry states. |
| `server/chain.ts:110`, `Chain.transferNft()` | Transfers supported Metaplex Core or Token Metadata assets to a winner through durable jobs. |
| `server/treasury.ts:18`, `Treasury.refresh()` | Reads confirmed balances and reservations, checks RPC health, estimates CARDS liquidation value with a slippage allowance, and fails closed when valuation or inventory is unavailable. |
| `server/jobs.ts:4`, `Jobs` | Persists idempotent operation state and errors. |
| `server/auth.ts:9,17,28`, `challenge()`, `verify()`, `sessionPlayer()` | Wallet challenge signing and server-side session lookup. |
| `tests/recovery.test.ts` and `tests/treasury.test.ts` | Examples of restart recovery, duplicate-payment prevention, unavailable quotes, and confirmed-balance accounting. |

Two differences must be changed when adapting that code: `shared/game.ts` currently gates at 0.1% (`balance * 1000 >= supply`), whereas this game requires **at least 0.25%** (`balance * 400 >= supply`); the reference's `PACK_TIERS` omits $250. Adding $250 locally does not prove that the provider offers that machine. Discover it at runtime and omit the tier when unavailable.

## Live integration boundary

1. Configure the exact launched mint, confirmed supply source, RPC, fee-recipient arrangement, treasury custody, supported CARDS/USDC mints, provider credentials, and verified provider payment recipient. Keep signing keys server-side in a dedicated signer. Verify current provider contracts and capabilities before enabling the adapter.
2. Authenticate a wallet by a domain-bound, expiring nonce signature. Sum its relevant token accounts with integer base units and verify `balance * 400 >= supply`. Recheck eligibility on join and before award. The temporary premium tool requires **strictly more than 2%** (`balance * 50 > supply`), with server-enforced duration and cooldown; exactly 2% does not qualify.
3. Collect actual configured fee assets and account for conversions, liquidity, slippage, gas, and confirmation. If proceeds are routed through CARDS, value only executable confirmed holdings. Do not promise a fixed USD funding rate from trading volume or token price. Halt new allocations on stale quotes or failed balance checks.
4. Preserve both durable stores: PostgreSQL holds fee accounting, reservations, drops, per-pack provider jobs, collectible custody, and recipient-pinned awards; the game data volume holds packs, queued spawns, captures, and the delivery outbox. Database uniqueness protects collectible mints, award identities, and verified refund signatures. Daily purchase expenditure uses UTC day boundaries.
5. Purchase and verify custody **before** introducing a prize-backed pack into a match. The server owns spawn positions, pack custody, movement bounds, proximity checks, theft cooldowns, base captures, disconnect recovery, and winner decisions. Client events request actions rather than declare outcomes.
6. A successful base capture freezes the pack from theft and creates an idempotent award job for the exact asset and recipient. Eligibility is checked before first signing; retries reconcile any already signed transfer. The collection shows automatic retry timing or a verification quarantine until confirmation. Restarts resume the same award, and provider refunds follow the verified automatic recovery policy above. Physical redemption, delivery addresses, and shipping are outside this game's scope; its delivery completes with the collectible transferred to the winner's wallet.
7. Before a public prize launch, resolve the applicable promotion/game rules and eligibility regions, provider permission, and Pokémon/card artwork rights. Those product decisions are separate from the code's transaction and gameplay checks.

The planner tests run with `node --test tests/treasury.test.mjs`. They cover fund protection, caps, cadence boundaries, accumulation under slow fee flow, premium cooldowns, inventory restrictions, invalid inputs, deterministic behavior, and varied-budget invariants.
