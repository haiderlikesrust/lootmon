export const HOME_LAYOUT_VERSION: number;
export const HOME_PADS: { id: string; x: number; z: number }[];
export const HOUSES: number[][];
export type HidingArea = { id: string; x: number; z: number; w: number; d: number; tier: number; kind: string };
export const HIDING_AREAS: HidingArea[];
export function hidingWalls(area: HidingArea): {x: number; z: number; w: number; d: number}[];
export const HIDING_SPOTS: {id: string; x: number; z: number; tiers: number[]; kind: string}[];
