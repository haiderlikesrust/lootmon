import { existsSync, readFileSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Same CA directory as the world ledger, with serialized asynchronous writes. */
export class CommunityHistory {
  constructor(worldPath) { this.path = join(dirname(worldPath), 'community-state.json'); this.pending = null; this.writer = null; }
  load() {
    if (!existsSync(this.path)) return null;
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.chat) || !Array.isArray(data.activity)) throw new Error('Invalid saved community history; refusing to overwrite it');
    return data;
  }
  save(snapshot) {
    this.pending = JSON.stringify({ version: 1, chat: snapshot.chat, activity: snapshot.activity });
    if (!this.writer) this.writer = this.drain().finally(() => { this.writer = null; });
    return this.writer;
  }
  async drain() {
    while (this.pending !== null) {
      const data = this.pending; this.pending = null;
      const temporary = `${this.path}.${process.pid}.tmp`;
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
    }
  }
  async flush() { await this.writer; }
}
