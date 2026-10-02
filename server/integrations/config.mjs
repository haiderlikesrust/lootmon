// Server-only configuration; this module must never be imported by the client.
export const config = {};

export function configure(env = process.env) {
  const string = key => typeof env[key] === 'string' ? env[key].trim() : '';
  Object.assign(config, {
    live: string('MAINNET_ENABLED') === 'true',
    DATABASE_URL: string('DATABASE_URL'),
    MEMECOIN_MINT: string('MEMECOIN_MINT'),
    FEE_RECIPIENT: '', // Derived from TREASURY_PRIVATE_KEY; creator-fee authority is verified on-chain.
    TREASURY_PRIVATE_KEY: string('TREASURY_PRIVATE_KEY'),
    SOLANA_RPC_URL: string('SOLANA_RPC_URL'),
    JUPITER_API_KEY: string('JUPITER_API_KEY'),
    COLLECTOR_CRYPT_API_KEY: string('COLLECTOR_CRYPT_API_KEY'),
    COLLECTOR_CRYPT_PAYMENT_WALLET: string('COLLECTOR_CRYPT_PAYMENT_WALLET'),
    CARDS_MINT: 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp',
    USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    GAS_RESERVE_SOL: 0.05,
    SLIPPAGE_BPS: 100,
    TREASURY_RESERVE_USD: 500,
    DAILY_CAP_USD: 1500,
    MAX_CYCLE_USD: 1000,
  });
  return config;
}

export function configBlockers() {
  const required = ['DATABASE_URL', 'MEMECOIN_MINT', 'TREASURY_PRIVATE_KEY', 'SOLANA_RPC_URL', 'JUPITER_API_KEY', 'COLLECTOR_CRYPT_PAYMENT_WALLET'];
  return [...required.filter(key => !config[key]).map(key => `Configure ${key}`), ...(!config.live ? ['Mainnet spending is disabled'] : [])];
}
