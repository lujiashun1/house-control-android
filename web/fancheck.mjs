// Headless smoke test: the fan model, its airflow, and the store, with no browser.
import fs from 'node:fs';
import assert from 'node:assert/strict';

/* ----- the few browser bits three.js and the app touch on import ----- */
const ctx = {
  createRadialGradient: () => ({ addColorStop: () => {} }),
  fillRect: () => {},
  set fillStyle(_) {},
};
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
};
globalThis.window = { __HOUSE_BOOT__: null, addEventListener() {} };
globalThis.location = { search: '' };
globalThis.localStorage = {
  map: new Map(),
  getItem: (k) => globalThis.localStorage.map.get(k) ?? null,
  setItem: (k, v) => globalThis.localStorage.map.set(k, v),
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.requestAnimationFrame = () => 0;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.devicePixelRatio = 1;

// Paths are relative to web/, so this runs from anywhere: `cd web && node fancheck.mjs`
const THREE = await import('./node_modules/three/build/three.module.js');
const { normalize } = await import('./src/config.js');
const { FanUnit, SPEEDS } = await import('./src/three/fan.js');
const { createStore } = await import('./src/store.js');

/* ----- 1. the plan's fan survives normalize ----- */
const raw = JSON.parse(fs.readFileSync('./public/plans/home.json', 'utf8'));
const config = normalize(raw);
assert.equal(config.fans.length, 1, 'one fan in the demo plan');
const cfg = config.fans[0];
assert.equal(cfg.id, 'living.fan');
assert.equal(cfg.height, 0.95);
assert.equal(cfg.sweep, 45);
assert.equal(cfg.rot, 180);
assert.equal(cfg.level, config.rooms.find((r) => r.id === 'living').level);
console.log('plan  ok:', cfg.id, 'room', cfg.room, 'level', cfg.level, 'rot', cfg.rot);

/* ----- 2. normalize rejects a fan without a room or a place ----- */
assert.throws(() => normalize({ ...raw, fans: [{ id: 'x.fan', room: 'nope', pos: [0, 0] }] }), /unknown room/);
assert.throws(() => normalize({ ...raw, fans: [{ id: 'x.fan', room: 'living' }] }), /needs "pos"/);
assert.throws(() => normalize({ ...raw, fans: [{ id: 'living', room: 'living', pos: [0, 0] }] }), /Duplicate id/);
assert.throws(() => normalize({ ...raw, fans: [{ id: 'a.fan', room: 'living', pos: [0, 0] }, { id: 'a.fan', room: 'living', pos: [1, 1] }] }), /Duplicate id/);
console.log('guard ok: unknown room, missing pos, duplicate id all thrown');

/* ----- 3. the store keeps a fan local ----- */
globalThis.localStorage.map.set('house-control:state:v1', JSON.stringify({ home: 'Home', fans: { 'living.fan': { on: true, speed: 4 } } }));
const store = createStore(config);
assert.deepEqual(store.state.fans['living.fan'], { on: true, speed: 4, percent: 40, oscillate: false, preset: null, direction: 'forward' }, 'restored from storage');
store.setFan('living.fan', { speed: 9 });
assert.equal(store.state.fans['living.fan'].speed, 5, 'speed clamped to 5');
store.setFan('living.fan', { speed: 0 });
assert.equal(store.state.fans['living.fan'].on, true, 'a speed step does not switch it off');
store.setFan('living.fan', { speed: 2 });
assert.equal(store.state.fans['living.fan'].speed, 2);
store.toggleFan('living.fan');
assert.equal(store.state.fans['living.fan'].on, false);
store.setAllFans(true);
assert.equal(store.state.fans['living.fan'].on, true);
assert.equal(store.state.fans['living.fan'].speed >= 1, true);
const summary = store.summary();
assert.equal('fans' in summary, false, 'summary stays as the native side knows it');
console.log('store ok: restore, clamp, on-by-speed, toggle, all-fans, summary unchanged');

/* ----- 4. the unit spins, sweeps and blows ----- */
const unit = new FanUnit({ ...cfg, pos: [cfg.pos[0], cfg.pos[1]] });
unit.apply({ on: true, speed: 5, oscillate: true, sweep: 45 }, { instant: false });
for (let i = 0; i < 200; i++) unit.update(0.016);          // ~3.2 s
assert.ok(Math.abs(unit.omega - SPEEDS[5]) < 0.05, `omega ${unit.omega} should settle near ${SPEEDS[5]}`);
assert.ok(unit.rpm > 410 && unit.rpm < 425, `rpm ${unit.rpm}`);
assert.ok(unit.wind.visible, 'airflow visible while running');

// Every mote sits inside the cone out of the guard and carries a real colour.
const pos = unit.wind.geometry.attributes.position.array;
const col = unit.wind.geometry.attributes.color.array;
let maxR = 0; let maxZ = 0; let lit = 0;
for (let i = 0; i < pos.length / 3; i++) {
  const x = pos[i * 3]; const y = pos[i * 3 + 1]; const z = pos[i * 3 + 2];
  assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `mote ${i} is finite`);
  maxR = Math.max(maxR, Math.hypot(x, y));
  maxZ = Math.max(maxZ, z);
  if (col[i * 3 + 1] > 0.02) lit++;
}
assert.ok(maxR < 0.24, `motes stay inside the guard, max radius ${maxR.toFixed(3)}`);
assert.ok(maxZ > 1.6 && maxZ <= 2.0, `air reaches ~2 m, got ${maxZ.toFixed(2)}`);
assert.ok(lit > 30, `most motes carry light, got ${lit}`);
console.log(`wind  ok: ${lit}/${pos.length / 3} motes lit, radius <= ${maxR.toFixed(3)} m, reach ${maxZ.toFixed(2)} m`);

// The head stays within the sweep, and returns to face front when switched off.
let maxAngle = 0;
for (let i = 0; i < 400; i++) { unit.update(0.016); maxAngle = Math.max(maxAngle, Math.abs(unit.angle)); }
assert.ok(maxAngle <= THREE.MathUtils.degToRad(46), `sweep bounded, got ${(maxAngle * 180 / Math.PI).toFixed(1)}°`);
console.log(`sweep ok: max ${(maxAngle * 180 / Math.PI).toFixed(1)}° each way`);

unit.apply({ on: false });
// The air fades as the blades slow, rather than snapping off with the switch.
let fade = 0;
while (unit.wind.visible && fade < 6) { unit.update(0.02); fade += 0.02; }
assert.ok(!unit.wind.visible, 'airflow gone once the blades are slow');
assert.ok(fade < 4, `airflow faded out in ${fade.toFixed(2)} s`);
let frames = 0;
while (unit.update(0.05) && frames < 400) frames++;      // coast down
const coast = frames * 0.05;
assert.ok(coast > 1.5 && coast < 6, `coast ${coast.toFixed(2)} s`);
assert.ok(Math.abs(unit.angle) < 0.002, 'head back to front');
console.log(`stop  ok: blades coasted for ${coast.toFixed(2)} s, head recentred`);

/* ----- 5. energy: nothing moves when nothing is on ----- */
const idle = new FanUnit({ ...cfg, state: { on: false } });
assert.equal(idle.update(0.05), false, 'an off fan asks for no frames');
console.log('idle  ok: no redraws when off');

// the store keeps a timer alive, so end the run explicitly
process.exit(0);
