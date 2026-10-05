import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collidesWithWorld } from '../shared/collision-index.mjs';
const colliders = JSON.parse(readFileSync(new URL('../shared/world-colliders.json', import.meta.url), 'utf8'));
const original = (x,z,radius) => colliders.some(box => {
  const nearX = Math.max(box.x-box.w/2, Math.min(x,box.x+box.w/2));
  const nearZ = Math.max(box.z-box.d/2, Math.min(z,box.z+box.d/2));
  return (x-nearX)**2+(z-nearZ)**2 < radius**2;
});
test('spatial collision lookup preserves all island checks including cell boundaries and base clearance', t => {
  const points = [];
  for(let z=-128;z<=128;z+=1.6) for(let x=-128;x<=128;x+=1.6) points.push([x,z,.6]);
  for (const c of colliders) for (const radius of [.6,4.15]) {
    points.push([c.x-c.w/2-radius,c.z,radius], [c.x+c.w/2+radius-.00001,c.z,radius], [c.x,c.z-c.d/2,radius]);
  }
  const start = performance.now();
  const expected = points.map(p => original(...p));
  const middle = performance.now();
  const actual = points.map(p => collidesWithWorld(colliders,...p));
  const end = performance.now();
  assert.deepEqual(actual,expected);
  t.diagnostic(`${points.length} collision checks: full scan ${(middle-start).toFixed(1)} ms; indexed ${(end-middle).toFixed(1)} ms.`);
  assert.equal(collidesWithWorld([],0,0),false);
  assert.equal(collidesWithWorld(colliders,NaN,0),true);
});
