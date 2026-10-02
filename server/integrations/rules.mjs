export const PACK_TIERS = [25, 50, 100, 250, 500];
export function eligible(amounts, supply) {
  const total = BigInt(supply);
  return total > 0n && amounts.reduce((sum, amount) => sum + BigInt(amount), 0n) * 400n >= total;
}
