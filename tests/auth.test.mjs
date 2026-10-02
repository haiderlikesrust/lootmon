import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Auth, decodeBase58, holdingEligibility, fetchHoldings } from '../server/auth.mjs';

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = BigInt(`0x${bytes.toString('hex')}`);
  let output = '';
  while (number > 0n) { output = alphabet[Number(number % 58n)] + output; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; output = '1' + output; }
  return output;
}
function setup({ holdings = { eligible: true, elite: false, holdPercent: 0.25 }, clock = () => 1_000_000 } = {}) {
  const key = generateKeyPairSync('ed25519');
  const raw = key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const wallet = base58(raw);
  const auth = new Auth({ mint: wallet, rpcUrl: 'https://rpc.invalid', now: clock, checkHoldings: async () => holdings });
  return { wallet, key, auth };
}
const signed = (challenge, key) => ({ wallet: challenge.wallet, nonce: challenge.nonce, signature: sign(null, Buffer.from(challenge.message), key.privateKey).toString('base64') });

test('integer eligibility is inclusive at 0.25% and elite is strictly above 2%', () => {
  assert.equal(holdingEligibility('2499', '1000000').eligible, false);
  assert.equal(holdingEligibility('2500', '1000000').eligible, true);
  assert.equal(holdingEligibility('20000', '1000000').elite, false);
  assert.equal(holdingEligibility('20001', '1000000').elite, true);
  assert.equal(holdingEligibility('2500000000000000', '1000000000000000000').eligible, true);
  assert.throws(() => holdingEligibility('1', '0'));
});

test('a valid wallet signature establishes a session and nonce cannot be replayed', async () => {
  const { wallet, key, auth } = setup();
  assert.equal(decodeBase58(wallet).length, 32);
  const challenge = auth.issueChallenge(wallet);
  const proof = signed(challenge, key);
  const session = await auth.verify(proof);
  assert.equal(session.wallet, wallet);
  assert.equal(auth.sessionFromCookie(`cards_session=${session.token}`).wallet, wallet);
  await assert.rejects(auth.verify(proof), /invalid or expired/);
  auth.revoke(session);
  assert.equal(auth.sessionFromCookie(`cards_session=${session.token}`), null);
});

test('invalid signature, wrong wallet, expired challenge, and insufficient holdings fail closed', async () => {
  const { wallet, key, auth } = setup();
  const challenge = auth.issueChallenge(wallet);
  await assert.rejects(auth.verify({ ...signed(challenge, key), signature: Buffer.alloc(64).toString('base64') }), /signature/);
  const another = auth.issueChallenge(wallet);
  await assert.rejects(auth.verify({ ...signed(another, key), wallet: '11111111111111111111111111111111' }), /invalid or expired/);
  let time = 1_000_000;
  const expired = setup({ clock: () => time });
  const expiredChallenge = expired.auth.issueChallenge(expired.wallet);
  time += 300_000;
  await assert.rejects(expired.auth.verify(signed(expiredChallenge, expired.key)), /invalid or expired/);
  const ineligible = setup({ holdings: { eligible: false, elite: false, holdPercent: 0.1 } });
  await assert.rejects(ineligible.auth.verify(signed(ineligible.auth.issueChallenge(ineligible.wallet), ineligible.key)), /0.25%/);
});

test('loss of eligibility or RPC verification revokes an existing session', async () => {
  const { wallet, key, auth } = setup();
  const session = await auth.verify(signed(auth.issueChallenge(wallet), key));
  auth.checkHoldings = async () => { throw new Error('RPC unavailable'); };
  assert.equal(await auth.revalidate(session), false);
  assert.equal(auth.sessionFromCookie(`cards_session=${session.token}`), null);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('logout while holdings RPC is pending cannot restore or authorize the revoked session', async () => {
  let clock = 1_000_000;
  const { wallet, key, auth } = setup({ clock: () => clock });
  const session = await auth.verify(signed(auth.issueChallenge(wallet), key));
  const before = { ...session };
  const rpc = deferred();
  let calls = 0;
  auth.checkHoldings = () => { calls++; return rpc.promise; };
  const first = auth.revalidate(session);
  const second = auth.revalidate(session);
  await Promise.resolve();
  assert.equal(calls, 1);
  auth.revoke(session);
  clock += 5000;
  rpc.resolve({ eligible: true, elite: true, holdPercent: 5 });
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.deepEqual(session, before, 'revoked session evidence must not be refreshed');
  assert.equal(auth.sessionFromCookie(`cards_session=${session.token}`), null);
  assert.equal(await auth.revalidate(session), false);
  assert.equal(calls, 1);
  assert.equal(auth.revalidations.size, 0);
});

test('session expiry during holdings RPC fails closed even without a prune pass', async () => {
  let clock = 1_000_000;
  const { wallet, key, auth } = setup({ clock: () => clock });
  const session = await auth.verify(signed(auth.issueChallenge(wallet), key));
  const verifiedAt = session.verifiedAt;
  const rpc = deferred();
  auth.checkHoldings = () => rpc.promise;
  const refresh = auth.revalidate(session);
  await Promise.resolve();
  clock = session.expiresAt;
  rpc.resolve({ eligible: true, elite: true, holdPercent: 5 });
  assert.equal(await refresh, false);
  assert.equal(session.verifiedAt, verifiedAt);
  assert.equal(session.elite, false);
  assert.equal(auth.sessions.has(session.token), false);
  assert.equal(auth.revalidations.size, 0);
});

test('concurrent session refreshes use one holdings observation and a later refresh starts after it settles', async () => {
  let clock = 1_000_000;
  const { wallet, key, auth } = setup({ clock: () => clock });
  const session = await auth.verify(signed(auth.issueChallenge(wallet), key));
  const rpc = deferred();
  let calls = 0;
  auth.checkHoldings = () => { calls++; return rpc.promise; };
  const refreshes = Array.from({ length: 12 }, () => auth.revalidate(session));
  await Promise.resolve();
  assert.equal(calls, 1, 'concurrent requests cannot commit stale responses out of order');
  clock += 3000;
  rpc.resolve({ eligible: true, elite: true, holdPercent: 3 });
  assert.deepEqual(await Promise.all(refreshes), Array(12).fill(true));
  assert.equal(session.verifiedAt, clock);
  assert.equal(session.elite, true);
  assert.equal(auth.revalidations.size, 0);
  auth.checkHoldings = async () => { calls++; return { eligible: true, elite: false, holdPercent: 0.25 }; };
  clock += 1000;
  assert.equal(await auth.revalidate(session), true);
  assert.equal(calls, 2);
  assert.equal(session.elite, false);
  assert.equal(session.verifiedAt, clock);
});

test('stale session success or failure cannot modify or revoke a replacement with the same token', async () => {
  for (const failure of [false, true]) {
    const { wallet, key, auth } = setup();
    const session = await auth.verify(signed(auth.issueChallenge(wallet), key));
    const originalRpc = deferred();
    const replacementRpc = deferred();
    let calls = 0;
    auth.checkHoldings = () => (++calls === 1 ? originalRpc : replacementRpc).promise;
    const stale = auth.revalidate(session);
    await Promise.resolve();
    const replacement = { ...session };
    auth.sessions.set(session.token, replacement);
    const current = auth.revalidate(replacement);
    await Promise.resolve();
    assert.equal(calls, 2);
    if (failure) originalRpc.reject(new Error('stale RPC failed'));
    else originalRpc.resolve({ eligible: true, elite: true, holdPercent: 10 });
    assert.equal(await stale, false);
    assert.equal(auth.sessions.get(session.token), replacement);
    assert.equal(replacement.elite, false);
    assert.equal(auth.revalidations.size, 1, 'stale completion cannot clear the newer in-flight refresh');
    assert.equal(await auth.revalidate(session), false);
    replacementRpc.resolve({ eligible: true, elite: false, holdPercent: 0.5 });
    assert.equal(await current, true);
    assert.equal(replacement.holdPercent, 0.5);
    assert.equal(auth.sessions.get(session.token), replacement);
    assert.equal(auth.revalidations.size, 0);
  }
});

test('unconfigured auth never issues a usable sign-in challenge', () => {
  const auth = new Auth({ mint: '', rpcUrl: '' });
  assert.equal(auth.configured, false);
  assert.throws(() => auth.issueChallenge('11111111111111111111111111111111'), /configured/);
});

test('RPC token balances aggregate only exact owner/mint accounts', async () => {
  const wallet = '11111111111111111111111111111111';
  const mint = '22222222222222222222222222222222';
  const account = amount => ({ account: { data: { parsed: { info: { owner: wallet, mint, tokenAmount: { amount } } } } } });
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === 'getTokenSupply' ? { value: { amount: '1000000' } } : { value: [account('1200'), account('1300')] };
    return { ok: true, json: async () => ({ result }) };
  };
  const result = await fetchHoldings({ wallet, mint, rpcUrl: 'https://rpc.invalid', fetchImpl });
  assert.equal(result.eligible, true);
  assert.equal(result.balance, '2500');
});
