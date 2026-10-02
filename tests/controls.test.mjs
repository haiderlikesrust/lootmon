import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

// Run the actual Game constructor, registered browser handlers and camera math.
// Only WebGL, asset loading and browser surfaces are replaced; no copy of the
// movement/camera/action implementation is used by these offline regressions.
const source = readFileSync(new URL('../src/game.ts', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace('export class Game', 'class Game');
const createClass = new Function('THREE', 'OrbitControls', 'createCharacter', 'loadCharacters', 'createWorld', 'window', 'document', 'localStorage', 'HTMLElement', 'ResizeObserver', 'devicePixelRatio', 'performance', `${compiled}; return Game;`);

async function fixture() {
  const window = new EventTarget(), document = new EventTarget(), canvas = new EventTarget(), hud = new EventTarget();
  const saved = new Map(), pointerIds = new Set(), gestures = [], motions = [];
  let now = 10, modal = false, overlay = false, denyCapture = false, captures = 0, actions = 0, liveActions = 0;
  Object.assign(window, { matchMedia: () => ({ matches: true }) });
  Object.assign(document, {
    hidden: false, activeElement: null, pointerLockElement: null, body: { classList: new Set() },
    querySelector: () => modal ? {} : null,
    elementFromPoint: () => overlay ? hud : canvas,
    exitPointerLock() { this.pointerLockElement = null; this.dispatchEvent(new Event('pointerlockchange')); },
  });
  document.body.classList.contains = name => document.body.classList.has(name);
  Object.assign(canvas, {
    style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
    setPointerCapture: id => pointerIds.add(id), hasPointerCapture: id => pointerIds.has(id), releasePointerCapture: id => pointerIds.delete(id),
    requestPointerLock() {
      captures++;
      if (denyCapture) return Promise.reject(new Error('Embedded browser denied pointer lock'));
      document.pointerLockElement = canvas;
      document.dispatchEvent(new Event('pointerlockchange'));
      return Promise.resolve();
    },
  });
  class Renderer {
    domElement = canvas; shadowMap = {};
    setPixelRatio() {} setSize() {} setAnimationLoop(callback) { this.loop = callback; } render() {}
  }
  class Controls {
    target = new THREE.Vector3(); enabled = true;
    constructor(camera) { this.camera = camera; }
    update() { this.camera.lookAt(this.target); }
  }
  const makeCharacter = variant => { const group = new THREE.Group(); group.userData.characterVariant = variant; return { group, update: (_dt, state) => motions.push(state), playOnce: name => gestures.push(name), dispose() {} }; };
  const Game = createClass({ ...THREE, WebGLRenderer: Renderer }, Controls, makeCharacter, async () => {}, () => ({ spawn: new THREE.Vector3(0, 0, 22), colliders: [], update() {} }), window, document,
    { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }, class {}, class { observe() {} }, 1, { now: () => now });
  const game = new Game({ clientWidth: 1000, clientHeight: 600, appendChild() {} });
  await game.ready;
  game.clock.getDelta = () => 1 / 60;
  game.onExploreAction = () => actions++;
  game.onInteract = () => liveActions++;
  return {
    game, window, document, canvas, hud, gestures, motions, saved, pointerIds,
    get captures() { return captures; }, get actions() { return actions; }, get liveActions() { return liveActions; },
    set modal(value) { modal = value; }, set overlay(value) { overlay = value; }, set denyCapture(value) { denyCapture = value; },
    frame(count = 1) { for (let i = 0; i < count; i++) { now += 1000 / 60; game.frame(); } },
  };
}
function emit(target, type, values = {}) { const event = new Event(type, { cancelable: true }); Object.assign(event, values); target.dispatchEvent(event); return event; }
function rightPress(canvas) {
  emit(canvas, 'pointerdown', { pointerType: 'mouse', pointerId: 1, button: 2, buttons: 2 });
  const down = emit(canvas, 'mousedown', { button: 2, buttons: 2 });
  emit(canvas, 'mousemove', { movementX: 0, movementY: 0, buttons: 2 });
  emit(canvas, 'contextmenu', { button: 2 });
  emit(canvas, 'mouseup', { button: 2, buttons: 0 });
  emit(canvas, 'pointerup', { pointerType: 'mouse', pointerId: 1, button: 2, buttons: 0 });
  return down;
}
function near(actual, expected, tolerance = 1e-7) { assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`); }

test('right mouse grabs once per press, E does nothing, left capture and action button remain separate', async () => {
  const f = await fixture();
  await f.game.enterExplore();
  assert.equal(f.game.mouseCaptured, true);
  emit(f.window, 'keydown', { code: 'KeyE', repeat: false });
  assert.equal(f.actions, 0);
  assert.equal(rightPress(f.canvas).defaultPrevented, true);
  assert.equal(f.actions, 1);
  assert.deepEqual(f.gestures, ['Interact']);
  f.frame(60);
  assert.equal(f.actions, 1, 'holding a button never repeats the grab');
  // Pointer events only emit pointerdown for the first pressed mouse button.
  emit(f.canvas, 'mousedown', { button: 2, buttons: 3 });
  assert.equal(f.actions, 2, 'right press also works with the left button held');
  f.game.releasePointer();
  const count = f.captures;
  rightPress(f.canvas);
  assert.equal(f.actions, 3);
  assert.equal(f.captures, count, 'right click does not steal its action for camera capture');
  emit(f.canvas, 'pointerdown', { pointerType: 'mouse', button: 0 });
  emit(f.canvas, 'mousedown', { button: 0 });
  assert.equal(f.captures, count + 1);
  assert.equal(f.actions, 3);
  assert.equal(f.liveActions, 0, 'exploration never invokes a live reward action');
  f.game.playing = true; f.game.exploring = false; f.game.id = 'verified-player';
  rightPress(f.canvas);
  f.game.interact(); // Touch/action button uses this same public API.
  assert.equal(f.liveActions, 2);
});

test('grab and context-menu handling stay on the active canvas, without queued menu/HUD actions', async () => {
  const f = await fixture();
  assert.equal(rightPress(f.canvas).defaultPrevented, false);
  assert.equal(emit(f.canvas, 'contextmenu').defaultPrevented, false);
  await f.game.enterExplore();
  assert.equal(emit(f.canvas, 'contextmenu').defaultPrevented, true);
  assert.equal(rightPress(f.hud).defaultPrevented, false);
  assert.equal(emit(f.hud, 'contextmenu').defaultPrevented, false);
  f.modal = true;
  assert.equal(rightPress(f.canvas).defaultPrevented, false);
  f.frame();
  assert.equal(f.game.mouseLookMode, 'released');
  f.modal = false;
  f.frame();
  assert.equal(f.actions, 0, 'closing a menu cannot replay the earlier press');
  f.document.activeElement = { matches: () => true };
  rightPress(f.canvas);
  assert.equal(f.actions, 0);
  f.document.activeElement = null;
  rightPress(f.canvas);
  assert.equal(f.actions, 1);
  f.game.leave();
  assert.equal(emit(f.canvas, 'contextmenu').defaultPrevented, false);
});

test('leaderboard and chat focus suspend controls without leaving the active hunt', async () => {
  const f = await fixture();
  await f.game.enterExplore();
  emit(f.window, 'keydown', { code: 'KeyW', repeat: false });
  f.frame(3);
  const before = f.game.explorationPosition;
  f.document.body.classList.add('leaderboard-page');
  emit(f.window, 'keydown', { code: 'Space', repeat: false });
  rightPress(f.canvas);
  f.frame(10);
  near(f.game.explorationPosition.x, before.x); near(f.game.explorationPosition.z, before.z);
  assert.equal(f.actions, 0);
  assert.equal(f.game.exploring, true);
  f.document.body.classList.delete('leaderboard-page');
  f.document.activeElement = { matches: () => true };
  emit(f.window, 'keydown', { code: 'KeyW', repeat: false });
  f.frame(10);
  near(f.game.explorationPosition.z, before.z);
  f.document.activeElement = null;
  f.frame(3);
  near(f.game.explorationPosition.z, before.z, .001);
  emit(f.window, 'keydown', { code: 'KeyW', repeat: false });
  f.frame(3);
  assert.notEqual(f.game.explorationPosition.z, before.z);
});

test('captured mouse without a held button turns continuously, honors saved sensitivity, and Escape releases first', async () => {
  const f = await fixture();
  await f.game.enterExplore();
  const start = f.game.angle;
  f.game.setSensitivity(2);
  emit(f.document, 'mousemove', { movementX: 100, movementY: 0, buttons: 0 });
  near(f.game.angle, start - .7);
  assert.equal(f.saved.get('lootmon-mouse-sensitivity'), '2');
  assert.equal(f.game.setSensitivity(9), 3);
  assert.equal(f.game.setSensitivity(NaN), 3);
  assert.equal(f.game.setSensitivity(-1), .25);
  f.game.setSensitivity(1);
  for (let i = 0; i < 80; i++) emit(f.document, 'mousemove', { movementX: 100, movementY: 0, buttons: 0 });
  assert.ok(start - f.game.angle > Math.PI * 8);
  f.frame(90);
  near(f.game.yaw, f.game.renderedAngle + Math.PI);
  emit(f.window, 'keydown', { code: 'Escape', repeat: false });
  assert.equal(f.game.exploring, true);
  assert.equal(f.game.mouseCaptured, false);
  const stopped = f.game.angle;
  f.frame(30);
  near(f.game.renderedAngle, stopped);
  emit(f.window, 'keyup', { code: 'Escape' });
  emit(f.window, 'keydown', { code: 'Escape', repeat: false });
  assert.equal(f.game.exploring, false);
});

test('denied capture uses unlimited edge look and stops over HUD, at center, on leave, blur and menus', async () => {
  const f = await fixture();
  f.denyCapture = true;
  await f.game.enterExplore();
  await Promise.resolve();
  assert.equal(f.game.mouseLookMode, 'hover');
  const captures = f.captures;
  emit(f.canvas, 'pointermove', { pointerType: 'mouse', clientX: 999, clientY: 300, buttons: 0 });
  const start = f.game.angle;
  f.frame(720);
  assert.ok(start - f.game.angle > Math.PI * 8);
  assert.equal(f.captures, captures);
  f.overlay = true;
  const overHud = f.game.angle; f.frame(30); near(f.game.angle, overHud);
  f.overlay = false;
  emit(f.canvas, 'pointermove', { pointerType: 'mouse', clientX: 500, clientY: 300, buttons: 0 });
  const center = f.game.angle; f.frame(30); near(f.game.angle, center);
  emit(f.canvas, 'pointermove', { pointerType: 'mouse', clientX: 999, clientY: 300, buttons: 0 });
  emit(f.canvas, 'pointerleave');
  const left = f.game.angle; f.frame(30); near(f.game.angle, left);
  emit(f.window, 'blur');
  assert.equal(f.game.mouseLookMode, 'released');
  const blurred = f.game.renderedAngle; f.frame(30); near(f.game.renderedAngle, blurred);
  f.game.capturePointer(); await Promise.resolve();
  emit(f.canvas, 'pointermove', { pointerType: 'mouse', clientX: 999, clientY: 300, buttons: 0 });
  f.modal = true; f.frame();
  const menu = f.game.renderedAngle; f.frame(30); near(f.game.renderedAngle, menu);
  assert.equal(f.game.mouseLookMode, 'released');
});

test('compass uses rendered camera headings without wrap jumps and movement follows those headings', async () => {
  const f = await fixture();
  await f.game.enterExplore();
  f.game.headingInitialized = false;
  for (let degree = 0; degree <= 1080; degree += 3) {
    f.game.renderedAngle = -degree * Math.PI / 180;
    f.game.followCamera(); f.game.updateCompassHeading();
    near(f.game.compassHeadingContinuousDegrees, degree, 1e-6);
  }
  for (const [angle, heading, x, z] of [[0, 0, 0, -1], [-Math.PI / 2, 90, 1, 0], [-Math.PI, 180, 0, 1], [-Math.PI * 1.5, 270, -1, 0]]) {
    f.game.pos.set(0, 0, 0); f.game.angle = f.game.renderedAngle = angle;
    f.game.setControl('KeyW', true); f.frame(); f.game.setControl('KeyW', false);
    near(f.game.compassHeadingDegrees, heading);
    near(f.game.pos.x, x * 7 / 60); near(f.game.pos.z, z * 7 / 60);
    assert.equal(f.motions.at(-1).moving, true);
  }
});

test('touch drag and running grab retain movement; measured FPS uses rendering timestamps', async () => {
  const f = await fixture();
  await f.game.enterExplore();
  f.game.releasePointer();
  const start = f.game.angle;
  emit(f.canvas, 'pointerdown', { pointerType: 'touch', pointerId: 9, clientX: 200, clientY: 200 });
  emit(f.canvas, 'pointermove', { pointerType: 'touch', pointerId: 9, clientX: 300, clientY: 220 });
  near(f.game.angle, start - .35);
  assert.equal(f.pointerIds.has(9), true);
  emit(f.canvas, 'pointerup', { pointerId: 9 });
  assert.equal(f.pointerIds.size, 0);
  f.game.setControl('KeyW', true); f.game.setControl('ShiftLeft', true);
  rightPress(f.canvas); f.frame();
  assert.equal(f.motions.at(-1).moving, true); assert.equal(f.motions.at(-1).sprinting, true);
  assert.equal(f.gestures.at(-1), 'Interact');
  f.game.clearInput();
  f.game.clock.getDelta = () => .05; // Deliberately different from render cadence.
  f.frame(150);
  near(f.game.framesPerSecond, 60);
});

function snapshot(overrides = {}) {
  return {
    players: [{ id: 'verified-player', name: 'Collector', x: 0, z: 0, yaw: 0, carrying: null, base: { x: 0, z: 0 }, score: 0, elite: true, stamina: 100, character: 'scout', ...overrides }],
    packs: [], treasury: {}, events: [], serverTime: Date.now() - 600_000,
  };
}

test('dash prediction uses server time when the local wall clock is ten minutes ahead', async () => {
  const f = await fixture();
  const state = snapshot({ ability: 'dash', abilityUntil: Date.now() - 600_000 + 8000 });
  f.game.setState(state); f.game.setPlaying('verified-player');
  f.game.angle = f.game.renderedAngle = 0;
  f.game.setControl('KeyW', true); f.frame();
  near(f.game.pos.z, -20 / 60);
  const before = f.game.pos.z;
  f.game.setState({ ...state, players: [{ ...state.players[0], abilityUntil: state.serverTime - 1 }] });
  f.frame();
  near(f.game.pos.z - before, -10 / 60);
});

test('server-disclosed radar packs render despite clock skew and disappear with resource cleanup when withdrawn', async () => {
  const f = await fixture();
  const state = snapshot({ ability: 'radar', abilityUntil: Date.now() - 600_000 + 8000 });
  state.packs = [{ id: 'funded-pack', tier: 500, value: 500, x: 40, z: 0, status: 'hidden' }];
  f.game.setState(state); f.game.setPlaying('verified-player'); f.frame();
  const pack = f.game.packMeshes.get('funded-pack');
  assert.ok(pack?.visible, 'Allowed server discovery cannot be hidden by local clock skew');
  assert.ok(pack.getObjectByName('DiscoveryPointer')?.visible, 'A disclosed pack has a clear overhead indicator');
  let resources = 0, disposed = 0;
  pack.traverse(object => { if (object instanceof THREE.Mesh) {
    for (const resource of [object.geometry, ...(Array.isArray(object.material) ? object.material : [object.material])]) { resources++; resource.addEventListener('dispose', () => disposed++); }
  } });
  f.game.setState({ ...state, packs: [] }); f.frame();
  assert.equal(f.game.packMeshes.size, 0);
  assert.equal(f.game.scene.children.includes(pack), false);
  assert.equal(disposed, resources, 'Removed discoveries release their GPU geometry and materials');
  assert.ok(resources > 0);
});

test('same-wallet reconnect updates character and base, and leaving disposes game-owned markers', async () => {
  const f = await fixture();
  const state = snapshot();
  state.players.push({ ...state.players[0], id: 'rival', x: 60, z: 20, base: { x: 60, z: 20 } });
  f.game.setState(state); f.game.setPlaying('verified-player'); f.frame();
  const oldRival = f.game.avatarMeshes.get('rival');
  near(oldRival.position.x, 60);
  let oldMarkerDisposed = false;
  oldRival.getObjectByName('PlayerMarker').geometry.addEventListener('dispose', () => oldMarkerDisposed = true);
  const next = { ...state, players: [state.players[0], { ...state.players[1], character: 'sage', base: { x: -60, z: 20 } }] };
  f.game.setState(next); f.frame();
  const replacement = f.game.avatarMeshes.get('rival');
  assert.notEqual(replacement, oldRival);
  assert.equal(replacement.userData.characterVariant, 'sage');
  assert.equal(oldMarkerDisposed, true);
  assert.equal(f.game.bases.size, 2);
  near(f.game.bases.get('rival').position.x, -60);
  let baseDisposed = 0;
  for (const base of f.game.bases.values()) base.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.addEventListener('dispose', () => baseDisposed++); });
  f.game.leave();
  assert.equal(f.game.avatarMeshes.size, 0); assert.equal(f.game.bases.size, 0);
  assert.ok(baseDisposed > 0);
});
