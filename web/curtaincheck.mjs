// Headless smoke test: the curtain model and the store, with no browser.
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
const { CurtainUnit } = await import('./src/three/curtain.js');
const { createStore } = await import('./src/store.js');

/* ----- 1. the plan's curtain survives normalize ----- */
const raw = JSON.parse(fs.readFileSync('./public/plans/home.json', 'utf8'));
const config = normalize(raw);
assert.equal(config.curtains.length, 1, 'one curtain in the demo plan');
const cfg = config.curtains[0];
assert.equal(cfg.id, 'living.curtain');
assert.equal(cfg.wall, 'west');
assert.equal(cfg.width, 1.3);
assert.equal(cfg.top, 2.35);
assert.equal(cfg.level, config.rooms.find((r) => r.id === 'living').level);
console.log('plan  ok:', cfg.id, 'wall', cfg.wall, 'width', cfg.width, 'top', cfg.top);

/* ----- 2. normalize refuses a curtain that cannot hang there ----- */
assert.throws(() => normalize({ ...raw, curtains: [{ id: 'x.c', room: 'nope', wall: 'west', pos: [0, 0] }] }), /unknown room/);
assert.throws(() => normalize({ ...raw, curtains: [{ id: 'x.c', room: 'living', wall: 'west' }] }), /needs "pos"/);
assert.throws(() => normalize({ ...raw, curtains: [{ id: 'x.c', room: 'living', wall: 'up', pos: [0, 0] }] }), /wall/);
assert.throws(() => normalize({ ...raw, curtains: [{ id: 'x.c', room: 'living', wall: 'west', pos: [0, 0], width: 0.1 }] }), /width/);
assert.throws(() => normalize({ ...raw, curtains: [{ id: 'living', room: 'living', wall: 'west', pos: [0, 0] }] }), /Duplicate id/);
console.log('guard ok: unknown room, missing pos, bad wall, narrow width, duplicate id');

/* ----- 3. the geometry: two panels, one shared pleated face ----- */
const unit = new CurtainUnit(cfg);
assert.equal(unit.panels.length, 2, 'two panels');
assert.equal(unit.panels[0].geometry, unit.panels[1].geometry, 'panels share one geometry');
const g = unit.panels[0].geometry;
assert.ok(g.attributes.position.count > 400, 'pleated grid is dense enough to bend light');
const tris = g.index.count / 3;
console.log('model ok: two panels,', g.attributes.position.count, 'vertices,', tris, 'triangles each');

/* ----- 4. open gathers the cloth to the sides; the hit box covers the set ---------- */
const spanOf = (open) => {
  unit.open = unit.openGoal = open;
  unit.layout();
  return unit.panels[0].scale.x;
};
const closed = spanOf(0);
const half = spanOf(0.5);
const wide = spanOf(1);
assert.ok(closed > half && half > wide, 'opening narrows the panel');
assert.ok(Math.abs(closed - cfg.width / 2) < 1e-6, 'closed panel is half the set');
assert.ok(Math.abs(wide - cfg.width / 2 * 0.12) < 0.02, 'fully open leaves a twelfth of it');
console.log('open  ok: span closed', closed.toFixed(3), 'm → open', wide.toFixed(3), 'm');

/* ----- 5. colour and sheerness land on the material ----- */
unit.apply({ open: 0.6, opacity: 0.25, color: '#8f9bb0' }, { instant: true });
assert.equal(unit.open, 0.6);
assert.equal(unit.opacity, 0.25);
assert.equal('#' + unit.panels[0].material.color.getHexString(), '#8f9bb0');
assert.equal(unit.cloth.transparent, true, 'cloth draws blended');
assert.equal(unit.cloth.depthWrite, false, 'cloth never writes depth');
assert.equal(unit.panels[0].castShadow, false, 'cloth casts no solid shadow');
assert.equal(unit.panels[1].rotation.y, Math.PI, 'right panel is turned round, never mirrored');
console.log('sheer ok: opacity', unit.cloth.opacity, 'colour', '#' + unit.cloth.color.getHexString());

/* ----- 6. it eases into a new state, then settles instead of redrawing forever ----- */
unit.apply({ open: 1, opacity: 0.9 }, { instant: false });
let frames = 0;
while (unit.update(1 / 60) && frames < 600) frames += 1;
assert.ok(frames > 6 && frames < 90, 'the cloth eases over in about a second, not instantly');
assert.equal(unit.update(1 / 60), false, 'at rest nothing redraws');
console.log('rest  ok: settled in', frames, 'frames (' + (frames / 60).toFixed(2) + ' s)');

/* ----- 7. the store keeps a curtain local, and clamps what it is given ----- */
globalThis.localStorage.map.set('house-control:state:v1', JSON.stringify({ home: 'Home', curtains: { 'living.curtain': { open: 0.8, color: '#3f4654', opacity: 0.4 } } }));
const store = createStore(config);
assert.equal(store.state.curtains['living.curtain'].open, 0.8, 'restored from storage');
store.setCurtain('living.curtain', { open: 1.7 });
assert.equal(store.state.curtains['living.curtain'].open, 1, 'open clamped to 1');
store.setCurtain('living.curtain', { opacity: 0 });
assert.ok(store.state.curtains['living.curtain'].opacity >= 0.06, 'opacity floor keeps the cloth visible');
store.setCurtain('living.curtain', { color: 'red' });
assert.equal(store.state.curtains['living.curtain'].color, '#3f4654', 'a colour must be #rrggbb');
store.setCurtain('living.curtain', { color: '#B98D7E' });
assert.equal(store.state.curtains['living.curtain'].color, '#b98d7e', 'colour is stored lower-case');
assert.equal(store.curtainCfg.get('living.curtain').wall, 'west', 'the plan keeps the wall');
console.log('store ok: clamped, colour masked, wall kept');

/* ----- 8. a curtain linked to a platform keeps the link; its position comes back ----- */
const linked = { ...config, curtains: [{ ...config.curtains[0], link: { service: 'homeassistant', id: 'cover.living' } }] };
const real = createStore(linked);
assert.equal(real.curtainCfg.get('living.curtain').link.id, 'cover.living', 'the plan keeps the cover link');
real.applyRemote({ curtains: { 'living.curtain': { open: 0.42 } } });
assert.equal(real.state.curtains['living.curtain'].open, 0.42, 'a cover position lands as 0…1');
real.setCurtain('living.curtain', { open: 0.9, opacity: 0.3 });
assert.equal(real.state.curtains['living.curtain'].open, 0.9, 'a local move still applies at once');
assert.equal(real.state.curtains['living.curtain'].opacity, 0.3, 'sheer stays ours, never sent');
console.log('cover ok: link kept, position both ways, sheer local only');

console.log('\nall curtain checks passed');
process.exit(0);
