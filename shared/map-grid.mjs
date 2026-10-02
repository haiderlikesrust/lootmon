export const MAP_EXTENT = 140;
export const MAP_CELLS = 6;

/** North-up map: west to east A–F, north to south 1–6. */
export function mapGrid(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const cell = value => Math.max(0, Math.min(MAP_CELLS - 1, Math.floor((value + MAP_EXTENT) / (MAP_EXTENT * 2) * MAP_CELLS)));
  return `${String.fromCharCode(65 + cell(x))}${cell(z) + 1}`;
}
