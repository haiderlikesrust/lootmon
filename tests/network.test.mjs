import test from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from '../server/network.mjs';
import { publicSite } from '../server/public-site.mjs';

test('rate limiting trusts exactly the private Dokploy proxy chain, not user prefixes', () => {
  const request = { socket: { remoteAddress: '172.18.0.3' }, headers: { 'x-forwarded-for': '192.0.2.9, 198.51.100.7, 172.18.0.2' } };
  assert.equal(clientAddress(request), '172.18.0.3');
  assert.equal(clientAddress(request, 2), '198.51.100.7');
  assert.equal(clientAddress(request, 1), '172.18.0.2');
  for (const header of ['spoof, 198.51.100.7, 172.18.0.2', '', ['198.51.100.7'], '198.51.100.7']) {
    request.headers['x-forwarded-for'] = header;
    assert.equal(clientAddress(request, 2), '172.18.0.3');
  }
});

test('public identities share the actual gate mint and accept only X profile URLs', () => {
  const mint = '11111111111111111111111111111111';
  assert.deepEqual(publicSite({ MEMECOIN_MINT: mint, X_ACCOUNT_URL: 'https://twitter.com/lootmon_test/' }), { contractAddress: mint, xUrl: 'https://x.com/lootmon_test' });
  for (const X_ACCOUNT_URL of ['javascript:alert(1)', 'https://evil.test/name', 'https://x.com@evil.test/user', 'https://user:password@x.com/name', 'https://x.com/name/status/5', 'https://x.com:9000/name']) {
    assert.deepEqual(publicSite({ MEMECOIN_MINT: 'bad-address', X_ACCOUNT_URL }), { contractAddress: null, xUrl: null });
  }
});
