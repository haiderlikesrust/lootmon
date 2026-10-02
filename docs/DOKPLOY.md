# Deploy Lootmon on Dokploy

This follows the Grailshot hosting arrangement: Dokploy Traefik provides HTTPS, an Nginx gateway forwards requests, and PostgreSQL 17 stores the treasury ledger. Lootmon's single Node authority also serves the built frontend, so a separate web container is unnecessary. Only the gateway joins `dokploy-network`; the game and database publish no host ports.

## Configure the Compose service

1. Create a **Docker Compose** service from the Lootmon Git repository. Select branch `codex/lootmon-launch` and set Compose Path to `compose.dokploy.yaml` at the repository root. Choose ordinary Docker Compose rather than Swarm/Stack.
2. Paste [`deploy/dokploy.env.example`](../deploy/dokploy.env.example) into Dokploy's **Environment** panel. Use `APP_ORIGIN=https://lootmon.xyz`, with no path or trailing slash. Generate a long random alphanumeric `POSTGRES_PASSWORD`; `openssl rand -hex 32` is suitable. Compose uses it for both PostgreSQL and the game's connection URL, so do not add `DATABASE_URL` here.
3. Enter the game's `MEMECOIN_MINT`, your RPC endpoint, treasury signing key, Jupiter key, and verified Collector Crypt payment wallet when available. Set `X_ACCOUNT_URL` to the project's full X profile URL if you want it shown publicly. Leave `MAINNET_ENABLED=false` during setup. The key is the treasury's base58 64-byte secret key or a quoted JSON array of 64 bytes; keep it in runtime environment settings only.
4. Point the DNS for `lootmon.xyz` at the Dokploy VPS. Add the domain to service **gateway**, container port **8080**, path **/**, and enable HTTPS/Let's Encrypt. Preserve the path when routing. Keep both the `app` and `dokploy-network` gateway connections in Dokploy's Compose preview. Port 8080 is internal to the gateway; this stack does not bind a host port, and visitors use `https://lootmon.xyz` normally.
5. Deploy and wait for PostgreSQL, the game, and the gateway to become healthy. Open the HTTPS domain. Island exploration and the actual artwork work before live configuration is complete; real multiplayer and rewards retain the verified wallet gate.

The sample has nine settings. Ports, storage directories, proxy trust, and game policy stay in code/Compose. `MAINNET_ENABLED=true` enables the worker's real financial paths once its required configuration passes validation. Do not enable it simply to clear a health warning: `/api/status` reports funding readiness and blockers separately from HTTP availability.

The public browser calls `/api/*` and `wss://lootmon.xyz/ws` on the same origin. No separate API domain or frontend API environment variable is required. Compose maps secrets into the game service only; `.dockerignore` keeps env files and local data out of builds. If Collector Crypt provides a partner API key, explicitly add `COLLECTOR_CRYPT_API_KEY` to the game environment mapping; it is optional and absent from the minimal sample.

## Verify without spending

After installing the repository's Node dependencies, run:

```sh
node scripts/smoke-dokploy.mjs https://lootmon.xyz
```

This sends only public GET requests and one anonymous WebSocket handshake. It checks the built page, bundled JavaScript/CSS, logo and five packs, all three character models, fonts, gateway headers, public APIs, private collection/session protection, and rejection of an unsigned socket. It does not sign a wallet, create a player, submit a purchase, or transfer funds. An authenticated 101 upgrade and two-holder gameplay still need a separate manual check with real eligible wallets. The offline server integration test exercises that authentication protocol against a local mock RPC without a production bypass.

From the game container's terminal, run `node scripts/preflight.mjs` for an offline syntax check. `node scripts/preflight.mjs --live` requires complete live configuration and `MAINNET_ENABLED=true`, but still makes no network requests or transactions. Neither this check nor a green container proves RPC access, provider acceptance, inventory, database connectivity, or spendable funds. When funding is disabled or incomplete, the provider deliberately stays offline.

Open the site in a wallet-enabled browser to verify live access after launch configuration is complete. The login cookie must be Secure and HttpOnly. Check `/ws` upgrades with status 101 after sign-in, measured ping updates, and two distinct eligible wallets receive separate home bases. Verify the configured coin address and X link in the page before announcing the URL.

## Keep one authority and preserve both volumes

Run exactly one game container. Do not enable rolling overlap, blue/green authorities, or multiple game replicas. The Node process owns world timers and socket players. The container entrypoint holds a Linux `flock` for its entire lifetime; the kernel releases that lock after a crash without relying on reused container PIDs. The provider also holds a PostgreSQL advisory lease, preventing another game with different local storage from replaying the same prize inventory. Losing that database lease stops the authority.

The project-scoped `lootmon-game-data` volume stores world packs, wallet collections, delivery claims, and cooldowns. `lootmon-postgres` stores provider jobs, reservations, purchase/award records, and the financial ledger. Back up **both together** while the authority is stopped and test restoring them as a pair. Do not remove either volume during an update, and keep the same Dokploy project/Compose identity so redeploys reuse them. Never delete `authority.flock` to recover a running world.

For planned maintenance, stop new activity, allow pending purchases/deliveries to settle, then stop the game gracefully before replacing it. Interrupted financial jobs are durably recorded for reconciliation; an HTTP health check is not confirmation that a transfer completed. Sessions are held in memory, so players sign in again after a process restart. Inspect funding/recovery status after restarting.

Do not change the treasury wallet or coin mint on an existing financial ledger. The provider binds that ledger to its original identities and refuses mismatches. Do not rotate `POSTGRES_PASSWORD` in the environment alone on an existing volume; PostgreSQL must also have its role password changed. Keep tested backups before any such operation.

## Networking and recovery

The game trusts exactly two internal proxy hops: Traefik and Nginx. Nginx appends the source chain with `$proxy_add_x_forwarded_for`, and the game rate-limits by the resulting client address. Keep port 8787 private. If a CDN is added before Traefik, configure Traefik's trusted forwarding sources instead of enabling blanket trust or changing hop counts without reviewing the path.

Nginx resolves Docker DNS repeatedly, so replacing the game container does not leave a stale upstream address. WebSocket timeouts allow the server's heartbeat. Authenticated APIs remain uncompressed and uncached. Content-hashed Vite assets cache for one year; artwork and models retain the server's one-hour cache.

Compose restarts exited processes. A failed health check alone does not restart a container; inspect logs and restore the failed dependency. `/api/ping` proves the process is serving requests. `/api/status` reports the live gate and funding status without exposing hidden pack locations. No treasury secrets should be pasted into logs or public issue reports.

## Local validation

```sh
npm ci
npm test
npm run build
docker compose --env-file deploy/dokploy.env -f compose.dokploy.yaml config --quiet
docker compose --env-file deploy/dokploy.env -f compose.dokploy.yaml build
```

Create `deploy/dokploy.env` locally from the example with a temporary password and `MAINNET_ENABLED=false`. It is ignored by Git and Docker. The external `dokploy-network` normally comes from Dokploy. A standalone Docker smoke environment must create its own equivalent network and publish a temporary gateway port with a local override; no host ports are published by the production file.

For testing a direct local Node server, `node scripts/smoke-dokploy.mjs http://127.0.0.1:8787 --direct` skips only gateway-header/cache assertions. Full proxy verification requires the Nginx stack. These files prepare deployment; they do not publish, connect to, or change a remote Dokploy installation automatically.

GitHub Actions runs the tests, collision-data check, client build, and actual three-container stack on an isolated Linux runner. It uses [`deploy/compose.ci.yaml`](../deploy/compose.ci.yaml) to publish the gateway on localhost only, with no treasury key and mainnet disabled. The job checks Nginx and PostgreSQL, runs the public smoke, rejects a duplicate authority with exit code 75, kills the first authority abruptly, then verifies restart through the gateway with the stale PID file still present. The job removes only its disposable project and volumes. Wait for **Verify Lootmon and Dokploy** to pass before relying on that container-level verification.
