import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeBase58(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 90) throw new Error('Invalid base58 value.');
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) throw new Error('Invalid base58 value.');
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (const character of value) { if (character !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
export function isPublicKey(value) {
  try { return decodeBase58(value).length === 32; } catch { return false; }
}
export function holdingEligibility(balance, supply) {
  const amount = BigInt(balance);
  const total = BigInt(supply);
  if (amount < 0n || total <= 0n || amount > total) throw new Error('Invalid token balance or supply.');
  return {
    eligible: amount * 400n >= total,
    elite: amount * 50n > total,
    holdPercent: Number(amount * 1_000_000n / total) / 10_000,
  };
}
export async function fetchHoldings({ wallet, mint, rpcUrl, fetchImpl = fetch }) {
  const rpc = async (method, params) => {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Holdings verification is temporarily unavailable.');
    const payload = await response.json();
    if (payload.error || !payload.result) throw new Error('Holdings verification is temporarily unavailable.');
    return payload.result;
  };
  const [supplyResult, accountsResult] = await Promise.all([
    rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]),
    rpc('getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
  ]);
  if (!Array.isArray(accountsResult.value) || !/^\d+$/.test(supplyResult.value?.amount ?? '')) throw new Error('Invalid RPC holdings response.');
  let balance = 0n;
  for (const account of accountsResult.value) {
    const info = account.account?.data?.parsed?.info;
    if (!info || info.owner !== wallet || info.mint !== mint || !/^\d+$/.test(info.tokenAmount?.amount ?? '')) throw new Error('Invalid RPC token account.');
    // Frozen accounts remain holdings; delegated balances still belong to owner.
    balance += BigInt(info.tokenAmount.amount);
  }
  return { ...holdingEligibility(balance, supplyResult.value.amount), balance: balance.toString(), supply: supplyResult.value.amount };
}

export class Auth {
  constructor({ mint = process.env.MEMECOIN_MINT, rpcUrl = process.env.SOLANA_RPC_URL, domain = process.env.APP_ORIGIN || 'http://localhost:5173', now = Date.now, checkHoldings = fetchHoldings } = {}) {
    this.mint = mint || null;
    this.rpcUrl = rpcUrl || null;
    this.domain = domain;
    this.now = now;
    this.checkHoldings = checkHoldings;
    this.challenges = new Map();
    this.sessions = new Map();
    this.revalidations = new Map();
    this.sessionLifetimeMs = 60 * 60_000;
  }
  get configured() { return isPublicKey(this.mint) && Boolean(this.rpcUrl); }
  get missingConfig() {
    return [!isPublicKey(this.mint) && 'MEMECOIN_MINT', !this.rpcUrl && 'SOLANA_RPC_URL'].filter(Boolean);
  }
  issueChallenge(wallet) {
    if (!this.configured) throw Object.assign(new Error('The CARDS mint and Solana RPC must be configured before wallet sign-in.'), { status: 503 });
    if (!isPublicKey(wallet)) throw Object.assign(new Error('Invalid Solana wallet address.'), { status: 400 });
    const now = this.now();
    this.prune(now);
    if (this.challenges.size >= 5000) throw Object.assign(new Error('Sign-in is busy. Try again shortly.'), { status: 429 });
    const nonce = randomBytes(24).toString('base64url');
    const expiresAt = now + 5 * 60_000;
    const message = `${this.domain} requests wallet ownership verification for CARDS.\n\nWallet: ${wallet}\nMint: ${this.mint}\nNonce: ${nonce}\nIssued at: ${new Date(now).toISOString()}\nExpires at: ${new Date(expiresAt).toISOString()}\n\nSign in to hunt. This signature does not submit a transaction or authorize token spending.`;
    this.challenges.set(nonce, { wallet, message, expiresAt });
    return { wallet, nonce, message, expiresAt };
  }
  async verify({ wallet, nonce, signature }) {
    if (!this.configured) throw Object.assign(new Error('Live wallet sign-in is not configured.'), { status: 503 });
    const challenge = this.challenges.get(nonce);
    this.challenges.delete(nonce); // Single-use even when a signature fails.
    if (!challenge || challenge.wallet !== wallet || challenge.expiresAt <= this.now()) throw Object.assign(new Error('Challenge is invalid or expired. Request a new signature.'), { status: 401 });
    let valid = false;
    try {
      if (typeof signature !== 'string' || signature.length > 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error('Invalid signature encoding.');
      const signatureBytes = Buffer.from(signature, 'base64');
      const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeBase58(wallet)]), format: 'der', type: 'spki' });
      valid = signatureBytes.length === 64 && verifySignature(null, Buffer.from(challenge.message, 'utf8'), publicKey, signatureBytes);
    } catch { valid = false; }
    if (!valid) throw Object.assign(new Error('The wallet signature could not be verified.'), { status: 401 });
    const holdings = await this.checkHoldings({ wallet, mint: this.mint, rpcUrl: this.rpcUrl });
    if (!holdings.eligible) throw Object.assign(new Error('A holding of at least 0.25% of the token supply is required to play.'), { status: 403 });
    const token = randomBytes(32).toString('base64url');
    const session = { token, wallet, ...holdings, expiresAt: this.now() + this.sessionLifetimeMs, verifiedAt: this.now() };
    this.sessions.set(token, session);
    return session;
  }
  sessionFromCookie(cookie = '') {
    const entry = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('cards_session='));
    const token = entry?.slice('cards_session='.length);
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= this.now()) { if (token) this.sessions.delete(token); return null; }
    return session;
  }
  revalidate(session) {
    const live = () => session && this.sessions.get(session.token) === session && session.expiresAt > this.now();
    if (!live()) { this.revoke(session); return Promise.resolve(false); }
    const previous = this.revalidations.get(session.token);
    if (previous?.session === session) return previous.promise;
    const attempt = { session, promise: null };
    // Defer the RPC until this promise is registered, so concurrent callers
    // share one observation instead of committing responses out of order.
    attempt.promise = Promise.resolve().then(async () => {
      if (!live()) { this.revoke(session); return false; }
      try {
        const holdings = await this.checkHoldings({ wallet: session.wallet, mint: this.mint, rpcUrl: this.rpcUrl });
        // Logout, expiry, or replacement may have happened while RPC was pending.
        if (!live()) { this.revoke(session); return false; }
        if (!holdings.eligible) { this.revoke(session); return false; }
        Object.assign(session, holdings, { verifiedAt: this.now() });
        return true;
      } catch {
        // A stale failed request must not revoke a newer session object.
        this.revoke(session);
        return false;
      }
    }).finally(() => {
      if (this.revalidations.get(session.token) === attempt) this.revalidations.delete(session.token);
    });
    this.revalidations.set(session.token, attempt);
    return attempt.promise;
  }
  revoke(session) { if (session && this.sessions.get(session.token) === session) this.sessions.delete(session.token); }
  prune(now = this.now()) {
    for (const [nonce, item] of this.challenges) if (item.expiresAt <= now) this.challenges.delete(nonce);
    for (const [token, item] of this.sessions) if (item.expiresAt <= now) this.sessions.delete(token);
  }
}
