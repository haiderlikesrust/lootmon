import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/wallets.ts', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/export /g, '');
const { walletChoices } = new Function('getWallets', `${compiled};return {walletChoices};`)(() => ({ get: () => [] }));
const message = new TextEncoder().encode('Server-issued sign-in challenge');
const signature = new Uint8Array(64).fill(17);

function injected(shape = 'raw') {
  const listeners = new Map();
  const wallet = {
    publicKey: { toString: () => 'selected-address' }, calls: 0,
    async connect() { wallet.calls++; return shape === 'raw' ? undefined : { publicKey: wallet.publicKey }; },
    async signMessage(bytes) { assert.deepEqual(bytes, message); return shape === 'raw' ? signature : { signature }; },
    on(event, listener) { listeners.set(event, listener); },
    removeListener(event) { listeners.delete(event); },
  };
  return { wallet, listeners };
}
test('Solflare supports a void connect result and raw message signatures; Phantom remains selectable', async () => {
  const solflare = injected(), phantom = injected('object');
  phantom.wallet.isPhantom = true;
  const choices = walletChoices({ solflare: solflare.wallet, phantom: { solana: phantom.wallet }, solana: phantom.wallet }, []);
  assert.deepEqual(choices.map(w => w.name), ['Phantom', 'Solflare']);
  const connected = await choices.find(w => w.name === 'Solflare').connect();
  assert.equal(phantom.wallet.calls, 0, 'explicit selection never opens a different installed wallet');
  assert.equal(connected.address, 'selected-address');
  assert.deepEqual(await connected.signMessage(message), signature);
  assert.deepEqual(await (await choices[0].connect()).signMessage(message), signature);
});

test('injected account changes reject stale signatures and subscriptions clean up', async () => {
  const { wallet, listeners } = injected();
  const connected = await walletChoices({ solflare: wallet }, [])[0].connect();
  let changed = 0;
  const cleanup = connected.onChange(() => changed++);
  wallet.publicKey = { toString: () => 'different-address' }; listeners.get('accountChanged')();
  assert.equal(changed, 1);
  await assert.rejects(connected.signMessage(message), /account changed/);
  cleanup(); assert.equal(listeners.size, 0);
});

function standard() {
  const account = { address: 'standard-address', chains: ['solana:mainnet'], features: ['solana:signMessage'] };
  const wallet = { name: 'Solflare', chains: ['solana:mainnet'], accounts: [account], features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signMessage': { signMessage: async ({ account: requested, message }) => {
      assert.equal(requested, account); return [{ signature, signedMessage: message }];
    } },
  } };
  return wallet;
}
test('Wallet Standard signs the exact challenge and deduplicates the injected adapter', async () => {
  const wallet = standard();
  const choices = walletChoices({ solflare: injected().wallet }, [wallet]);
  assert.equal(choices.length, 1);
  const connected = await choices[0].connect();
  assert.equal(connected.address, 'standard-address');
  assert.deepEqual(await connected.signMessage(message), signature);
  wallet.features['solana:signMessage'].signMessage = async () => [{ signature, signedMessage: new Uint8Array(message.length) }];
  await assert.rejects(connected.signMessage(message), /message changed/);
});

test('reject cancellation, missing keys, incompatible wallets and malformed signatures', async () => {
  assert.equal(walletChoices({}, [{ ...standard(), chains: ['eip155:1'] }]).length, 0);
  const { wallet } = injected();
  wallet.connect = async () => { throw new Error('User rejected'); };
  await assert.rejects(walletChoices({ solflare: wallet }, [])[0].connect(), /User rejected/);
  wallet.connect = async () => {}; wallet.publicKey = null;
  await assert.rejects(walletChoices({ solflare: wallet }, [])[0].connect(), /address/);
  wallet.publicKey = { toString: () => 'selected-address' };
  wallet.signMessage = async () => new Uint8Array(63);
  await assert.rejects((await walletChoices({ solflare: wallet }, [])[0].connect()).signMessage(message), /valid message signature/);
});
