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

/* ----- 9. plans written before `rot` still resolve to the same angle ----- */
assert.equal(cfg.rot, 90, 'west, in an old plan, means +90°');
assert.ok(Math.abs(unit.group.rotation.y - Math.PI / 2) < 1e-9, 'and the model is turned that way');
console.log('compat ok: wall west → rot', cfg.rot);

/* ----- 10. a curtain no longer has to touch a wall ----- */
const free = normalize({
  ...raw,
  curtains: [{ id: 'living.loose', name: 'Loose', room: 'living', pos: [3.1, 2.2], rot: 42, width: 3.4, height: 2.4, top: 2.4 }],
});
const loose = free.curtains[0];
assert.deepEqual(loose.pos, [3.1, 2.2], 'the plan keeps the exact spot');
assert.equal(loose.rot, 42, 'and the angle it was given');
const looseUnit = new CurtainUnit(loose);
assert.equal(looseUnit.group.position.x, 3.1);
assert.equal(looseUnit.group.position.z, 2.2);
assert.ok(Math.abs(looseUnit.group.rotation.y - (42 * Math.PI) / 180) < 1e-9);
assert.throws(() => normalize({ ...raw, curtains: [{ ...raw.curtains[0], rot: 'sideways' }] }), /rot/);
console.log('free  ok: placed at', loose.pos, 'turned', loose.rot + '°');

/* ----- 11. the width can be changed while the home runs ----- */
assert.throws(() => normalize({ ...raw, curtains: [{ ...raw.curtains[0], width: 9 }] }), /between 0.4 and 8/);
looseUnit.hit.geometry.computeBoundingBox();
assert.ok(Math.abs(looseUnit.hit.geometry.boundingBox.max.x - (3.4 + 0.1) / 2) < 1e-6, 'pick box spans 3.4 m');
assert.equal(looseUnit.setWidth(5.2), true);
assert.equal(looseUnit.width, 5.2);
looseUnit.hit.geometry.computeBoundingBox();
assert.ok(Math.abs(looseUnit.hit.geometry.boundingBox.max.x - (5.2 + 0.1) / 2) < 1e-6, 'and 5.2 m after the change');
assert.ok(Math.abs(looseUnit.panels[0].position.x + 2.6) < 1e-6, 'the panels move out with the rod');
assert.equal(looseUnit.setWidth(5.2), false, 'no rebuild when the width is unchanged');
looseUnit.setWidth(99);
assert.equal(looseUnit.width, 8, 'clamped at 8 m');
looseUnit.apply({ width: 2.4, open: 0.8, color: '#b8d8ff', opacity: 0.3 }, { instant: true });
assert.equal(looseUnit.width, 2.4);
assert.ok(Math.abs(looseUnit.panels[1].scale.x - 2.4 / 2 * (0.12 + 0.2 * 0.88)) < 1e-6);
assert.equal('#' + looseUnit.cloth.color.getHexString(), '#b8d8ff', 'colour survives a rebuild');
console.log('width ok: 3.4 → 5.2 → 8 (clamped) → 2.4 m on the state stream');

/* ----- 12. the panel can widen a set while the home runs ----- */
const widthBus = [];
real.on((c) => { if (c.type === 'curtain-width') widthBus.push(c.id); });
assert.equal(real.setCurtainWidth('living.curtain', 3.6), true, 'a new span is accepted');
assert.equal(real.curtainCfg.get('living.curtain').width, 3.6, 'and lands on the plan entry');
assert.deepEqual(widthBus, ['living.curtain'], 'the model is told to rebuild');
assert.equal(real.setCurtainWidth('living.curtain', 3.6), false, 'the same span is a no-op');
assert.equal(real.setCurtainWidth('living.curtain', 99), true);
assert.equal(real.curtainCfg.get('living.curtain').width, 8, 'clamped at 8 m');
assert.equal(real.setCurtainWidth('living.curtain', 0.1), true);
assert.equal(real.curtainCfg.get('living.curtain').width, 0.4, 'clamped at 0.4 m');
assert.equal(real.state.curtains['living.curtain'].open, 0.9, 'width never disturbs the drawn position');
console.log('panel ok: 2.0 → 3.6 → 8 (clamped) → 0.4 m, position untouched');

console.log('\nall curtain checks passed');
process.exit(0);
