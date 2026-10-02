import { createHash } from 'node:crypto';
import { isPublicKey } from './auth.mjs';

export class CoinProfileError extends Error {}

export function coinKey(mint) {
  if (!isPublicKey(mint)) throw new Error('A valid MEMECOIN_MINT is required for a coin profile');
  return createHash('sha256').update(mint).digest('hex').slice(0, 24);
}

export function profileSql(sql, prefix) {
  if (!/^(cards_provider_|lc_[a-f0-9]{24}_)$/.test(prefix)) throw new Error('Invalid coin table prefix');
  return sql.replace(/\bcards_provider_/g, prefix);
}

// Called under the database-wide authority lease. Existing tables stay in place;
// their immutable identity assigns them to the original coin without copying money.
export async function selectProviderProfile(pool, mint, wallet) {
  await pool.query(`CREATE TABLE IF NOT EXISTS lootmon_coin_profiles (
    coin_mint TEXT PRIMARY KEY, treasury_wallet TEXT NOT NULL, table_prefix TEXT NOT NULL UNIQUE
  )`);
  const legacyExists = (await pool.query("SELECT to_regclass('cards_provider_identity') AS relation")).rows[0].relation;
  if (legacyExists) {
    const legacy = (await pool.query('SELECT coin_mint,treasury_wallet FROM cards_provider_identity WHERE id=1')).rows[0];
    if (legacy) await pool.query(`INSERT INTO lootmon_coin_profiles VALUES($1,$2,'cards_provider_') ON CONFLICT(coin_mint) DO NOTHING`, [legacy.coin_mint, legacy.treasury_wallet]);
  }
  const profiles = (await pool.query('SELECT * FROM lootmon_coin_profiles')).rows;
  let selected = profiles.find(row => row.coin_mint === mint);
  if (selected && selected.treasury_wallet !== wallet) throw new CoinProfileError('This CA belongs to a different treasury wallet. Restore its original treasury key.');
  for (const profile of profiles.filter(row => row.coin_mint !== mint)) {
    // Never orphan signed transactions, fee routing, or a promised transfer.
    const pending = (await pool.query(profileSql(`SELECT
      EXISTS(SELECT 1 FROM cards_provider_reservations WHERE status NOT IN ('complete','refunded')) OR
      EXISTS(SELECT 1 FROM cards_provider_awards WHERE status <> 'confirmed') OR
      EXISTS(SELECT 1 FROM cards_provider_jobs WHERE kind <> 'recovery' AND status NOT IN ('complete','confirmed','refunded')) AS pending`, profile.table_prefix))).rows[0].pending;
    if (pending) throw new CoinProfileError(`CA switch blocked: restore MEMECOIN_MINT=${profile.coin_mint} and finish its pending payment or award recovery first.`);
  }
  if (!selected) {
    selected = { coin_mint: mint, treasury_wallet: wallet, table_prefix: profiles.length ? `lc_${coinKey(mint)}_` : 'cards_provider_' };
    // Registration happens after table initialization, so interruption can never
    // leave a registry entry pointing at missing financial tables.
  }
  return { selected, legacyMint: profiles.find(row => row.table_prefix === 'cards_provider_')?.coin_mint ?? mint,
    async register() {
      await pool.query('INSERT INTO lootmon_coin_profiles VALUES($1,$2,$3) ON CONFLICT(coin_mint) DO NOTHING', [mint, wallet, selected.table_prefix]);
    },
    async prizeOwnedElsewhere(prizeMint) {
      for (const profile of profiles.filter(row => row.coin_mint !== mint)) {
        const result = await pool.query(profileSql('SELECT 1 FROM cards_provider_prizes WHERE mint=$1 LIMIT 1', profile.table_prefix), [prizeMint]);
        if (result.rows.length) return true;
      }
      return false;
    },
    async dailyCommitted(dayStart) {
      const walletProfiles = (await pool.query('SELECT * FROM lootmon_coin_profiles WHERE treasury_wallet=$1', [wallet])).rows;
      let total = 0n;
      for (const profile of walletProfiles) {
        const row = (await pool.query(profileSql(`SELECT
          COALESCE((SELECT SUM(amount_micros) FROM cards_provider_ledger WHERE kind='pack' AND created_at >= $1),0)::text AS spent,
          COALESCE((SELECT SUM(r.amount_micros) FROM cards_provider_ledger r JOIN cards_provider_ledger p ON p.id=r.data->>'purchaseId'
            WHERE r.kind='refund' AND r.data->>'verified'='true' AND p.kind='pack' AND p.created_at >= $1),0)::text AS refunded,
          COALESCE((SELECT SUM(tier*1000000::bigint) FROM cards_provider_reservations r WHERE created_at >= $1
            AND NOT EXISTS(SELECT 1 FROM cards_provider_ledger l WHERE l.id='pack:'||r.id)),0)::text AS reserved`, profile.table_prefix), [dayStart])).rows[0];
        total += BigInt(row.spent) - BigInt(row.refunded) + BigInt(row.reserved);
      }
      return total;
    },
  };
}
