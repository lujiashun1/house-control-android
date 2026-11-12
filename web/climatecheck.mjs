// Headless smoke test for the dehumidifier and the humidifier: the plan entry, the store's
// rules, and the model's own motion (rotor, water, mist). No browser.
import fs from 'node:fs';
import assert from 'node:assert/strict';

/* ----- the few browser bits three.js and the app touch on import ----- */
const ctx = { createRadialGradient: () => ({ addColorStop: () => {} }), fillRect: () => {}, set fillStyle(_) {} };
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
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

const { normalize } = await import('./src/config.js');
const { ClimateUnit } = await import('./src/three/climate.js');
const { createStore } = await import('./src/store.js');

const plan = JSON.parse(fs.readFileSync('./public/plans/home.json', 'utf8'));
const raw = { ...plan, climates: [] };   // the shipped units are checked separately below
const unit = (patch = {}) => ({
  id: 'living.dehumidifier', name: 'Living dehumidifier', room: 'living', type: 'dehumidifier',
  pos: [1.2, 1.4], rot: 20, target: 45, mode: 'auto', humidity: 68, tank: 0.5, ...patch,
});

/* ----- 0. the demo plan ships one of each ----- */
const shipped = normalize(plan);
assert.equal(shipped.climates.length, 2, 'the demo home has both units');
assert.deepEqual(shipped.climates.map((c) => c.type).sort(), ['dehumidifier', 'humidifier']);
console.log(`demo  ok: ${shipped.climates.map((c) => c.name).join(' · ')}`);

/* ----- 1. the plan takes both types, with sensible defaults ----- */
const withBoth = normalize({
  ...raw,
  climates: [unit(), unit({ id: 'living.humidifier', type: 'humidifier', target: undefined, mode: undefined, humidity: undefined, tank: undefined })],
});
assert.equal(withBoth.climates.length, 2);
const dryCfg = withBoth.climates[0];
assert.equal(dryCfg.type, 'dehumidifier');
assert.equal(dryCfg.target, 45);
assert.equal(dryCfg.rot, 20);
assert.equal(dryCfg.humidity, 68);
assert.equal(dryCfg.tank, 0.5);
assert.equal(dryCfg.level, withBoth.rooms.find((r) => r.id === 'living').level);
const wetCfg = withBoth.climates[1];
assert.equal(wetCfg.type, 'humidifier');
assert.equal(wetCfg.target, 50, 'a target that is not given is 50 %');
assert.equal(wetCfg.mode, 'auto');
assert.equal(wetCfg.humidity, 58);
assert.equal(wetCfg.tank, 0.65);
console.log(`plan  ok: two units, defaults ${wetCfg.target}% / ${wetCfg.mode}`);

/* ----- 2. normalize refuses a unit that cannot stand there ----- */
assert.throws(() => normalize({ ...raw, climates: [unit({ room: 'nope' })] }), /unknown room/);
assert.throws(() => normalize({ ...raw, climates: [unit({ pos: undefined })] }), /needs "pos"/);
assert.throws(() => normalize({ ...raw, climates: [unit({ type: 'kettle' })] }), /type/);
assert.throws(() => normalize({ ...raw, climates: [unit({ target: 90 })] }), /between 30 and 80/);
console.log('guard ok: room, pos, type and target are checked');

/* ----- 3. the store keeps the state in range and emits one event ----- */
const config = withBoth;
const store = createStore(config);
assert.deepEqual(store.state.climates['living.dehumidifier'], { on: false, target: 45, mode: 'auto', humidity: 68 });
const seen = [];
store.on((c) => { if (c.type === 'climate') seen.push(c.id); });
store.setClimate('living.dehumidifier', { on: true, target: 90 });
assert.equal(store.state.climates['living.dehumidifier'].on, true);
assert.equal(store.state.climates['living.dehumidifier'].target, 80, 'the top of the range is 80 %');
store.setClimate('living.dehumidifier', { target: 12 });
assert.equal(store.state.climates['living.dehumidifier'].target, 30, 'and the bottom is 30 %');
store.setClimate('living.dehumidifier', { mode: 'turbo' });
assert.equal(store.state.climates['living.dehumidifier'].mode, 'auto', 'an unknown mode is ignored');
// An ignored mode changes nothing, so it is not worth an event: two real changes, two events.
assert.deepEqual(seen, ['living.dehumidifier', 'living.dehumidifier']);
store.toggleClimate('living.dehumidifier');
assert.equal(store.state.climates['living.dehumidifier'].on, false, 'the tile button toggles it');
console.log('store ok: clamped 30…80, mode checked, one event per change');

/* ----- 4. the dehumidifier: rotor turns, water climbs, it settles when off ----- */
const dry = new ClimateUnit(dryCfg);
assert.equal(dry.h, 0.58);
assert.equal(dry.hit.userData.kind, 'dehumidifier');
assert.equal(dry.water, 0.5, 'the tank starts where the plan puts it');
dry.apply({ on: true, target: 40, mode: 'auto' }, { instant: true });
assert.equal(dry.level, 1);
const startWater = dry.water;
const startHumidity = dry.humidity;
for (let i = 0; i < 100; i++) dry.update(0.05);
assert.ok(dry.spin > 50, 'the rotor has turned');
assert.ok(dry.water > startWater, 'the tank has collected water');
assert.ok(dry.humidity < startHumidity, 'the room is drying towards 40 %');
assert.ok(dry.motesMesh.visible, 'drops are falling in the window');
assert.ok(dry.airMesh.visible, 'air is blown up out of the grille');
let airLow = Infinity, airHigh = -Infinity;
for (let i = 1; i < dry.airPos.length; i += 3) { airLow = Math.min(airLow, dry.airPos[i]); airHigh = Math.max(airHigh, dry.airPos[i]); }
assert.ok(airLow < 0.7, `the stream starts at the grille (lowest ${airLow.toFixed(2)} m)`);
assert.ok(airHigh > 0.9, `and reaches a metre up (highest ${airHigh.toFixed(2)} m)`);
dry.apply({ on: false }, { instant: false });
for (let i = 0; i < 80; i++) dry.update(0.05);
assert.ok(dry.level <= 0.02, 'the rotor coasts down to a stop');
const spinAtStop = dry.spin;
dry.update(0.05);
assert.ok(Math.abs(dry.spin - spinAtStop) < 1e-9, 'and stays stopped');
console.log(`dry   ok: water ${startWater.toFixed(2)} → ${dry.water.toFixed(2)} · humidity ${startHumidity} → ${dry.humidity.toFixed(1)}`);

/* ----- 5. the humidifier: mist rises, the tank empties, an empty tank stops the mist ----- */
const wet = new ClimateUnit(wetCfg);
assert.equal(wet.h, 0.34);
assert.equal(wet.hit.userData.kind, 'humidifier');
const start = wet.water;
wet.apply({ on: true, target: 65 }, { instant: true });
for (let i = 0; i < 60; i++) wet.update(0.05);
assert.ok(wet.water < start, 'the tank empties as the mist goes out');
assert.ok(wet.motesMesh.visible, 'the plume is drawn while it works');
// The plume must be a column, not one band: motes spread from just above the spout to a metre up.
let low = Infinity, high = -Infinity;
for (let i = 1; i < wet.motePos.length; i += 3) { low = Math.min(low, wet.motePos[i]); high = Math.max(high, wet.motePos[i]); }
assert.ok(low < 0.5, `motes near the spout (lowest ${low.toFixed(2)} m)`);
assert.ok(high > 0.9, `and at the top of the plume (highest ${high.toFixed(2)} m)`);
wet.water = 0.02;
for (let i = 0; i < 120; i++) wet.update(0.05);
assert.equal(wet.water, 0, 'the tank runs dry');
assert.equal(wet.motesMesh.visible, false, 'and the mist stops with it');
assert.equal(wet.on, true, 'the unit itself stays switched on');
wet.apply({ on: false }, { instant: true });
assert.equal(wet.motesMesh.visible, false);
console.log(`wet   ok: tank ${start.toFixed(2)} → 0, mist stops when dry`);

/* ----- 6. off means off, instant ----- */
const idle = new ClimateUnit(dryCfg);
idle.apply({ on: false }, { instant: true });
assert.equal(idle.level, 0);
assert.equal(idle.ledMat.emissiveIntensity, 0);
assert.equal(idle.motesMesh.visible, false);
assert.equal(idle.airMesh.visible, false, 'no air is blown while it is off');
idle.update(1);
assert.equal(idle.spin, 0, 'nothing turns while it is off');
console.log('idle  ok: no rotor, no mist, LED dark');

console.log('\nall climate checks passed');

// The store's debounced persist timer would keep node alive; the checks are done.
process.exit(0);
