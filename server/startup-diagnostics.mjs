// Only fixed, reviewed text reaches logs. Driver errors can contain credentials,
// connection URLs, SQL parameters, or fragments of a private-key input.
const CODES = new Map([
  ['28P01', 'PostgreSQL rejected the password. POSTGRES_PASSWORD must match the existing lootmon database role; changing the container environment does not rotate that role password.'],
  ['28000', 'PostgreSQL rejected authentication. Check the database role and authentication configuration.'],
  ['3D000', 'The configured PostgreSQL database does not exist. Check POSTGRES_DB and the existing database volume.'],
  ['42501', 'The database role lacks permission to initialize the provider ledger. Restore its existing database ownership and permissions.'],
  ['42P01', 'A required saved database table is missing. Preserve both volumes and inspect the existing coin profile tables before attempting recovery.'],
  ['42703', 'A required database column is missing. Check that the deployed version and saved database schema match.'],
  ['23505', 'A saved database identity or record conflicts with initialization. Preserve the existing ledger and inspect its coin profiles.'],
  ['53300', 'PostgreSQL has no available connections. Check database connection usage.'],
  ['57P03', 'PostgreSQL is not yet accepting connections. Check the postgres container logs.'],
  ['ECONNREFUSED', 'Database connection was refused. Check that postgres is running and game shares its database network.'],
  ['ENOTFOUND', 'Database hostname could not be resolved. Check the postgres service name and shared database network.'],
  ['EAI_AGAIN', 'Database DNS lookup temporarily failed. Check the Docker network and retry after DNS recovers.'],
  ['ETIMEDOUT', 'Database connection timed out. Check database availability and the private Docker network.'],
  ['ECONNRESET', 'Database connection was reset. Check the postgres container logs.'],
  ['EACCES', 'Access to saved game data was denied. Check game-data volume ownership and permissions.'],
  ['EPERM', 'Saved game data could not be accessed. Check game-data volume permissions.'],
  ['ENOSPC', 'Storage is full. Free disk space without deleting the game or PostgreSQL data volumes.'],
  ['EROFS', 'Saved game data is on a read-only filesystem. Check that the persistent game-data volume is mounted at GAME_DATA_DIR.'],
]);
const MESSAGES = new Map([
  ['TREASURY_PRIVATE_KEY is invalid. Use a base58-encoded 64-byte Solana private key or a JSON array of 64 byte values.', ['TREASURY_KEY_INVALID', 'TREASURY_PRIVATE_KEY has an invalid format. Restore the original treasury key as base58 or a JSON array of 64 bytes.']],
  ['Treasury signing key is required', ['TREASURY_KEY_MISSING', 'TREASURY_PRIVATE_KEY is missing. Restore the original treasury signing key.']],
  ['Another game authority already owns this provider database', ['AUTHORITY_BUSY', 'Another game server owns this database. Stop the duplicate game instance; do not delete saved data or locks.']],
  ['Provider ledger identity does not match this CA and treasury', ['PROFILE_MISMATCH', 'The configured CA and treasury do not match the saved provider identity. Restore their original configuration.']],
  ['This CA belongs to a different treasury wallet. Restore its original treasury key.', ['TREASURY_CHANGED', 'This CA belongs to a different treasury wallet. Restore its original treasury key.']],
  ['A valid MEMECOIN_MINT is required for a coin profile', ['MINT_INVALID', 'MEMECOIN_MINT is not a valid Solana address.']],
  ['Game data belongs to a different CA', ['WORLD_CA_MISMATCH', 'Saved game data belongs to another CA. Restore the matching CA configuration; preserve both volumes.']],
  ['Game data is invalid. Refusing to overwrite the durable prize ledger.', ['WORLD_INVALID', 'Saved game data failed validation. Preserve the file and restore a verified backup; do not initialize an empty world.']],
]);
for (const key of ['MEMECOIN_MINT', 'COLLECTOR_CRYPT_PAYMENT_WALLET', 'CARDS_MINT', 'USDC_MINT']) {
  MESSAGES.set(`${key} must be a valid Solana public key`, ['PUBLIC_KEY_INVALID', `${key} must contain a valid Solana public address.`]);
}

export function startupDiagnostic(error, stage = 'treasury') {
  const phase = ['treasury', 'world', 'community'].includes(stage) ? stage : 'startup';
  const queue = [error], seen = new Set();
  let syntaxError = false;
  for (let i = 0; i < queue.length && i < 16; i++) {
    const item = queue[i];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const known = CODES.get(item.code);
    if (known) return `[startup:${phase}:${item.code}] ${known}`;
    const message = MESSAGES.get(item.message);
    if (message) return `[startup:${phase}:${message[0]}] ${message[1]}`;
    if (typeof item.message === 'string' && /^CA switch blocked: restore MEMECOIN_MINT=[1-9A-HJ-NP-Za-km-z]{32,44} and finish its pending payment or award recovery first\.$/.test(item.message)) {
      return `[startup:${phase}:CA_SWITCH_PENDING] ${item.message}`;
    }
    if (item instanceof SyntaxError) syntaxError = true;
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors.slice(0, 8));
  }
  if (syntaxError && phase !== 'treasury') return `[startup:${phase}:SAVED_JSON_INVALID] Saved state could not be parsed. Preserve both data volumes and inspect the saved file or restore a verified backup.`;
  return `[startup:${phase}:INITIALIZATION_FAILED] Initialization failed. Check configuration and postgres logs; preserve both data volumes. Raw error details are withheld to protect credentials.`;
}
