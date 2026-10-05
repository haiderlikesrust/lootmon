const CELL = 16;
const indexes = new WeakMap();
/** Immutable authored rectangles, shared by client movement and authority LOS. */
export function collidesWithWorld(colliders, x, z, radius = .6) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) return true;
  let index = indexes.get(colliders);
  if (!index || index.length !== colliders.length) {
    const cells = new Map();
    for (const box of colliders) {
      const w = box.w ?? box.width, d = box.d ?? box.depth;
      for (let cx = Math.floor((box.x-w/2)/CELL); cx <= Math.floor((box.x+w/2)/CELL); cx++) {
        for (let cz = Math.floor((box.z-d/2)/CELL); cz <= Math.floor((box.z+d/2)/CELL); cz++) {
          const key = `${cx},${cz}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(box);
        }
      }
    }
    index = { length: colliders.length, cells }; indexes.set(colliders, index);
  }
  for (let cx = Math.floor((x-radius)/CELL); cx <= Math.floor((x+radius)/CELL); cx++) {
    for (let cz = Math.floor((z-radius)/CELL); cz <= Math.floor((z+radius)/CELL); cz++) {
      for (const box of index.cells.get(`${cx},${cz}`) ?? []) {
        // Preserve the original clamp arithmetic even at floating-point edges.
        const dx = x-Math.max(box.x-(box.w ?? box.width)/2,Math.min(x,box.x+(box.w ?? box.width)/2));
        const dz = z-Math.max(box.z-(box.d ?? box.depth)/2,Math.min(z,box.z+(box.d ?? box.depth)/2));
        if (dx*dx+dz*dz < radius*radius) return true;
      }
    }
  }
  return false;
}
