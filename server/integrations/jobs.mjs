// Adapted from the user-owned grailshot reference project. No runtime configuration was copied.
export class PendingOperation extends Error {
    constructor(message, code = 'confirmation_pending') { super(message); this.name = 'PendingOperation'; this.code = code; }
}
export class ReviewRequired extends Error {
    constructor(message, code = 'intent_quarantined') { super(message); this.name = 'ReviewRequired'; this.code = code; }
}
export class PurchaseRefunded extends Error {
    constructor(refund) { super('Purchase refunded and verified on-chain'); this.name = 'PurchaseRefunded'; this.refund = refund; }
}
export class Jobs {
    db;
    constructor(db) {
        this.db = db;
    }
    async get(id) { return (await this.db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0] ?? null; }
    async put(id, kind, status, data, error = null) { await this.db.query(`INSERT INTO jobs(id,kind,status,data,created_at,updated_at,error) VALUES($1,$2,$3,$4,$5,$5,$6) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,data=EXCLUDED.data,updated_at=EXCLUDED.updated_at,error=EXCLUDED.error`, [id, kind, status, JSON.stringify(data), Date.now(), error]); }
    async error(id, error) { await this.db.query('UPDATE jobs SET error=$2,updated_at=$3 WHERE id=$1', [id, error.message, Date.now()]); }
}
