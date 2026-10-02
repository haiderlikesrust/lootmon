// Geometry and placement share these coordinates. They describe potential places,
// never an active prize location or a client's authority to create a reward.
export const HOME_LAYOUT_VERSION = 2;
export const HOME_PADS = Array.from({ length: 70 }, (_, index) => ({
  id: `camp-${Math.floor(index / 14)}-${index % 14}`,
  x: -78 + (index % 14) * 12,
  z: 66 + Math.floor(index / 14) * 12,
}));

export const HOUSES = [
  [-20,2,9,8],[-31,-12,10,10],[-14,-29,11,8],[3,-29,10,8],[20,-24,10,9],[36,-38,11,9],
  [38,-5,10,9],[23,3,9,8],[-20,40,11,10],[-37,28,9,10],[23,35,10,8],[41,23,11,9],
  [-46,-47,10,9],[-63,-37,10,10],[58,-23,10,10],[77,-35,12,10],[-76,29,10,9],[-55,47,11,10],
  [60,53,10,9],[79,22,9,10],[93,-62,11,10],[-98,-5,9,8],[103,35,10,9],[-17,-56,10,9],
];

export const HIDING_AREAS = [
  { id: 'western-garden', x: -105, z: -72, w: 20, d: 18, tier: 250, kind: 'hedge-vault' },
  { id: 'forgotten-court', x: -20, z: -82, w: 22, d: 18, tier: 250, kind: 'ruin-vault' },
  { id: 'crown-crypt', x: 113, z: -77, w: 16, d: 20, tier: 250, kind: 'ruin-vault' },
  { id: 'northwatch-west', x: -100, z: -119, w: 22, d: 8, tier: 500, kind: 'bridge-vault' },
  { id: 'northwatch-grove', x: -24, z: -119, w: 22, d: 8, tier: 500, kind: 'bridge-vault' },
  { id: 'northwatch-glen', x: 24, z: -119, w: 22, d: 8, tier: 500, kind: 'bridge-vault' },
  { id: 'northwatch-east', x: 100, z: -119, w: 22, d: 8, tier: 500, kind: 'bridge-vault' },
];

export function hidingWalls(area) {
  const { x, z, w, d } = area, thickness = .55;
  const walls = [
    { x: x - w / 2, z, w: thickness, d },
    { x: x + w / 2, z, w: thickness, d },
    { x, z: z - d / 2, w, d: thickness },
    // The entrance and successive baffle gaps alternate: the prize chamber
    // cannot be reached or picked through the front facade in a straight line.
    { x: x - 1.7, z: z + d / 2, w: w - 3.4, d: thickness },
  ];
  if (d >= 14) {
    walls.push({ x: x + 2.2, z: z - d / 2 + d * .68, w: w - 4.4, d: thickness });
    walls.push({ x: x - 2.2, z: z - d / 2 + d * .35, w: w - 4.4, d: thickness });
  } else {
    walls.push({ x: x + 2.2, z, w: w - 4.4, d: thickness });
  }
  return walls;
}

const spots = [];
for (const [index, [x, z, w, d]] of HOUSES.entries()) {
  for (const [offset, [dx, dz]] of [[0, -d / 2 + 1.6], [-w / 2 + 1.6, -d / 2 + 1.6], [w / 2 - 1.6, d / 2 - 1.6]].entries()) {
    spots.push({ id: `room-${index}-${offset}`, x: x + dx, z: z + dz, tiers: z <= -23 ? [25, 50, 100] : [25, 50], kind: 'interior' });
  }
}
for (const [index, [x, z]] of [
  [-14, 11],[9, 16],[-9, -13],[13, -18],[-39, 0],[48, 3],[-52, 19],[65, 8],
  [-80, 7],[-93, 17],[-106, -20],[-81, -29],[-110, -46],[-73, -60],[-47, -67],
  [-10, -62],[9, -58],[22, -52],[44, -66],[65, -68],[76, -83],[105, -50],
  [113, -26],[93, -8],[-60, -83],[-41, -86],[9, -86],[52, -85],
].entries()) {
  for (const [j, [dx, dz]] of [[-2, -2], [2, 2], [-2, 2]].entries()) {
    const zz = z + dz;
    spots.push({ id: `woodland-${index}-${j}`, x: x + dx, z: zz, tiers: zz < -45 ? [50, 100] : [25, 50], kind: 'woodland' });
  }
}
for (const area of HIDING_AREAS) {
  for (let index = 0; index < 5; index++) {
    spots.push({ id: `${area.id}-${index}`, x: area.x - area.w / 2 + 1.7 + index * (area.w - 3.4) / 4,
      z: area.z - area.d / 2 + 1.6, tiers: [area.tier], kind: area.kind });
  }
}
export const HIDING_SPOTS = spots;
