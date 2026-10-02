import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

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
  load() {
    if (!existsSync(this.path)) return { version: 1, packs: [], accounts: {}, awards: [] };
    const state = JSON.parse(readFileSync(this.path, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.packs) || !state.accounts || !Array.isArray(state.awards)) throw new Error('Game data is invalid. Refusing to overwrite the durable prize ledger.');
    return state;
  }
  save(state) {
    const temporary = `${this.path}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, 'w', 0o600);
    try { writeFileSync(descriptor, JSON.stringify(state)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, this.path);
  }
  close() {
    if (existsSync(this.lockPath) && Number(readFileSync(this.lockPath, 'utf8')) === process.pid) unlinkSync(this.lockPath);
  }
}
