import { createHash } from 'node:crypto';
import { HOME_PADS, HIDING_SPOTS } from '../shared/world-layout.mjs';

export const SPAWN_POLICY = Object.freeze({
  25: { minRoute: 45, maxRatio: 4, maxSpread: 170, spacing: 10 },
  50: { minRoute: 70, maxRatio: 3.3, maxSpread: 170, spacing: 10 },
  100: { minRoute: 100, maxRatio: 2.7, maxSpread: 170, spacing: 11 },
  250: { minRoute: 175, maxRatio: 1.7, maxSpread: 125, spacing: 12 },
  500: { minRoute: 230, maxRatio: 1.5, maxSpread: 110, spacing: 12 },
});
export const SPAWN_REUSE_MS = 20 * 60_000;
export const MAX_PLAYERS = 64;
const LIMIT = 124, WIDTH = LIMIT * 2 + 1, CELLS = WIDTH * WIDTH, INF = 65535;
const directions = [[1,0,10],[-1,0,10],[0,1,10],[0,-1,10],[1,1,14],[1,-1,14],[-1,1,14],[-1,-1,14]];
const cache = new Map();

/** A conservative one-metre navigation grid. Diagonals never cut collider corners.
 * Distances use 1 / 1.4 metre edges, not straight-line distances through houses. */
export class WorldPlacement {
  constructor(colliders) {
    this.colliders = colliders;
    this.free = new Uint8Array(CELLS);
    this.edges = new Uint8Array(CELLS);
    this.metrics = new Map();
    this.valid = new Map();
    for (let iz = 0; iz < WIDTH; iz++) for (let ix = 0; ix < WIDTH; ix++) {
      this.free[iz * WIDTH + ix] = this.clear(ix - LIMIT, iz - LIMIT, .65) ? 1 : 0;
    }
    for (let iz = 0; iz < WIDTH; iz++) for (let ix = 0; ix < WIDTH; ix++) {
      const index = iz * WIDTH + ix;
      if (!this.free[index]) continue;
      for (let d = 0; d < directions.length; d++) {
        const [dx, dz] = directions[d], nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= WIDTH || nz >= WIDTH || !this.free[nz * WIDTH + nx]) continue;
        if (dx && dz && (!this.free[iz * WIDTH + nx] || !this.free[nz * WIDTH + ix])) continue;
        this.edges[index] |= 1 << d;
      }
    }
    this.connected = new Uint8Array(CELLS);
    const start = this.cell({ x: 0, z: 22 });
    if (start !== null) {
      const queue = new Int32Array(CELLS); let read = 0, write = 1; queue[0] = start; this.connected[start] = 1;
      while (read < write) {
        const current = queue[read++];
        for (let d = 0; d < directions.length; d++) {
          if (!(this.edges[current] & (1 << d))) continue;
          const [dx, dz] = directions[d], next = current + dx + dz * WIDTH;
          if (!this.connected[next]) { this.connected[next] = 1; queue[write++] = next; }
        }
      }
    }
    this.bases = HOME_PADS.filter(point => this.clear(point.x, point.z, 4.15) && this.reachable(point));
    this.baseCells = this.bases.map(point => this.cell(point));
  }
  clear(x, z, radius = .65) {
    if (Math.abs(x) + radius > LIMIT || Math.abs(z) + radius > LIMIT) return false;
    return !this.colliders.some(c => {
      const dx = Math.max(0, Math.abs(x - c.x) - (c.w ?? c.width) / 2);
      const dz = Math.max(0, Math.abs(z - c.z) - (c.d ?? c.depth) / 2);
      return dx * dx + dz * dz < radius * radius;
    });
  }
  cell(point) {
    const x = Math.round(point.x), z = Math.round(point.z);
    if (Math.abs(x) > LIMIT || Math.abs(z) > LIMIT || !this.clear(point.x, point.z)) return null;
    const index = (z + LIMIT) * WIDTH + x + LIMIT;
    if (!this.free[index]) return null;
    for (let i = 1; i <= 3; i++) if (!this.clear(point.x + (x - point.x) * i / 3, point.z + (z - point.z) * i / 3)) return null;
    return index;
  }
  reachable(point) { const cell = this.cell(point); return cell !== null && Boolean(this.connected[cell]); }
  routeMetrics(point) {
    const key = `${point.x},${point.z}`;
    if (this.metrics.has(key)) return this.metrics.get(key);
    const source = this.cell(point);
    if (source === null || !this.connected[source] || !this.bases.length) return null;
    // Dial's shortest-path queue: bounded integer edge costs avoid a large
    // object heap and keep this startup-only validation inexpensive.
    const dist = new Uint16Array(CELLS).fill(INF), next = new Int32Array(CELLS).fill(-1), previous = new Int32Array(CELLS).fill(-1);
    const heads = new Int32Array(15).fill(-1), targets = new Set(this.baseCells);
    let pending = 1, cursor = 0; dist[source] = 0; heads[0] = source;
    while (pending && targets.size) {
      while (heads[cursor % 15] === -1) cursor++;
      const index = heads[cursor % 15]; heads[cursor % 15] = next[index];
      if (next[index] !== -1) previous[next[index]] = -1;
      next[index] = -1; previous[index] = -1; pending--; targets.delete(index);
      for (let d = 0; d < directions.length; d++) {
        if (!(this.edges[index] & (1 << d))) continue;
        const [dx, dz, cost] = directions[d], neighbor = index + dx + dz * WIDTH, proposed = cursor + cost;
        if (proposed >= dist[neighbor]) continue;
        if (dist[neighbor] !== INF) {
          const before = previous[neighbor], after = next[neighbor];
          if (before === -1) heads[dist[neighbor] % 15] = after; else next[before] = after;
          if (after !== -1) previous[after] = before;
          pending--;
        }
        dist[neighbor] = proposed;
        const bucket = proposed % 15, head = heads[bucket];
        next[neighbor] = head; previous[neighbor] = -1;
        if (head !== -1) previous[head] = neighbor;
        heads[bucket] = neighbor; pending++;
      }
    }
    const endpoint = Math.hypot(point.x - Math.round(point.x), point.z - Math.round(point.z));
    const lengths = this.baseCells.map(index => dist[index] === INF ? Infinity : dist[index] / 10 + endpoint);
    const minimum = Math.min(...lengths), maximum = Math.max(...lengths);
    const metrics = { minimum, maximum, spread: maximum - minimum, ratio: maximum / minimum, lengths };
    this.metrics.set(key, metrics); return metrics;
  }
  spotsForTier(tier) {
    if (this.valid.has(tier)) return this.valid.get(tier);
    const policy = SPAWN_POLICY[tier];
    const spots = HIDING_SPOTS.filter(spot => {
      if (!spot.tiers.includes(tier) || !this.reachable(spot)) return false;
      const route = this.routeMetrics(spot);
      return route && Number.isFinite(route.maximum) && route.minimum >= policy.minRoute && route.ratio <= policy.maxRatio && route.spread <= policy.maxSpread;
    });
    this.valid.set(tier, spots); return spots;
  }
}

export function getWorldPlacement(colliders) {
  const key = createHash('sha256').update(JSON.stringify(colliders)).digest('hex');
  if (!cache.has(key)) {
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(key, new WorldPlacement(colliders));
  }
  return cache.get(key);
}
