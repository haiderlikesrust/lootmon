import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { MAP_EXTENT, mapGrid } from '../shared/map-grid.mjs';

const source = readFileSync(new URL('../src/map.ts', import.meta.url), 'utf8').replace(/^(import|export \{).*$/gm, '').replace(/export /g, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const drawIslandMap = new Function('MAP_EXTENT', 'mapGrid', `${compiled}; return drawIslandMap;`)(MAP_EXTENT, mapGrid);

test('both maps show only current disclosed packs and clear them when visibility is withdrawn', () => {
  for (const small of [true, false]) {
    const labels = [];
    const ctx = new Proxy({
      fillText: text => labels.push(text),
      measureText: text => ({ width: text.length * 6 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
    }, { get: (target, key) => target[key] ?? (() => {}) });
    const canvas = { width: 900, height: 900, getContext: () => ctx };
    const options = { small, background: null, landmarks: [], myId: 'me', players: [{ id:'me', x:0, z:0, base:{x:0,z:70} }],
      packs: [{ id:'known', x:8, z:8, tier:25, status:'hidden' }, { id:'secured', x:8, z:8, tier:500, status:'secured' }] };
    drawIslandMap(canvas, options);
    assert.ok(labels.includes('$25'));
    assert.ok(labels.includes('YOU ARE IN D4'));
    assert.ok(!labels.includes('$500'));
    labels.length = 0;
    drawIslandMap(canvas, { ...options, packs: [] });
    assert.ok(!labels.includes('$25'));
    labels.length = 0;
    drawIslandMap(canvas, { ...options, myId: null, players: [] });
    assert.ok(!labels.includes('$25'), 'exploration mode does not show reward markers');
  }
});
