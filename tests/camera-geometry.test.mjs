import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { Game } from '../server/game.mjs';

async function loadSource(name) {
  let source = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  for (const name of ['three', 'three-mesh-bvh', 'three/addons/utils/BufferGeometryUtils.js'])
    source = source.replace(`from '${name}'`, `from '${import.meta.resolve(name)}'`);
  source = source.replace("from '../shared/world-layout.mjs'", `from '${new URL('../shared/world-layout.mjs', import.meta.url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const { createWorld } = await loadSource('world');
const { accelerateCameraGeometry } = await loadSource('camera-geometry');

test('accelerated camera collision preserves closest hits across the actual island', t => {
  const scene = new THREE.Scene();
  createWorld(scene); scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(); ray.near = .35; ray.far = 10;
  const poses = Array.from({ length: 160 }, (_, i) => ({
    origin: new THREE.Vector3((i * 37 % 220) - 110, 1.45, (i * 53 % 220) - 110),
    direction: new THREE.Vector3(Math.sin(i * 1.71), .3, Math.cos(i * 1.71)).normalize(),
  }));
  const measure = () => {
    const times = [], hits = [];
    for (const pose of poses) {
      ray.set(pose.origin, pose.direction);
      const start = performance.now();
      const hit = ray.intersectObjects(scene.children, true)[0];
      times.push(performance.now() - start);
      hits.push(hit ? { distance: hit.distance, object: hit.object } : null);
    }
    times.sort((a,b) => a-b);
    return { hits, median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * .95)] };
  };
  measure();
  const before = measure();
  accelerateCameraGeometry(scene.children); ray.firstHitOnly = true;
  measure();
  const after = measure();
  assert.ok(before.hits.filter(Boolean).length > 20, 'exercise real obstruction hits');
  for (let i = 0; i < poses.length; i++) {
    assert.equal(Boolean(after.hits[i]), Boolean(before.hits[i]), `ray ${i}`);
    if (before.hits[i]) {
      assert.equal(after.hits[i].object, before.hits[i].object);
      assert.ok(Math.abs(after.hits[i].distance - before.hits[i].distance) < 1e-5);
    }
  }
  t.diagnostic(`Camera CPU median ${before.median.toFixed(3)} → ${after.median.toFixed(3)} ms; p95 ${before.p95.toFixed(3)} → ${after.p95.toFixed(3)} ms (local CPU, not browser FPS).`);
});

test('riverbank boulders block authoritative movement and client collision footprints match', () => {
  const scene = new THREE.Scene();
  const { colliders } = createWorld(scene);
  const saved = JSON.parse(readFileSync(new URL('../shared/world-colliders.json', import.meta.url), 'utf8'));
  assert.deepEqual(colliders, saved);
  const game = new Game({ colliders });
  // Known exposed bank boulders: test their actual occupied ground, not just
  // whether a collider was added to the list.
  for (const rock of colliders.filter(c => c.z < -90 && c.z > -110 && c.w > 1 && c.w < 5)) {
    assert.equal(game.collides(rock.x, rock.z), true);
  }
  assert.ok(colliders.some(c => c.z < -90 && c.z > -110 && c.w > 1 && c.w < 5));
});
