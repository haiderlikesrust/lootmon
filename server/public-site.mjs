import { isPublicKey } from './auth.mjs';

// These are public identities, never provider credentials or arbitrary links.
export function publicSite(env = process.env) {
  const contractAddress = isPublicKey(env.MEMECOIN_MINT) ? env.MEMECOIN_MINT : null;
  let xUrl = null;
  try {
    const url = new URL(env.X_ACCOUNT_URL);
    if (url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(url.pathname)) {
      xUrl = `https://x.com/${url.pathname.split('/')[1]}`;
    }
  } catch { /* An unconfigured account has no public link. */ }
  return { contractAddress, xUrl };
}
