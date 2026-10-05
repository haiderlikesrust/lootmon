# Lootmon — Verdant Isle

Lootmon is a wallet-gated 3D collectible hunt. Eligible coin holders explore an island, find treasury-funded packs, and carry them to their own base. Other players can steal a carried pack before delivery. A successful delivery creates a durable award request for the purchased collectible. Winning assets transfer to the player’s wallet; physical-card shipping and fulfilment are outside this application.

The app includes a modeled island with Hearthwick village, Whisperwood, Sunmill Orchard, Crown Ruins, Silverwater, and Old Watch; rigged, animated collector characters; a character selector and orbit camera; an island map; shadows and quality settings; and synthesized sound effects for movement, pickups, theft, abilities, and delivery.

Choose **Explore island** to walk the island with your selected character: WASD or arrow keys move, Shift sprints, Space jumps, and right-click grabs or snatches. Desktop mouse look captures the cursor; Escape releases it, and a second Escape returns to character selection. Touch screens use drag to look. Narrow screens also have movement buttons. Exploration uses the actual island and collision geometry, with a live position marker and a labeled starting camp on the map. Live hunts show the assigned reward base with a home bearing and distance. Funded packs, multiplayer participation, and reward actions require verified holder access.

There are no seeded balances, invented prizes, or practice opponents. Tests use isolated fixtures and mocked provider/RPC responses; they do not place orders or transfer assets.

**Wallets:** Connect wallet opens a picker instead of automatically choosing an extension. Solflare, Phantom and Backpack have injected-provider support; compatible Solana Wallet Standard wallets with mainnet message signing are discovered automatically. Sign-in uses a server challenge, never a payment request. Account changes or disconnects during a connected session clear the local identity and revoke its session. On mobile, open Lootmon inside the wallet's browser; external-app deep-link pairing is not implemented. No wallet-specific environment variables are needed.

**Performance:** Camera rays use a geometry index, and client movement/server sight checks share a spatial obstacle lookup. Slow connections skip replaceable state/movement snapshots instead of accumulating old frames; reward actions keep their existing authority checks. Hidden tabs stop rendering and map redraws. Collision parity and camera hit correctness are regression-tested against the authored island; CPU benchmarks do not guarantee a specific browser FPS or network ping.

## Run locally

Use **Node.js 22.13.0 or newer** and npm.

```sh
npm ci
npm run build
npm start
```

Open [http://localhost:8787](http://localhost:8787). This serves the built client and the game API from one process. No `.env` file is needed to explore the island. With `MAINNET_ENABLED` absent or false, the provider does not claim fees, buy packs, or transfer prizes.

For client development, `npm run dev` runs Vite on port 5186 and the game server on port 8787. Use one game authority at a time: stop a running `npm start` before starting the development command. If testing wallet sign-in through Vite, set `APP_ORIGIN` to its exact local origin.

```sh
npm test
npm run preflight
```

The preflight command checks configuration syntax without making network requests. Add `-- --live` to require complete live configuration. A successful check does not establish provider acceptance, available stock, spendable funds, or working RPC/database access.

## Live configuration

Copy `.env.example` to `.env` locally, or supply the same variables through the deployment's runtime environment. The sample contains nine settings; the X profile is optional:

| Variable | Required value |
| --- | --- |
| `APP_ORIGIN` | Public HTTPS origin `https://lootmon.xyz`; localhost HTTP is supported for local use. |
| `MEMECOIN_MINT` | Verified mint address of the launched game coin. It is distinct from the CARDS funding token. |
| `X_ACCOUNT_URL` | Optional public X profile, such as `https://x.com/your_account`. |
| `SOLANA_RPC_URL` | Reliable Solana mainnet RPC endpoint. |
| `DATABASE_URL` | External PostgreSQL connection URL for the provider ledger and durable transaction jobs. |
| `TREASURY_PRIVATE_KEY` | Server-only treasury signing key: base58-encoded 64-byte key or JSON array of 64 bytes. |
| `JUPITER_API_KEY` | Access for CARDS conversion and executable USDC valuation. |
| `COLLECTOR_CRYPT_PAYMENT_WALLET` | Current payment recipient verified with Collector Crypt. |
| `MAINNET_ENABLED` | Keep `false` during setup; `true` authorizes the configured worker's live transaction paths. |

An optional `COLLECTOR_CRYPT_API_KEY` can provide partner attribution/access when supplied by the provider. It is not required by the configuration gate and is intentionally absent from the minimal sample. The treasury address is derived from the signing key; the creator-fee recipient/shareholder relationship is verified on-chain. Public token mints, API endpoints, gas reserve, slippage limits, and allocation policy are code defaults.

No actual credentials or launched game mint are bundled. The reference project did not contain a configured game mint or payment recipient. Live launch still requires those exact identities, a funded treasury with gas, database/RPC access, and provider acceptance of the purchase flow. The code has not been exercised with real treasury funds as part of this build.

For a public deployment, keep secrets in server runtime configuration and put the app behind an HTTPS reverse proxy that forwards WebSocket upgrades for `/ws`. Set `APP_ORIGIN` to the public origin. Do not expose a private key through browser variables or frontend build arguments.

## Game and funding rules

- Play requires **at least 0.25%** of the configured coin's supply. Wallet signatures and confirmed holdings are verified by the server.
- Special tools require **strictly more than 2%**. Pulse scan and Quickstep have server-enforced durations and cooldowns.
- Pack tiers are **$25, $50, $100, $250, and $500**, subject to verified provider inventory. Their prices are acquisition costs, not promised collectible resale values.
- The worker refills from confirmed treasury balance every 15 seconds, including direct deposits. It pauses at five outstanding packs (including purchases in progress), protects existing payment reservations and SOL gas, and retains daily/cycle spending limits and premium-tier cooldowns.
- Homes use server-random, separated pads in the southern collector camp, with up to 64 hunters. Assignments persist through reconnects unless a pad is occupied. Each hiding place must be reachable from every pad; route-distance bounds limit base advantages. Common packs use house interiors and woodland cover. Premium packs use guarded chambers, and $500 packs require an across-river route.
- New drops avoid nearby hunters, active packs, and recently used spots. Bought inventory waits in a durable queue if no safe hiding place is available. Hidden locations require line of sight to discover, unless a timed radar is active.
- A funded pack enters the world only after purchase settlement and treasury custody verification. Its pickup, theft, and base delivery are controlled by the server.
- Delivery creates an idempotent award request. A reward remains pending until its intended transfer is confirmed. Restart recovery resumes the same transaction rather than making another payment. Temporary purchase, fee, and wallet-transfer failures retry automatically with persisted 15-second to 5-minute backoff. Confirmed full USDC refunds restore allocation once; ambiguous payments remain reserved while reconciling. Unsafe or changed transaction intents are quarantined and never auto-approved. Unrelated backed drops continue.
- An expired blockhash with missing transaction history does not prove that a payment failed. The worker retains that signed transaction and its reservation until reliable settlement evidence arrives, even if the RPC cannot provide that evidence for an extended period. A replacement signature requires proof of a finalized failure.

## Leaderboard and island chat

`/leaderboard` shows aggregate standings from the durable reward ledger. Wins and reported card values count confirmed transfers with valid transaction signatures; secured rewards awaiting delivery remain pending. It never publishes hiding coordinates or private collection details.

The island chat can be hidden, remembers that choice, and shows an unread badge. Spectators can read; only current verified hunters can send. Messages are limited to 240 characters, one every 3 seconds and eight per minute per wallet, with duplicate-message suppression across reconnects. The latest 120 messages and 20 activity entries persist in the current CA's `community-state.json`, beside its world ledger. Writes are serialized asynchronously and flushed on graceful shutdown. Looter's confirmed wins are rebuilt from the durable prize ledger without issuing another reward. Messages already lost before this persistence update cannot be recovered; an abrupt crash can lose a write still in flight.

Looter is a server-controlled game bot. It announces confirmed wallet transfers with a transaction receipt and answers `/hint`, `/help`, `/rules`, `/base`, `/drops`, and `/leaderboard`. `/hint` shares the fixed A1–F6 map square and indoor/outdoor clue for currently hidden $25/$50 packs with everyone. It does not return precise coordinates, distance, bearings, premium locations, or carried packs. Both maps label the player's current square; exact gold pack markers still require server-authorized discovery. No language-model API or additional environment settings are required. A separate compact activity feed records pickups, thefts, deposits and confirmed deliveries. Focusing chat input or opening the leaderboard releases the mouse and blocks movement input while keeping an active hunt connected.

Desktop controls: **WASD / arrow keys** move, **Shift** sprints, **Space** jumps, **right-click** picks up or steals, **Q** activates Pulse scan, and **F** activates Quickstep. Move the mouse to look around; click the island to capture the cursor and press **Escape** to release it. Touch screens use drag. Settings include persistent look sensitivity, shadow quality, camera orbit, and sound. In browsers that deny pointer capture, move the cursor toward an island edge to keep turning through any number of rotations; Escape releases look. The compass follows the rendered camera and marks the direction home. The HUD measures actual rendered FPS and WebSocket round-trip ping during a hunt; outside a hunt it labels HTTP server round-trip time. Sound begins only after a user gesture and can be muted.

## Dokploy deployment

Use [the Dokploy guide](docs/DOKPLOY.md) and `compose.dokploy.yaml` for the same hosting arrangement as Grailshot: an Nginx gateway on `dokploy-network`, a private continuous game server, and PostgreSQL 17 with persistent storage. The Node server serves both the built frontend and WebSockets, so this app needs no separate frontend service. Route **lootmon.xyz** to **gateway, container port 8080**. The production stack publishes no host ports.

In Dokploy’s Environment editor, paste `deploy/dokploy.env.example`. Set `MEMECOIN_MINT` for both the holder gate and the public, copyable contract address; set `X_ACCOUNT_URL` for the footer’s X link. Change these server runtime settings and redeploy; no frontend build variables are needed. `POSTGRES_PASSWORD` replaces `DATABASE_URL` in this template because Compose constructs the private database URL.

### Switching CAs in the same deployment

Set `MEMECOIN_MINT` and redeploy to select a different coin profile. If the new coin uses a different treasury, also set `TREASURY_PRIVATE_KEY` to that wallet's exported private key. Keep the same database and game-data volume. One CA is active at a time: accounts, bases, collections, leaderboard, hidden packs, chat, fee history and provider jobs are isolated by CA. Returning to a previous CA with its original treasury key restores its world. Sessions reset on restart; saved chat is restored. No additional environment variable is needed, and real purchases still require `MAINNET_ENABLED=true` and the existing funding conditions.

Existing provider tables are automatically registered to their original stored CA; existing world data is moved to that CA's directory using the database identity, even if the newly configured CA is different. Unidentified legacy prizes fail closed rather than being assigned to a guessed CA. A profile's treasury wallet cannot be silently replaced. Keep both persistent volumes together in backups.

A new CA with a different treasury wallet can start while the old profile has unfinished operations. Those operations and prizes remain saved in the inactive profile; startup logs `INACTIVE_RECOVERY_PAUSED`. They are not cancelled or marked complete, and inactive worlds do not perform recovery or award transfers. Restore the old CA and its original treasury key to resume recovery. A previously registered CA must always use its registered treasury wallet.

When reusing the same treasury wallet for another CA, finish pending purchases, fee conversions and award transfers before switching. Startup rejects this shared-wallet switch with unresolved operations and reports the original CA to restore. Fully purchased, unclaimed packs can remain paused in the original world. Treasury token balances are shared physical wallet assets, while fee and purchase records remain separate; the wallet's daily spending cap spans all its CA profiles. CA separation does not identify which coin produced a direct wallet deposit or fees from a shared creator vault; collected fees belong to the active profile's verified claim cycle.

## Standalone container deployment

The container packages the Node server and built client. It uses an **external PostgreSQL database through `DATABASE_URL`**; there is no second database-password setting or bundled database service.

After creating `.env` with the required runtime values:

```sh
docker compose build
docker compose run --rm --no-deps game node scripts/preflight.mjs --live
docker compose up -d
```

The Compose service binds **127.0.0.1:8787** on the host for an HTTPS reverse proxy. Inside the container, the app listens on `0.0.0.0`. The image runs as a non-root user, with a read-only filesystem and a writable `game-data` volume for game state. Keep this volume and the external PostgreSQL database across upgrades, and back up both.

Run exactly **one game authority per world**. Local storage has an exclusive authority lock, and the provider holds a lifetime PostgreSQL advisory lease so another authority cannot replay the same prizes into a second world. A lost database lease stops the server. Scale the renderer or reverse proxy separately; do not increase game-service replicas.

The Docker health check confirms that `/api/status` responds; it does not prove that live funding is configured or ready. Review the endpoint's funding state and blockers separately. Stop gracefully before maintenance or replacing the authority. Do not remove its data volume to clear a lock.

## Implementation and credits

- [Funding, provider integration, and restart behavior](docs/INTEGRATION.md).
- [Character asset sources, CC0 license, model preparation, and animation clips](docs/ASSETS.md). Characters are by [Kay Lousberg](https://kaylousberg.com/), from the [official KayKit Adventurers repository](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0).
- [Space Grotesk font license](public/fonts/SpaceGrotesk-OFL.txt), SIL Open Font License 1.1, by the Space Grotesk Project Authors.
- [Lootmon logo and pack-art prompts and saved paths](docs/LOOTMON_ART.json). Created with the built-in image generator. Tier packaging is illustrative artwork; actual rewards come from verified provider inventory.
- The island is assembled from project-owned Three.js geometry. Sound effects are synthesized locally with Web Audio; no external audio files or sound-service requests are required.

Automated checks cover eligibility boundaries, movement/collision enforcement, pickup and theft rules, private pack discovery, restart persistence, spending policy, transaction-intent validation, pending purchase/award recovery, and single-authority behavior. Passing them is not a claim of an independent security audit or proof of a completed mainnet launch.
