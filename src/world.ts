import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HOME_PADS, HOUSES, HIDING_AREAS, hidingWalls } from '../shared/world-layout.mjs';

export const MAP_SIZE = 260;
export type Collider = { x: number; z: number; w: number; d: number };
export type Landmark = { name: string; x: number; z: number; color: string };

/** A hand-built, walkable little frontier. All traversable surfaces share y = 0. */
export function createWorld(scene: THREE.Scene) {
  const colliders: Collider[] = [];
  const animated: ((t: number) => void)[] = [];
  const world = new THREE.Group();
  world.name = 'Grail Valley';
  scene.add(world);
  const material = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: .88, metalness: 0, ...extra });
  const m = {
    grass: material('#829c64'), grassLight: material('#a8b978'), grassDark: material('#5d7d52'),
    sand: material('#d8c29b'), path: material('#dfc9a4'), stone: material('#aaa69a'), stoneLight: material('#d2c6aa'),
    stoneDark: material('#777e78'), plaster: material('#f1dfb3'), peach: material('#e5b693'),
    mint: material('#c3d1b7'), cream: material('#fff0c8'), wood: material('#695440'), woodLight: material('#ad8354'),
    roof: material('#ad674d'), roofLight: material('#c07d57'), roofDark: material('#785b4c'), teal: material('#5e8f87'),
    leaf: material('#59806a'), leafLight: material('#90aa70'), leafDark: material('#426754'),
    gold: material('#e0b970', { metalness: .32, roughness: .45 }),
    glass: material('#82b4ad', { metalness: .15, roughness: .2 }),
    window: material('#efc981', { emissive: '#f4b754', emissiveIntensity: .2 }),
    water: material('#68a9b1', { metalness: .18, roughness: .3, transparent: true, opacity: .91 }),
    foam: material('#d1e2cf', { transparent: true, opacity: .58 }),
    fabric: material('#d6a361'), fabricTeal: material('#719b8d'), fabricCream: material('#f4dfaf'),
    berry: material('#bd6e60'), violet: material('#9c8fa8'), black: material('#3e4f47'),
  };
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const sphereGeo = new THREE.IcosahedronGeometry(1, 0);
  function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, parent: THREE.Object3D = world) {
    const o = new THREE.Mesh(geo, mat);
    o.position.set(x, y, z); o.scale.set(sx, sy, sz);
    o.castShadow = true; o.receiveShadow = true; parent.add(o); return o;
  }
  function box(x: number, y: number, z: number, w: number, h: number, d: number, mat: THREE.Material, parent: THREE.Object3D = world) {
    return mesh(boxGeo, mat, x, y, z, w, h, d, parent);
  }
  function cylinder(x: number, y: number, z: number, top: number, bottom: number, h: number, mat: THREE.Material, segments = 12, parent: THREE.Object3D = world) {
    return mesh(new THREE.CylinderGeometry(top, bottom, h, segments), mat, x, y, z, 1, 1, 1, parent);
  }
  function rock(x: number, z: number, s: number, mat = m.stone) {
    const r = mesh(sphereGeo, mat, x, s * .28, z, s, s * .65, s * .8); r.rotation.y = x * .37;
    r.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(r);
    obstacle((bounds.min.x+bounds.max.x)/2,(bounds.min.z+bounds.max.z)/2,bounds.max.x-bounds.min.x,bounds.max.z-bounds.min.z);
    return r;
  }
  function obstacle(x: number, z: number, w: number, d: number) { colliders.push({ x, z, w, d }); }
  function beam(a: THREE.Vector3, b: THREE.Vector3, thickness: number, mat: THREE.Material, parent: THREE.Object3D = world) {
    const delta = b.clone().sub(a);
    const o = box((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, thickness, delta.length(), thickness, mat, parent);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return o;
  }
  const paths: { a: THREE.Vector2; b: THREE.Vector2; width: number }[] = [];
  function path(points: [number, number][], width: number, mat: THREE.Material = m.path) {
    for (let i = 1; i < points.length; i++) {
      const a = new THREE.Vector2(...points[i - 1]), b = new THREE.Vector2(...points[i]);
      const line = box((a.x + b.x) / 2, .014, (a.y + b.y) / 2, width, .03, a.distanceTo(b), mat);
      line.rotation.y = Math.atan2(b.x - a.x, b.y - a.y); line.castShadow = false;
      paths.push({ a, b, width });
    }
    for (const [x, z] of points) { const o = cylinder(x, .018, z, width / 2, width / 2, .035, mat, 16); o.castShadow = false; }
  }
  const ground = box(0, -.55, 0, MAP_SIZE + 100, 1.1, MAP_SIZE + 100, m.grass); ground.castShadow = false;
  // Broad paths give way to wandering woodland trails at the edge of town.
  path([[-115, 12], [-65, 10], [-30, 13], [0, 15], [40, 14], [80, 8], [115, 18]], 6.2);
  path([[0, 82], [0, 47], [0, 15], [0, -7], [-1, -17], [-1, -52], [-16, -73]], 6.3);
  path([[0, -17], [35, -22], [60, -45], [79, -53], [95, -84]], 4.7);
  path([[-1, -17], [-22, -18], [-46, -30], [-67, -25], [-95, -41]], 4.5);
  path([[-65, 10], [-74, 42], [-84, 55], [-90, 75]], 4);
  path([[40, 14], [55, 29], [70, 42], [95, 57]], 4.5);
  path([[-30, 13], [-33, 47], [-58, 65], [-84, 55]], 3.5);
  path([[35, -22], [44, -59], [60, -81], [60, -119]], 4.5);
  path([[-46, -30], [-48, -66], [-58, -81], [-58, -119]], 4.5);
  path([[-16, -73], [-30, -70], [-48, -66]], 4);
  const plaza = cylinder(0, .03, 6, 17.5, 17.5, .05, m.sand, 48); plaza.castShadow = false;
  // Paving rings and individually set stones make the village square legible from above.
  for (let i = 0; i < 52; i++) {
    const a = i / 52 * Math.PI * 2;
    const p = box(Math.cos(a) * 16.6, .08, 6 + Math.sin(a) * 16.6, .75, .11, 1.7, i % 3 ? m.stoneLight : m.stone);
    p.rotation.y = -a; p.castShadow = false;
  }
  for (let row = 0; row < 5; row++) for (let col = 0; col < 7; col++) {
    const p = box(-7 + col * 2.3 + (row % 2) * .8, .067, 10 + row * 1.6, 2.14, .06, 1.43, row % 3 === 0 ? m.sand : m.path); p.castShadow = false;
  }
  // Fountain, watering troughs and seating are real geometry, with small collision footprints.
  cylinder(-6, .2, -1.5, 3.75, 3.9, .4, m.stoneLight, 12);
  cylinder(-6, .48, -1.5, 3.3, 3.5, .56, m.stone, 12);
  cylinder(-6, .79, -1.5, 3.13, 3.13, .04, m.water, 24);
  cylinder(-6, 1.15, -1.5, .6, .92, 1.7, m.stoneLight, 8);
  cylinder(-6, 2.01, -1.5, 1.6, .9, .35, m.stoneLight, 12);
  cylinder(-6, 2.21, -1.5, 1.45, 1.45, .04, m.water, 16);
  cylinder(-6, 2.68, -1.5, .18, .3, .9, m.gold, 8);
  mesh(new THREE.OctahedronGeometry(.48), m.gold, -6, 3.4, -1.5);
  obstacle(-6, -1.5, 7.5, 7.5);
  function bench(x: number, z: number, rotation = 0) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotation; world.add(g);
    for (const xx of [-1.3, 1.3]) { box(xx, .42, 0, .2, .85, .7, m.black, g); box(xx, 1.05, -.35, .15, 1.05, .15, m.black, g); }
    for (let i = 0; i < 3; i++) box(0, .85, -.28 + i * .28, 3.2, .13, .22, m.woodLight, g);
    for (let i = 0; i < 2; i++) box(0, 1.23 + i * .28, -.36, 3.2, .22, .13, m.woodLight, g);
  }
  bench(-12, 7, Math.PI / 2); bench(12, 9, -Math.PI / 2); bench(-1, -10); bench(7, 23, Math.PI);
  function lamp(x: number, z: number) {
    cylinder(x, .15, z, .36, .48, .3, m.stoneDark, 8);
    cylinder(x, 1.7, z, .075, .11, 3.25, m.black, 7);
    box(x, 3.5, z, .6, .65, .6, m.window);
    cylinder(x, 3.96, z, 0, .52, .35, m.black, 4);
    for (const dx of [-.29, .29]) for (const dz of [-.29, .29]) box(x + dx, 3.5, z + dz, .055, .76, .055, m.black);
  }
  for (const [x, z] of [[-12, 19], [13, -4], [-16, -11], [16, 20], [-42, 14], [48, 13], [2, 41], [-62, -25], [60, -48]]) lamp(x, z);

  function roof(w: number, d: number, eave: number, rise: number, mat: THREE.Material, parent: THREE.Object3D) {
    const vertices = new Float32Array([
      -w/2,eave,-d/2, 0,eave+rise,-d/2, -w/2,eave,d/2, 0,eave+rise,-d/2, 0,eave+rise,d/2, -w/2,eave,d/2,
      0,eave+rise,-d/2, w/2,eave,-d/2, 0,eave+rise,d/2, w/2,eave,-d/2, w/2,eave,d/2, 0,eave+rise,d/2,
      -w/2,eave,d/2, 0,eave+rise,d/2, w/2,eave,d/2, w/2,eave,-d/2, 0,eave+rise,-d/2, -w/2,eave,-d/2,
    ]);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setIndex([0,2,1,3,5,4,6,8,7,9,11,10,12,14,13,15,17,16]); geo.computeVertexNormals();
    const r = mesh(geo, mat, 0, 0, 0, 1, 1, 1, parent); r.material = mat;
    for (const zz of [-d/2, d/2]) {
      beam(new THREE.Vector3(-w/2, eave-.06, zz), new THREE.Vector3(0, eave+rise, zz), .19, m.roofDark, parent);
      beam(new THREE.Vector3(w/2, eave-.06, zz), new THREE.Vector3(0, eave+rise, zz), .19, m.roofDark, parent);
    }
    box(0, eave+rise+.045, 0, .26, .18, d+.18, m.roofDark, parent);
    // Narrow standing seams break up the roof into tactile individual courses.
    for (let zz = -d/2+.8; zz < d/2; zz += 1.1) {
      beam(new THREE.Vector3(-w/2, eave+.03, zz), new THREE.Vector3(0, eave+rise+.03, zz), .065, m.roofLight, parent);
      beam(new THREE.Vector3(w/2, eave+.03, zz), new THREE.Vector3(0, eave+rise+.03, zz), .065, m.roofLight, parent);
    }
  }
  function planter(x: number, z: number, parent: THREE.Object3D = world) {
    cylinder(x, .38, z, .54, .35, .7, m.roofLight, 8, parent);
    mesh(sphereGeo, m.leaf, x, .9, z, .66, .58, .66, parent);
    for (let i = 0; i < 3; i++) mesh(sphereGeo, i % 2 ? m.berry : m.fabricCream, x + Math.sin(i*2.1)*.34, 1.35, z + Math.cos(i*2.1)*.3, .14, .14, .14, parent);
  }
  const houses = HOUSES;
  houses.forEach(([x,z,w,d], index) => {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.name = `Cottage ${index+1}`; world.add(g);
    const wall = [m.plaster,m.peach,m.mint,m.cream][index%4];
    const eave = index%5===0 ? 5.1 : 4.35, doorway = 2.2, wallT=.32;
    box(0, .06, 0, w, .1, d, m.woodLight, g);
    // Doorways have no invisible blocker: players can search the rooms.
    box(-w/2, eave/2, 0, wallT, eave, d, wall, g); obstacle(x-w/2,z,wallT,d);
    box(w/2, eave/2, 0, wallT, eave, d, wall, g); obstacle(x+w/2,z,wallT,d);
    box(0,eave/2,-d/2,w,eave,wallT,wall,g); obstacle(x,z-d/2,w,wallT);
    for (const side of [-1,1]) {
      const panel=(w-doorway)/2, xx=side*(doorway/2+panel/2);
      box(xx,eave/2,d/2,panel,eave,wallT,wall,g); obstacle(x+xx,z+d/2,panel,wallT);
      box(side*(doorway/2+.12),1.55,d/2+.14,.19,3.1,.22,m.wood,g);
    }
    box(0,(eave+3.05)/2,d/2,doorway,eave-3.05,wallT,wall,g);
    box(0,3.07,d/2+.14,doorway+.4,.22,.24,m.wood,g);
    // Exposed framing, deep lintels, shutters and little window boxes.
    for (const xx of [-w/2+.08,w/2-.08]) for (const zz of [-d/2-.04,d/2+.04]) box(xx,eave/2,zz,.2,eave,.2,m.wood,g);
    for (const side of [-1,1]) box(side*(doorway/2+(w-doorway)/4),.35,d/2+.18,(w-doorway)/2,.36,.14,m.stoneLight,g);
    box(0,eave-.2,d/2+.1,w,.17,.2,m.wood,g);
    box(0,eave-.2,-d/2-.1,w,.17,.2,m.wood,g);
    function window(xx:number, yy:number, zz:number, side=false) {
      const wg=new THREE.Group(); wg.position.set(xx,yy,zz); if(side) wg.rotation.y=Math.PI/2; g.add(wg);
      box(0,0,0,1.42,1.64,.14,m.wood,wg); box(0,0,.09,1.14,1.32,.08,index%3?m.glass:m.window,wg);
      box(0,0,.17,.09,1.36,.05,m.cream,wg); box(0,0,.17,1.2,.09,.05,m.cream,wg);
      for(const s of [-1,1]) { box(s*.88,0,0,.32,1.64,.14,index%3?m.teal:m.roof,wg); for(let j=0;j<4;j++) box(s*.88,-.48+j*.3,.09,.3,.04,.035,m.wood,wg); }
      box(0,-.93,.24,1.76,.28,.53,m.woodLight,wg);
      for(let j=0;j<5;j++) { mesh(sphereGeo,m.leaf,-.65+j*.32,-.72,.27,.25,.28,.26,wg); if(j%2===0) mesh(sphereGeo,m.berry,-.65+j*.32,-.45,.28,.14,.14,.14,wg); }
    }
    window(-w*.3,2.45,d/2+.2); window(w*.3,2.45,d/2+.2);
    window(w/2+.18,2.45,0,true);
    roof(w+1.05,d+1.05,eave,2.3+(index%3)*.3,index%4===2?m.teal:m.roof,g);
    box(w*.25,eave+1.6,-d*.2,.85,2.5,.85,m.stoneLight,g);
    box(w*.25,eave+2.91,-d*.2,1.05,.22,1.05,m.stone,g);
    box(0,.055,d/2+1.35,3.3,.11,2.7,m.stoneLight,g);
    path([[x,z+d/2+1.5],[x,z+d/2+4.5]],2.7);
    if(index%3===0) {
      const aw=box(0,3.3,d/2+1.2,4.5,.18,2.4,m.fabricTeal,g); aw.rotation.x=.09;
      for(const xx of [-2.1,2.1]) box(xx,1.6,d/2+2.2,.15,3.2,.15,m.wood,g);
    }
    planter(-w/2+.7,d/2+1,g);
    if(index%2===0) planter(w/2-.8,d/2+1,g);
    // Each interior has cover and a recognizable table, without obstructing its door.
    box(-w*.26,.86,-d*.18,1.5,.15,1.4,m.woodLight,g);
    for(const xx of [-.55,.55]) for(const zz of [-.5,.5]) box(-w*.26+xx,.4,-d*.18+zz,.13,.8,.13,m.wood,g);
    box(w*.29,.5,-d*.3,1.6,1,1.2,m.wood,g);
  });
  function fence(x:number,z:number,length:number,alongX=true) {
    const g=new THREE.Group(); g.position.set(x,0,z); if(!alongX)g.rotation.y=Math.PI/2; world.add(g);
    for(let i=0;i<=length;i+=1.4) {box(-length/2+i,.62,0,.15,1.24,.15,m.cream,g); cylinder(-length/2+i,1.3,0,0,.14,.22,m.cream,4,g);}
    box(0,.45,0,length,.13,.1,m.cream,g); box(0,.94,0,length,.13,.1,m.cream,g);
    obstacle(x,z,alongX?length:.15,alongX?.15:length);
  }
  fence(-29,45,7); fence(-13,46,7); fence(30,41,10); fence(-83,32,9,false); fence(69,54,8,false); fence(-54,-44,9,false);

  // A lively trading arcade beside the fountain.
  function market(x:number,z:number,mat:THREE.Material) {
    const g=new THREE.Group(); g.position.set(x,0,z); world.add(g);
    for(const xx of [-2.4,2.4]) for(const zz of [-1.4,1.4]) box(xx,1.7,zz,.14,3.4,.14,m.wood,g);
    box(0,1.1,0,5,.24,2.8,m.woodLight,g); box(0,.65,1.15,4.8,1,.16,m.wood,g);
    for(let i=0;i<6;i++) {const aw=box(-2.13+i*.85,3.43,0,.85,.14,3.6,i%2?m.fabricCream:mat,g); aw.rotation.x=.08; box(-2.13+i*.85,3.18,1.76,.85,.46,.09,i%2?m.fabricCream:mat,g);}
    for(let i=0;i<4;i++) {box(-1.65+i*1.1,1.36,.1,.94,.32,1.9,m.wood,g);for(let j=0;j<4;j++)mesh(sphereGeo,[m.berry,m.gold,m.leafLight,m.violet][i],-1.65+i*1.1+(j%2-.5)*.37,1.67,Math.floor(j/2)*.6-.3,.22,.23,.22,g);}
    obstacle(x,z,5,2.8);
  }
  market(10,-7,m.fabric); market(17,-12,m.fabricTeal); market(-15,19,m.roof);
  function barrel(x:number,z:number) {
    cylinder(x,.66,z,.58,.5,1.32,m.woodLight,10);
    for(const yy of [.2,1.1]) cylinder(x,yy,z,.6,.6,.1,m.black,10);
    cylinder(x,1.35,z,.5,.5,.06,m.wood,10);
  }
  for(const [x,z] of [[14,-9],[15,-9],[-17,17],[-28,-5],[33,-10],[45,18],[-73,35],[-19,45]])barrel(x,z);
  function crates(x:number,z:number,n=3) {
    for(let i=0;i<n;i++) {const xx=x+(i%2)*1.2,yy=.54+Math.floor(i/2)*1.08;box(xx,yy,z,1.08,1.03,1.08,m.woodLight);for(const a of [-.43,.43])box(xx+a,yy,z+.56,.09,1.05,.06,m.wood);box(xx,yy,z+.59,1.07,.09,.06,m.wood);}
  }
  crates(-25,8); crates(14,-12); crates(47,25); crates(-65,-30); crates(85,-33);

  // Northern river: traversable bridges link the valley to the pine foothills.
  box(0,.03,-104,280,.12,16,m.water).castShadow=false;
  for(const zz of [-95.9,-112.1]) {
    box(0,-.06,zz,280,.3,1.6,m.sand).castShadow=false;
    for(let i=0;i<43;i++) rock(-132+i*6.5,zz+(i%2)*.65,.8+(i%3)*.25,m.stoneLight);
  }
  const ripples:THREE.Mesh[]=[];
  for(let i=0;i<42;i++) {const x=-125+(i*37)%250,z=-110+(i*7)%12;const r=box(x,.001,z,1.1+i%4,.015,.065,m.foam);r.castShadow=false;ripples.push(r);}
  animated.push(t=>ripples.forEach((r,i)=>{r.position.x+=Math.sin(t*.3+i)*.0015;r.scale.x=1+Math.sin(t*.65+i)*.16;}));
  for(const x of [-58,60]) {
    box(x,.06,-104,6,.12,20,m.wood);
    for(let i=0;i<24;i++)box(x,.14,-113.6+i*.83,5.8,.12,.68,m.woodLight).castShadow=false;
    for(const side of [-1,1]) {
      for(let i=0;i<6;i++)box(x+side*3, .92,-113+i*3.6,.22,1.8,.22,m.wood);
      box(x+side*3,1.36,-104,.16,.16,20,m.woodLight);
      obstacle(x+side*3,-104,.25,20);
    }
  }
  // Prevent walking across water; gaps align exactly with both bridge decks.
  obstacle(-95.5,-104,67,15); obstacle(1,-104,112,15); obstacle(96.5,-104,67,15);

  // Orchard windmill with rotating fabric sails and a sheltered meadow.
  const wx=-92,wz=73;
  cylinder(wx,.17,wz,5.4,5.8,.34,m.stoneLight,12);
  cylinder(wx,4.8,wz,2.4,3.6,9.5,m.plaster,12);
  cylinder(wx,10.6,wz,0,3.4,3.2,m.roof,12);
  box(wx,1.4,wz+3.25,1.5,2.8,.16,m.wood);
  box(wx,6.5,wz+2.6,1.15,1.45,.14,m.glass);
  cylinder(wx,7.5,wz+3.1,.48,.48,.9,m.wood,12).rotation.x=Math.PI/2;
  const sails=new THREE.Group();sails.position.set(wx,7.5,wz+3.7);world.add(sails);
  for(let i=0;i<4;i++) {
    const arm=new THREE.Group();arm.rotation.z=i*Math.PI/2;sails.add(arm);
    box(0,3.4,0,.16,6.8,.2,m.wood,arm);box(.72,4.35,0,1.3,4.3,.1,m.fabricCream,arm);
    for(let j=0;j<5;j++)box(.73,2.4+j*.85,.1,1.43,.1,.08,m.woodLight,arm);
    box(1.43,4.35,.1,.1,4.35,.08,m.woodLight,arm);
  }
  cylinder(0,0,0,.36,.36,.38,m.gold,12,sails).rotation.x=Math.PI/2;
  animated.push(t=>{sails.rotation.z=t*.14;}); obstacle(wx,wz,6,6);
  fence(-99,64,12,false);fence(-90,82,15);
  for(let i=0;i<7;i++) {box(-105+i*1.9,.16,72,1.15,.2,10,m.sand);for(let j=0;j<7;j++)mesh(sphereGeo,m.leafLight,-105+i*1.9,.62,68+j*1.15,.52,.46,.5);}

  // Weathered ruins, open arches and broken columns reward exploration.
  function ruin(x:number,z:number,scale=1) {
    const g=new THREE.Group();g.position.set(x,0,z);g.scale.setScalar(scale);world.add(g);
    for(const xx of [-5.5,5.5]) {
      box(xx,.22,0,2.6,.44,3,m.stoneLight,g);
      for(let j=0;j<5;j++)box(xx+(j%2)*.04,.95+j*1.23,0,1.95,1.14,2.3,j%2?m.stone:m.stoneLight,g);
      box(xx,7.03,0,2.5,.48,2.7,m.stoneLight,g);obstacle(x+xx*scale,z,2.3*scale,2.7*scale);
    }
    box(0,7.62,0,13.8,.8,2.7,m.stone,g);box(0,8.16,0,14.5,.25,3,m.stoneLight,g);
    for(let i=0;i<7;i++)box(-5.4+i*1.8,8.5,0,1.32,.5,2.55,m.stoneLight,g);
    const sigil=mesh(new THREE.OctahedronGeometry(.68),m.gold,0,7.56,1.42,1,.65,.2,g);sigil.rotation.z=Math.PI/4;
    for(const [xx,zz,h] of [[-8,-7,3.1],[8,-7,5.2],[-8,6,1.3],[8,6,2.2]]) {
      cylinder(xx,h/2,zz,.8,1,h,m.stoneLight,8,g);cylinder(xx,.22,zz,1.3,1.4,.44,m.stone,8,g);
      obstacle(x+xx*scale,z+zz*scale,1.8*scale,1.8*scale);
    }
    for(let i=0;i<8;i++)mesh(sphereGeo,i%2?m.stone:m.stoneLight,-10+(i*7)%21,.35,-7+(i*5)%13,.7,.6,.7,g);
  }
  ruin(95,-84,1.15);ruin(-95,-49,.82);
  path([[82,-80],[95,-84],[106,-80]],3.5,m.stoneLight);
  // A gateway frames the approach to town and the player's extraction courtyard.
  for(const x of [-7,7]) {box(x,2.65,53,1.5,5.3,1.5,m.stoneLight);box(x,5.42,53,2,.3,2,m.stone);obstacle(x,53,1.5,1.5);}
  box(0,5.3,53,15,.62,1.2,m.wood);
  for(const x of [-5.2,5.2]) {box(x,3.5,53.7,1.25,2.35,.075,m.fabricTeal);mesh(new THREE.OctahedronGeometry(.35),m.gold,x,3.65,53.77,1,1,.1);}
  // Tower lookout: base stays on the same walkable ground as the rest of the world.
  cylinder(110,5.2,77,3.1,4,10.4,m.stoneLight,10);obstacle(110,77,7,7);
  cylinder(110,10.4,77,4.1,3.6,.7,m.stone,10);
  for(let i=0;i<10;i++) {const a=i*Math.PI/5;box(110+Math.cos(a)*3.6,11.2,77+Math.sin(a)*3.6,1,.95,1,m.stoneLight);}
  for(let i=0;i<3;i++)box(110,3+i*2.5,80.4,.6,1.2,.12,m.black);

  // Seventy compact garden plots support a 64-hunter home camp. The camp is
  // kept clear of trees, with shared lanes and muted empty pads; only the live
  // authority assigns a player's extraction beacon to one of these locations.
  const campLawn = material('#99ab75');
  for (const pad of HOME_PADS) {
    const plot = cylinder(pad.x, .024, pad.z, 3.8, 3.8, .035, campLawn, 16); plot.castShadow = false;
    for (const side of [-1, 1]) {
      const stone = box(pad.x + side * 3.6, .065, pad.z, .22, .09, 1.9, m.stoneLight); stone.castShadow = false;
    }
  }
  for (const z of [60, 72, 84, 96, 108, 120]) path([[-84,z],[84,z]], 2.2);
  for (const x of [-84,0,84]) path([[x,60],[x,120]], 3.2);
  for (const [x,z] of [[-84,60],[84,60],[-84,120],[84,120],[-8,59],[8,59]]) {
    box(x,2.1,z,.14,4.2,.14,m.wood);
    box(x+.68,3.58,z,1.3,.82,.045,m.fabricTeal);
    mesh(new THREE.OctahedronGeometry(.17),m.gold,x+.66,3.6,z+.04,1,1,.12);
  }
  for (const x of [-60,-36,-12,12,36,60]) {
    bench(x,122); planter(x+2.5,122);
    for (const dz of [-.4,.4]) for (const dx of [-1,0,1]) mesh(sphereGeo,m.leafLight,x+dx,.33,58+dz,.5,.36,.45);
  }

  // Premium prizes are concealed behind real alternating baffles. Northern
  // vaults additionally require a river crossing; there are no teleport pads,
  // decorative-only gates, or unwalkable rooftop prize coordinates.
  for (const area of HIDING_AREAS) {
    const hedge = area.kind === 'hedge-vault';
    const h = area.tier === 500 ? 3.8 : 3.3;
    const floor = box(area.x,.025,area.z,area.w,.045,area.d,hedge?m.grassLight:m.sand); floor.castShadow=false;
    for (const wall of hidingWalls(area)) {
      box(wall.x,h/2,wall.z,wall.w,h,wall.d,hedge?m.leafDark:m.stone);
      box(wall.x,h+.11,wall.z,wall.w+.15,.22,wall.d+.15,hedge?m.leaf:m.stoneLight);
      obstacle(wall.x,wall.z,wall.w,wall.d);
      if (!hedge) for (let yy=.7;yy<h;yy+=.9) box(wall.x,yy,wall.z,wall.w+.025,.035,wall.d+.025,m.stoneDark);
    }
    const entryX=area.x+area.w/2-1.7, entryZ=area.z+area.d/2;
    path([[entryX,entryZ+.5],[entryX,entryZ+2.2]],2.6,hedge?m.path:m.stoneLight);
    for (const dx of [-1.8,1.8]) {
      cylinder(entryX+dx,h/2,entryZ,.34,.48,h,m.stoneLight,8);
      mesh(new THREE.OctahedronGeometry(.3),area.tier===500?m.gold:m.violet,entryX+dx,h+.45,entryZ);
    }
  }

  // Shared geometries and deterministic placement keep the extensive forest inexpensive.
  let seed=1977;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  function closeToPath(x:number,z:number,margin:number) {
    const p=new THREE.Vector2(x,z);
    return paths.some(({a,b,width})=>{const ab=b.clone().sub(a);const t=THREE.MathUtils.clamp(p.clone().sub(a).dot(ab)/ab.lengthSq(),0,1);return p.distanceTo(a.clone().addScaledVector(ab,t))<width/2+margin;});
  }
  const reserved=[[0,12],[35,-22],[-46,-30],[70,42],[-84,55],[95,-84],[0,22],[0,28],[-65,10],[60,-45],[-30,-70]];
  function isOpen(x:number,z:number,margin:number) {
    return !(x>-86-margin&&x<86+margin&&z>58-margin&&z<124)
      && !HIDING_AREAS.some(a=>Math.abs(x-a.x)<a.w/2+margin+2&&Math.abs(z-a.z)<a.d/2+margin+2)
      && !colliders.some(c=>Math.abs(x-c.x)<c.w/2+margin&&Math.abs(z-c.z)<c.d/2+margin)
      && !houses.some(([hx,hz,w,d])=>Math.abs(x-hx)<w/2+margin&&Math.abs(z-hz)<d/2+margin)
      && !reserved.some(([rx,rz])=>Math.hypot(x-rx,z-rz)<6+margin)
      && !(Math.hypot(x,z-6)<20+margin) && !closeToPath(x,z,margin);
  }
  const treePositions:{x:number,z:number,s:number,type:number}[]=[];
  for(let i=0;i<510;i++) {
    const x=(random()-.5)*253,z=(random()-.5)*245;
    if(z < -93&&z >-115)continue;
    if(Math.abs(x)<52&&z>-64&&z<64&&random()>.17)continue;
    if(!isOpen(x,z,3))continue;
    if(treePositions.some(t=>Math.hypot(t.x-x,t.z-z)<4.3))continue;
    treePositions.push({x,z,s:.8+random()*.9,type:random()>.57?1:0});
  }
  const trunkGeometry=new THREE.CylinderGeometry(.16,.3,2.7,6);
  const trunks=new THREE.InstancedMesh(trunkGeometry,m.wood,treePositions.length);
  const crowns=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,1),m.leaf,treePositions.length*3);
  const pineTop=new THREE.InstancedMesh(new THREE.ConeGeometry(2.1,4.8,7),m.leafDark,treePositions.filter(t=>t.type===1).length*2);
  trunks.castShadow=true;crowns.castShadow=true;pineTop.castShadow=true;crowns.receiveShadow=true;
  const dummy=new THREE.Object3D(), color=new THREE.Color();let ci=0,pi=0;
  treePositions.forEach((t,i)=>{
    dummy.position.set(t.x,1.35*t.s,t.z);dummy.scale.set(t.s,t.s,t.s);dummy.rotation.set(0,t.x,0);dummy.updateMatrix();trunks.setMatrixAt(i,dummy.matrix);
    if(t.type===0) {
      for(let j=0;j<3;j++) {dummy.position.set(t.x+(j-1)*.87*t.s,(3.7+(j===1?.85:0))*t.s,t.z+(j%2)*.35);dummy.scale.set(1.7*t.s,1.95*t.s,1.75*t.s);dummy.rotation.y=i+j;dummy.updateMatrix();crowns.setMatrixAt(ci,dummy.matrix);color.set(j===1?'#8daa73':i%3===0?'#6e9470':'#63866b');crowns.setColorAt(ci++,color);}
    } else {
      for(let j=0;j<2;j++) {dummy.position.set(t.x,(3.1+j*1.65)*t.s,t.z);dummy.scale.set((1-j*.25)*t.s,t.s,(1-j*.25)*t.s);dummy.updateMatrix();pineTop.setMatrixAt(pi++,dummy.matrix);}
    }
    obstacle(t.x,t.z,.65*t.s,.65*t.s);
  });
  crowns.count=ci;pineTop.count=pi;world.add(trunks,crowns,pineTop);
  // Groundcover, meadow flowers and scattered stones give paths a softer, lived-in edge.
  const grassTufts=new THREE.InstancedMesh(new THREE.ConeGeometry(.27,.65,3),m.grassDark,1900);
  const flowers=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.12,0),m.fabricCream,350);
  const shrubs=new THREE.InstancedMesh(sphereGeo,m.leafLight,260);
  let gi=0,fi=0,si=0;
  for(let i=0;i<3300;i++) {
    const x=(random()-.5)*248,z=(random()-.5)*241;
    if(z< -94&&z> -114||!isOpen(x,z,.4))continue;
    if(gi<1900) {dummy.position.set(x,.23,z);dummy.scale.set(.55+random(),.6+random()*.7,.55+random());dummy.rotation.set(0,random()*6,random()*.25);dummy.updateMatrix();grassTufts.setMatrixAt(gi++,dummy.matrix);}
    if(i%6===0&&fi<350) {dummy.position.y=.5;dummy.scale.setScalar(.6+random()*.7);dummy.updateMatrix();flowers.setMatrixAt(fi,dummy.matrix);color.set(fi%3===0?'#e5bb66':fi%3===1?'#f1ddad':'#ae8c9d');flowers.setColorAt(fi++,color);}
    if(i%12===0&&si<260) {dummy.position.y=.45;dummy.scale.set(.6+random()*.6,.45+random()*.5,.6+random()*.6);dummy.updateMatrix();shrubs.setMatrixAt(si++,dummy.matrix);}
  }
  grassTufts.count=gi;flowers.count=fi;shrubs.count=si;shrubs.castShadow=true;world.add(grassTufts,flowers,shrubs);
  for(let i=0;i<44;i++) {const x=(random()-.5)*242,z=(random()-.5)*230;if(isOpen(x,z,1.5)&&!(z< -94&&z> -114))rock(x,z,.6+random()*1.1);}

  // Low-poly hill silhouettes sit outside the playable boundary, never hiding an exit.
  const hillMat=material('#789285'), mountainMat=material('#839c95'), farMountainMat=material('#9bada4');
  for(let i=0;i<25;i++) {
    const a=i/25*Math.PI*2,r=164+random()*28,x=Math.cos(a)*r,z=Math.sin(a)*r;
    const h=20+random()*43,rad=24+random()*28;
    const hill=mesh(new THREE.ConeGeometry(rad,h,5+(i%3)),i%3===0?farMountainMat:mountainMat,x,h/2-2,z,1,1,.85);hill.rotation.y=random()*3;hill.castShadow=false;
    const foot=mesh(sphereGeo,hillMat,x*.93,2,z*.93,rad*1.4,8+random()*8,rad);foot.castShadow=false;
    const scenery:THREE.Mesh[]=[hill,foot];
    if(h>50) {const snow=mesh(new THREE.ConeGeometry(rad*.18,h*.2,5+(i%3)),m.cream,x,h*.89-2,z,1,1,.85);snow.rotation.y=hill.rotation.y;snow.castShadow=false;scenery.push(snow);}
    // Large foothills previously extended deep inside the playable square.
    // Place their entire footprint beyond its solid movement boundary so they
    // cannot overlap homes, bridge approaches, or hidden-card routes.
    const axis=Math.abs(x)>Math.abs(z)?'x':'z', sign=Math.sign(axis==='x'?x:z);
    const bounds=new THREE.Box3();for(const object of scenery){object.updateMatrixWorld(true);bounds.expandByObject(object);}
    const edge=sign>0?bounds.min[axis]:-bounds.max[axis], shift=Math.max(0,126-edge)*sign;
    for(const object of scenery)object.position[axis]+=shift;
  }
  // Colored pennants animate lightly above the central square.
  for(const x of [-16,16]) {box(x,4.8,17,.17,9.6,.17,m.wood);}
  const cable=beam(new THREE.Vector3(-16,9.4,17),new THREE.Vector3(16,9.4,17),.04,m.wood);
  cable.castShadow=false;
  const flags:THREE.Mesh[]=[];
  for(let i=0;i<17;i++) {
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute([-.6,0,0,.6,0,0,0,-1.4,0],3));geo.computeVertexNormals();
    const mat=[m.fabric,m.fabricTeal,m.fabricCream,m.roof][i%4].clone();mat.side=THREE.DoubleSide;
    const f=mesh(geo,mat,-14.5+i*1.8,9.3-Math.sin(i/16*Math.PI)*.65,17);flags.push(f);
  }
  animated.push(t=>flags.forEach((f,i)=>{f.rotation.x=Math.sin(t*1.6+i*.5)*.15;}));
  // Batch the static diorama by material and shadow settings. Thousands of architectural
  // details become a few dozen draw calls, while sails, water and pennants stay animated.
  const moving = new Set<THREE.Object3D>([sails, ...ripples, ...flags]);
  const batches = new Map<string, { mat: THREE.Material; cast: boolean; receive: boolean; geometry: THREE.BufferGeometry[] }>();
  const remove: THREE.Mesh[] = [];
  world.updateMatrixWorld(true);
  world.traverse(o => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh || Array.isArray(o.material)) return;
    let ancestor: THREE.Object3D | null = o;
    while (ancestor) { if (moving.has(ancestor)) return; ancestor = ancestor.parent; }
    const key = `${o.material.uuid}:${o.castShadow}:${o.receiveShadow}`;
    let batch = batches.get(key);
    if (!batch) { batch = { mat: o.material, cast: o.castShadow, receive: o.receiveShadow, geometry: [] }; batches.set(key, batch); }
    const geometry = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    geometry.applyMatrix4(o.matrixWorld);
    geometry.deleteAttribute('uv');
    batch.geometry.push(geometry); remove.push(o);
  });
  for (const batch of batches.values()) {
    const geometry = mergeGeometries(batch.geometry, false);
    if (!geometry) continue;
    const merged = new THREE.Mesh(geometry, batch.mat);
    merged.castShadow = batch.cast; merged.receiveShadow = batch.receive;
    merged.name = 'Batched valley architecture'; world.add(merged);
    batch.geometry.forEach(g => g.dispose());
  }
  remove.forEach(o => o.removeFromParent());
  const landmarks: Landmark[] = [
    {name:'Hearthwick',x:0,z:6,color:'#edcc8b'}, {name:'Whisperwood',x:-84,z:55,color:'#86aa7b'},
    {name:'Sunmill Orchard',x:-92,z:73,color:'#e4bc7a'}, {name:'Crown Ruins',x:95,z:-84,color:'#a895cf'},
    {name:'Silverwater',x:5,z:-104,color:'#80bec2'}, {name:'Old Watch',x:110,z:77,color:'#c0b3a1'},
  ];
  return { colliders, landmarks, spawn: new THREE.Vector3(0,0,22), update: (t:number)=>animated.forEach(fn=>fn(t)) };
}
