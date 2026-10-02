import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { coinKey } from './coin-profiles.mjs';

/** One game authority per data directory. Reward claims are committed before
 * handing them to the idempotent provider transfer worker. */
export class FileStore {
  constructor(directory = process.env.GAME_DATA_DIR || '.data', { kernelLockHeld = false } = {}) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.path = join(this.directory, 'game-state.json');
    this.lockPath = join(this.directory, 'authority.lock');
    if (existsSync(this.lockPath)) {
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      let live = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); live = true; } catch (error) { if (error.code === 'EPERM') live = true; }
      }
      // The container entrypoint holds a separate kernel flock for the whole
      // process tree. It survives PID reuse and releases after an abrupt stop.
      if (live && !kernelLockHeld) throw new Error('Another game authority is already using GAME_DATA_DIR. Use exactly one authority per world.');
      unlinkSync(this.lockPath);
    }
    const lock = openSync(this.lockPath, 'wx', 0o600);
    writeFileSync(lock, String(process.pid));
    closeSync(lock);
  }
  selectMint(mint, legacyMint) {
    if (!mint) return;
    const key = coinKey(mint);
    const legacyPath = join(this.directory, 'game-state.json');
    const manifestPath = join(this.directory, 'coin-profiles.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { version: 1, legacyMint: null };
    if (manifest.version !== 1) throw new Error('Invalid coin profile manifest');
    if (existsSync(legacyPath)) {
      const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
      const hasPrizes = legacy.packs?.length || legacy.awards?.length || legacy.pendingSpawns?.length
        || Object.values(legacy.accounts ?? {}).some(account => account.collection?.length);
      const owner = manifest.legacyMint || legacy.coinMint || legacyMint;
      if (hasPrizes && !owner) throw new Error('Existing prizes need their original CA verified by the treasury database before migration');
      if (owner) {
        const destination = join(this.directory, 'coins', coinKey(owner), 'game-state.json');
        if (existsSync(destination)) throw new Error('Both legacy and CA-specific prize files exist; refusing to merge them');
        mkdirSync(resolve(destination, '..'), { recursive: true, mode: 0o700 });
        this.writeAtomic(manifestPath, { version: 1, legacyMint: owner });
        renameSync(legacyPath, destination);
      }
    }
    this.mint = mint;
    this.path = join(this.directory, 'coins', key, 'game-state.json');
    mkdirSync(resolve(this.path, '..'), { recursive: true, mode: 0o700 });
  }
  load() {
    if (!existsSync(this.path)) return { version: 1, packs: [], accounts: {}, awards: [] };
    const state = JSON.parse(readFileSync(this.path, 'utf8'));
    if (state.coinMint && state.coinMint !== this.mint) throw new Error('Game data belongs to a different CA');
    if (state.version !== 1 || !Array.isArray(state.packs) || !state.accounts || !Array.isArray(state.awards)) throw new Error('Game data is invalid. Refusing to overwrite the durable prize ledger.');
    return state;
  }
  save(state) {
    this.writeAtomic(this.path, this.mint ? { ...state, coinMint: this.mint } : state);
  }
  writeAtomic(path, state) {
    const temporary = `${path}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, 'w', 0o600);
    try { writeFileSync(descriptor, JSON.stringify(state)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  }
  close() {
    if (existsSync(this.lockPath) && Number(readFileSync(this.lockPath, 'utf8')) === process.pid) unlinkSync(this.lockPath);
  }
}
