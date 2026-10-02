import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const source = readFileSync(new URL('../src/characters.ts', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/^export /gm, '');
const prepareTemplate = new Function('THREE', `${compiled}; return prepareTemplate;`)(THREE);
const assets = [['scout', 'Rogue'], ['ranger', 'Rogue_Hooded'], ['sage', 'Mage']];

test('gateway allows embedded GLB texture fetches without weakening script or frame restrictions', () => {
  const nginx = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');
  const csp = nginx.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
  assert.ok(csp, 'Gateway sends CSP');
  const directives = Object.fromEntries(csp.split(';').map(value => value.trim().split(/\s+/)).filter(parts => parts[0]).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives['connect-src'], ["'self'", 'https:', 'wss:', 'blob:']);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
});

test('actual character GLBs retain required atlas maps, and a swallowed texture failure cannot become a white hunter', async () => {
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const priorBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
  // Node has no image decoder. Read each actual PNG's dimensions while using
  // GLTFLoader's real blob creation/fetch/material path; no external requests.
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async blob => {
    const png = Buffer.from(await blob.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), close() {} };
  } });
  try {
    for (const [variant, file] of assets) {
      const bytes = readFileSync(new URL(`../public/models/kaykit-adventurers/${file}.glb`, import.meta.url));
      const document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
      assert.ok(document.images.every(image => image.bufferView !== undefined && image.mimeType === 'image/png'));
      assert.ok(document.materials.every(material => material.pbrMetallicRoughness?.baseColorTexture));
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
      assert.doesNotThrow(() => prepareTemplate(gltf, variant));
      let affected = 0;
      gltf.scene.traverse(object => {
        if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) { material.map = null; affected++; }
      });
      assert.ok(affected > 0);
      assert.throws(() => prepareTemplate(gltf, variant), /character texture did not load/, `${file} cannot silently accept a missing atlas`);
    }
  } finally {
    if (priorSelf) Object.defineProperty(globalThis, 'self', priorSelf); else delete globalThis.self;
    if (priorBitmap) Object.defineProperty(globalThis, 'createImageBitmap', priorBitmap); else delete globalThis.createImageBitmap;
  }
});
