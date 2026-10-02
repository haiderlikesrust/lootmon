import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublicKey } from '../server/auth.mjs';
import { treasurySigner } from '../server/integrations/treasury-signer.mjs';
import { publicSite } from '../server/public-site.mjs';

const REQUIRED = ['APP_ORIGIN', 'MEMECOIN_MINT', 'SOLANA_RPC_URL', 'DATABASE_URL', 'TREASURY_PRIVATE_KEY', 'JUPITER_API_KEY', 'COLLECTOR_CRYPT_PAYMENT_WALLET'];
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

/** Syntax-only check. It never calls RPC, the database, or a financial provider. */
export function inspectConfiguration(env = process.env, { requireLive = false, nodeVersion = process.versions.node } = {}) {
  const value = key => typeof env[key] === 'string' ? env[key].trim() : '';
  const issues = [];
  const missing = REQUIRED.filter(key => !value(key));
  const enabled = value('MAINNET_ENABLED') === 'true';
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!Number.isInteger(major) || major < 22 || major === 22 && minor < 13) issues.push('Node.js 22.13.0 or newer is required.');
  if (value('MAINNET_ENABLED') && !['true', 'false'].includes(value('MAINNET_ENABLED'))) issues.push('MAINNET_ENABLED must be true or false.');
  if (requireLive && !enabled) issues.push('MAINNET_ENABLED must be true for a live launch.');
  if (enabled || requireLive) issues.push(...missing.map(key => `${key} is required for a live launch.`));

  for (const key of ['MEMECOIN_MINT', 'COLLECTOR_CRYPT_PAYMENT_WALLET']) {
    if (value(key) && !isPublicKey(value(key))) issues.push(`${key} must be a valid 32-byte Solana public key.`);
  }
  if (value('TREASURY_PRIVATE_KEY')) {
    try { if (!treasurySigner(value('TREASURY_PRIVATE_KEY'))) throw new Error(); }
    catch { issues.push('TREASURY_PRIVATE_KEY must be a valid base58 64-byte key or JSON array of 64 bytes.'); }
  }
  if (value('APP_ORIGIN')) {
    try {
      const url = new URL(value('APP_ORIGIN'));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      if (url.protocol !== 'https:' && !loopback(url.hostname)) throw new Error();
    } catch { issues.push('APP_ORIGIN must be one HTTPS origin without a path or credentials; HTTP is allowed for localhost.'); }
  }
  if (value('SOLANA_RPC_URL')) {
    try {
      const url = new URL(value('SOLANA_RPC_URL'));
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash || url.username || url.password) throw new Error();
      if (url.protocol !== 'https:' && !loopback(url.hostname)) throw new Error();
    } catch { issues.push('SOLANA_RPC_URL must be an HTTPS endpoint; HTTP is allowed for a local RPC proxy.'); }
  }
  if (value('DATABASE_URL')) {
    try {
      const url = new URL(value('DATABASE_URL'));
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/' || url.hash) throw new Error();
    } catch { issues.push('DATABASE_URL must be a PostgreSQL connection URL with a database name.'); }
  }
  if (value('JUPITER_API_KEY') && /[\r\n]/.test(value('JUPITER_API_KEY'))) issues.push('JUPITER_API_KEY must not contain line breaks.');
  if (value('X_ACCOUNT_URL') && !publicSite(env).xUrl) issues.push('X_ACCOUNT_URL must be an HTTPS X or Twitter profile URL, such as https://x.com/your_account.');
  return { enabled, ready: enabled && missing.length === 0 && issues.length === 0, valid: issues.length === 0, missing, issues };
}

export function runPreflight(args = process.argv.slice(2), env = process.env) {
  if (args.some(argument => argument !== '--live')) {
    console.error('Unsupported preflight option. Use --live to require complete live configuration.');
    return 1;
  }
  const report = inspectConfiguration(env, { requireLive: args.includes('--live') });
  for (const issue of report.issues) console.error(`- ${issue}`);
  console.log(`Live transactions: ${report.enabled ? 'enabled by configuration' : 'disabled'}.`);
  if (!report.enabled && report.missing.length) console.log(`Missing live configuration: ${report.missing.join(', ')}.`);
  if (report.valid) console.log('Configuration syntax check passed. No network requests or transactions were performed.');
  else console.error('Configuration check failed. No network requests or transactions were performed.');
  if (report.ready) console.log('RPC access, database access, fee authority, provider acceptance, inventory, and funds still require runtime verification.');
  return report.valid ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runPreflight();
