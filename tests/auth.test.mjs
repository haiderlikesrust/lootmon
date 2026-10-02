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
