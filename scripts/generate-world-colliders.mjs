import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as THREE from 'three';

// Generate from the actual visual world, not a second hand-maintained list.
const sourcePath = new URL('../src/world.ts', import.meta.url);
let source = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
source = source.replace("from 'three'", `from '${import.meta.resolve('three')}'`)
  .replace("from 'three/addons/utils/BufferGeometryUtils.js'", `from '${import.meta.resolve('three/addons/utils/BufferGeometryUtils.js')}'`)
  .replace("from '../shared/world-layout.mjs'", `from '${new URL('../shared/world-layout.mjs', import.meta.url).href}'`);
const { createWorld } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { colliders } = createWorld(new THREE.Scene());
const path = fileURLToPath(new URL('../shared/world-colliders.json', import.meta.url));
const json = JSON.stringify(colliders, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== json) throw new Error('World collider data is stale. Run node scripts/generate-world-colliders.mjs.');
  console.log(`World collider data matches ${colliders.length} generated rectangles.`);
} else { writeFileSync(path, json); console.log(`Generated ${colliders.length} world collision rectangles.`); }
