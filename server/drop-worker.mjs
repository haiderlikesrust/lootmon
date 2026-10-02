/** Poll confirmed provider inventory and deliver idempotently into game storage. */
export function createDropWorker({ provider, onPrize, onStatus = () => {}, intervalMs = 30_000 }) {
  if (!provider || typeof onPrize !== 'function') throw new TypeError('Provider and durable onPrize callback are required');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000) throw new RangeError('Drop polling interval must be at least ten seconds');
  let timer;
  let running = false;
  let stopped = false;
  return {
    async tick() {
      if (running || stopped) return;
      running = true;
      try {
        const inventory = await provider.tick();
        for (const prize of inventory) {
          if (!prize.id || !prize.mint || !prize.purchaseSignature || ![25, 50, 100, 250, 500].includes(prize.tierUsd)) throw new Error('Provider returned an unverified prize record');
          // Replays are deliberate: onPrize must persist and deduplicate by id.
          await onPrize(prize);
        }
      } finally {
        running = false;
        onStatus({ ...provider.status });
      }
    },
    start() {
      if (timer || stopped) return;
      const poll = () => this.tick().catch(() => onStatus({ ...provider.status, ready: false, error: 'Prize reconciliation failed; retry is scheduled' }));
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
      void poll();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
