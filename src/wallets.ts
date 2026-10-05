import { getWallets } from '@wallet-standard/app';

type Account = { address: string; chains: readonly string[]; features: readonly string[] };
type StandardWallet = { name: string; chains: readonly string[]; accounts: readonly Account[]; features: Record<string, any> };
type Injected = { publicKey?: { toString(): string }; connect(): Promise<any>; signMessage(message: Uint8Array, encoding?: string): Promise<any>; disconnect?(): Promise<void>; on?(event: string, listener: (...args: any[]) => void): void; removeListener?(event: string, listener: (...args: any[]) => void): void };
export type WalletConnection = {
  address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  onChange(listener: () => void): () => void;
  disconnect(): Promise<void>;
};
export type WalletChoice = { name: string; connect(): Promise<WalletConnection> };
const supported = (account: Account) => account.chains.includes('solana:mainnet') && account.features.includes('solana:signMessage');
function signatureBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 64) throw new Error('The wallet did not return a valid message signature.');
  return value;
}

/** Wallet Standard first; injected adapters keep older extensions compatible. */
export function walletChoices(scope: any = window, registered: readonly StandardWallet[] = getWallets().get()): WalletChoice[] {
  const choices: WalletChoice[] = [];
  for (const wallet of registered) {
    if (!wallet.chains.includes('solana:mainnet') || typeof wallet.features['standard:connect']?.connect !== 'function' || typeof wallet.features['solana:signMessage']?.signMessage !== 'function') continue;
    choices.push({ name: wallet.name, async connect() {
      const result = await wallet.features['standard:connect'].connect();
      const account = (result?.accounts ?? wallet.accounts).find(supported) as Account | undefined;
      if (!account) throw new Error('Choose a Solana account that supports message signing.');
      const unchanged = () => wallet.accounts.some(item => item.address === account.address && supported(item));
      return {
        address: account.address,
        async signMessage(message) {
          if (!unchanged()) throw new Error('Wallet account changed. Please reconnect.');
          const [signed] = await wallet.features['solana:signMessage'].signMessage({ account, message });
          if (!unchanged() || !signed?.signedMessage || signed.signedMessage.length !== message.length || !message.every((byte, i) => signed.signedMessage[i] === byte)) throw new Error('The wallet account or sign-in message changed. Please reconnect.');
          return signatureBytes(signed.signature);
        },
        onChange(listener) { return wallet.features['standard:events']?.on('change', () => { if (!unchanged()) listener(); }) ?? (() => {}); },
        async disconnect() { await wallet.features['standard:disconnect']?.disconnect(); },
      };
    } });
  }
  const seen = new Set<Injected>();
  const injected: [string, Injected | undefined][] = [
    ['Phantom', scope.phantom?.solana], ['Solflare', scope.solflare], ['Backpack', scope.backpack?.solana ?? scope.backpack],
    [scope.solana?.isPhantom ? 'Phantom' : scope.solana?.isSolflare ? 'Solflare' : scope.solana?.isBackpack ? 'Backpack' : 'Solana wallet', scope.solana],
  ];
  for (const [name, provider] of injected) {
    if (!provider || seen.has(provider) || typeof provider.connect !== 'function' || typeof provider.signMessage !== 'function') continue;
    seen.add(provider);
    if (choices.some(choice => choice.name.toLowerCase() === name.toLowerCase())) continue;
    choices.push({ name, async connect() {
      const result = await provider.connect();
      // Solflare can return void: its public key lives on the provider.
      const address = (provider.publicKey ?? result?.publicKey)?.toString();
      if (!address) throw new Error('The wallet did not provide a Solana address.');
      const unchanged = () => provider.publicKey?.toString() === address;
      return {
        address,
        async signMessage(message) {
          if (!unchanged()) throw new Error('Wallet account changed. Please reconnect.');
          const signed = await provider.signMessage(message, 'utf8');
          if (!unchanged()) throw new Error('Wallet account changed. Please reconnect.');
          return signatureBytes(signed?.signature ?? signed);
        },
        onChange(listener) {
          const changed = () => { if (!unchanged()) listener(); };
          provider.on?.('accountChanged', changed); provider.on?.('disconnect', listener);
          return () => { provider.removeListener?.('accountChanged', changed); provider.removeListener?.('disconnect', listener); };
        },
        async disconnect() { await provider.disconnect?.(); },
      };
    } });
  }
  return choices.sort((a,b) => a.name.localeCompare(b.name));
}

export function watchWallets(listener: () => void) {
  const wallets = getWallets();
  const register = wallets.on('register', listener), unregister = wallets.on('unregister', listener);
  return () => { register(); unregister(); };
}
