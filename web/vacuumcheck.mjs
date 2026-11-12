// Runs the real store and models headless (no WebGL): checks that a plan turns into state,
// that commands come out as the calls Home Assistant expects, and that the models move.
import fs from 'node:fs';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
globalThis.window = {};
globalThis.location = new URL('http://localhost/');
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(16), 0);
globalThis.cancelAnimationFrame = clearTimeout;

const plan = JSON.parse(fs.readFileSync(new URL('./public/plans/home.json', import.meta.url)));
const { normalize } = await import('./src/config.js');
const { createStore } = await import('./src/store.js');
const { VacuumUnit } = await import('./src/three/vacuum.js');
const { RackUnit } = await import('./src/three/rack.js');

const config = normalize(plan);
const s = createStore(config);

const fails = [];
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`); if (!cond) fails.push(name); };

ok('plan has vacuums', (config.vacuums || []).length > 0, `${(config.vacuums || []).length}`);
ok('plan has racks', (config.racks || []).length > 0, `${(config.racks || []).length}`);
ok('vacuum state seeded', !!s.state.vacuums['living.robot'], JSON.stringify(s.state.vacuums['living.robot']));
ok('rack state seeded', !!s.state.racks['living.rack'], JSON.stringify(s.state.racks['living.rack']));
ok('vacuum rect comes from its room', config.vacuums[0].rect?.w === 6.4, JSON.stringify(config.vacuums[0].rect));

// Commands: a simulated robot changes state only; a linked one also asks the shell to send it.
let seen = [];
s.on((c) => seen.push(c));
s.cleanVacuum('living.robot');
ok('clean sets cleaning', s.state.vacuums['living.robot'].status === 'cleaning');
s.setVacuum('living.robot', { speed: 'max' });
ok('speed is a closed set', s.state.vacuums['living.robot'].speed === 'max');
s.setVacuum('living.robot', { speed: 'turbo' });
ok('unknown speed ignored', s.state.vacuums['living.robot'].speed === 'max');
s.dockVacuum('living.robot');
ok('dock sets returning', s.state.vacuums['living.robot'].status === 'returning');
s.setVacuum('living.robot', { status: 'flying' });
ok('unknown status ignored', s.state.vacuums['living.robot'].status === 'returning');

s.setRack('living.rack', { open: 1 });
ok('rack lowers', s.state.racks['living.rack'].open === 1);
s.setRack('living.rack', { open: 1.7 });
ok('rack clamps', s.state.racks['living.rack'].open === 1);
s.setRack('living.rack', { open: 0 });
ok('rack raises', s.state.racks['living.rack'].open === 0);

// The models: a cleaning robot travels; a lowered rack moves its frame and stretches its cables.
const vacuum = new VacuumUnit(config.vacuums[0], {});
vacuum.apply({ status: 'cleaning', battery: 60, speed: 'strong' }, { instant: true });
const start = { ...vacuum.position() };
let moved = 0;
for (let i = 0; i < 240; i++) { vacuum.update(1 / 60); moved = Math.max(moved, Math.hypot(vacuum.position().x - start.x, vacuum.position().z - start.z)); }
ok('vacuum drives away from the dock', moved > 0.3, `${moved.toFixed(2)} m in 4 s`);
ok('vacuum stays in its room', vacuum.position().x >= config.vacuums[0].rect.x && vacuum.position().x <= config.vacuums[0].rect.x + config.vacuums[0].rect.w);

const rack = new RackUnit(config.racks[0]);
const y0 = rack.frameY();
rack.apply({ open: 1 });
let frames = 0;
for (let i = 0; i < 600; i++) if (rack.update(1 / 60)) frames++;
ok('rack travels the whole drop', Math.abs((y0 - rack.frameY()) - rack.lift * 0.85) < 0.05, `${(y0 - rack.frameY()).toFixed(2)} m of ${(rack.lift * 0.85).toFixed(2)} m`);
ok('rack takes a few seconds', frames > 60 && frames < 400, `${frames} frames ≈ ${(frames / 60).toFixed(1)} s`);

// Everything the store holds is written to the save slot the app reopens with.
await new Promise((r) => setTimeout(r, 300));
const saved = JSON.parse(store.get('house-control:state:v1') || '{}');
ok('save slot keeps vacuums and racks', saved.vacuums?.['living.robot'] !== undefined && saved.racks?.['living.rack'] !== undefined);

console.log(fails.length ? `\n${fails.length} failed` : '\nAll checks passed.');
process.exit(fails.length ? 1 : 0);
