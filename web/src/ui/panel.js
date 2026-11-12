// The control panel that lives in the menu bar popover: header, scenes, rooms,
// device tiles and the detail sheets for a light or an AC.
import * as THREE from 'three';
import { h, clamp, createSlider, createColorPad, openMenu } from './dom.js';
import { icon } from './icons.js';
import { lightColor } from '../three/lights.js';
import { MODE_COLORS } from '../three/ac.js';
import { AC_SWINGS, VACUUM_SPEEDS, VACUUM_SPEED_NAMES } from '../store.js';
import { haptic, isPhone } from '../bridge.js';

const MODE_LABEL = { cool: 'Cool', heat: 'Heat', dry: 'Dry', fan: 'Fan', auto: 'Auto' };
const FAN_LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', turbo: 'Turbo' };
const SWING_LABEL = { swing: 'Swing', l1: 'L1', l2: 'L2', l3: 'L3', l4: 'L4', l5: 'L5', off: 'Off' };
const FAN_GREEN = '#4ee79b';
const FAN_SPEED_LABEL = ['Off', 'Quiet', 'Low', 'Medium', 'High', 'Turbo'];
const FAN_GRADIENT = 'linear-gradient(90deg, #1f7a52 0%, #4ee79b 60%, #a7ffd3 100%)';
const SWATCHES = ['#ff5a4f', '#ff9a3c', '#ffd84a', '#5fe08a', '#42d6e8', '#4f8dff', '#8b5cff', '#ff5fc4'];
// Curtain fabrics: linen, off-white, sand, sage, dusty blue, clay, slate, charcoal.
const CLOTH_SWATCHES = ['#e8e2d6', '#f6f3ec', '#cbb9a0', '#a9b3a5', '#8f9bb0', '#b98d7e', '#6f7684', '#3f4654'];
const VACUUM_BLUE = '#63b7ff';
const VACUUM_GRADIENT = 'linear-gradient(90deg, #7a3a2e 0%, #d98a4e 46%, #4ee79b 100%)';
const RACK_GRADIENT = 'linear-gradient(90deg, #2a3038 0%, #8794a4 50%, #eef2f7 100%)';
const CURTAIN_GRADIENT = 'linear-gradient(90deg, #2a3038 0%, #6b6f7a 48%, #efe7d8 100%)';
const SHEER_GRADIENT = 'linear-gradient(90deg, rgba(255,255,255,.12) 0%, rgba(255,255,255,.5) 50%, #ffffff 100%)';

const TEMP_GRADIENT = 'linear-gradient(90deg, #2f7df6 0%, #58b4f5 34%, #f3e2c0 62%, #f6a54a 82%, #f0762c 100%)';
const DIM_GRADIENT = 'linear-gradient(90deg, #4a4f5e 0%, #b9a98c 45%, #ffe2b0 100%)';
const KELVIN_GRADIENT = 'linear-gradient(90deg, #ff9438 0%, #ffbd7a 30%, #ffe2c2 62%, #dfe9ff 100%)';

const NAVY = new THREE.Color('#17274f');
const tmp = new THREE.Color();
const css = (c) => `#${c.getHexString()}`;

function lightStatus(cfg, s) {
  if (!s.on) return 'Off';
  return cfg.capabilities.includes('brightness') ? `${Math.round(s.brightness * 100)}%` : 'On';
}

// 0 when off, otherwise the speed step the blades are at (1-5).
function fanLevel(s) {
  return s.on ? Math.max(1, Math.min(5, s.speed)) : 0;
}

// "35% open · 62% sheer": how much light the cloth lets through is the sheer figure.
function curtainStatus(s) {
  return `${Math.round(s.open * 100)}% open · ${Math.round(s.opacity * 100)}% sheer`;
}

// A percentage the entity's own step can reach (percentage_step 20 → 20, 40, 60, 80, 100).
function snapPercent(value, step) {
  const v = clamp(Math.round(value), 1, 100);
  return Math.max(step, Math.round(v / step) * step);
}

function fanStatus(s) {
  if (!s.on) return 'Off';
  const pct = Math.round(s.percent ?? Math.max(1, s.speed) * 20);
  const preset = s.preset ? `${s.preset} · ` : '';
  return `${preset}${pct}%${s.oscillate ? ' · sweeping' : ''}${s.direction === 'reverse' ? ' · reverse' : ''}`;
}

// "Cleaning · 62%": the status a vacuum reports, and how much charge it has left.
const VACUUM_LABEL = { cleaning: 'Cleaning', paused: 'Paused', returning: 'Returning', docked: 'On dock', error: 'Error' };
function vacuumStatus(s) {
  return `${VACUUM_LABEL[s.status] || 'On dock'} · ${Math.round(s.battery)}%`;
}

function rackStatus(s) {
  const pct = Math.round(s.open * 100);
  return pct <= 2 ? 'Up' : pct >= 98 ? 'Lowered' : `${pct}% down`;
}

function acTemperatureColor(target, cfg) {
  const t = clamp((target - cfg.min) / (cfg.max - cfg.min), 0, 1);
  return tmp.set('#1c4fc0').lerp(new THREE.Color('#8a3d12'), t).clone();
}

export function createPanel(root, config, store, { onFocus, onMenu }) {
  const { state } = store;
  const ui = { room: 'all', sheet: null, level: config.levels[0].id };
  let world = null;
  const roomName = new Map(config.rooms.map((r) => [r.id, r.name]));
  const roomLevel = new Map(config.rooms.map((r) => [r.id, r.level]));
  const multiLevel = config.levels.length > 1;

  /* ---------- skeleton ---------- */

  const canvas = h('canvas', { tabindex: -1 });
  const tooltip = h('div.tooltip');
  const homeSub = h('div.home-sub');
  const power = h('button.round.power', { title: 'Everything on / off', 'aria-label': 'Toggle everything', onclick: toggleEverything }, icon('power', 21, 2.2));
  const gear = h('button.round', { title: 'Settings and floor plans', 'aria-label': 'Settings and floor plans', onclick: () => onMenu(gear) }, icon('settings', 17));
  // Shown while an AI assistant has a link to this home (AI Access on the Mac).
  const aiBadge = h('button.ai-badge', { hidden: true, title: 'An AI assistant has access — click to manage', 'aria-label': 'AI access',
    onclick: () => onMenu(aiBadge, 'agent') }, icon('sparkles', 13, 2.2), h('span', 'AI'));

  const scenes = h('div.scenes');
  const rooms = h('div.rooms');
  const listTitle = h('span.title');
  const grid = h('div.grid');
  const panel = h('section.panel',
    scenes, rooms,
    h('div.list-head', listTitle,
      h('button.pill', { onclick: () => bulk(true) }, 'All on'),
      h('button.pill', { onclick: () => bulk(false) }, 'All off')),
    h('div.devices', grid));
  const sheet = h('section.sheet.hidden');
  sheet.inert = true;
  const toastEl = h('div.panel-toast');

  // A home on several floors: one button per floor under the 3D model, lowest first.
  const floorButtons = new Map();
  const floors = h('div.floors', { role: 'group', 'aria-label': 'Floors', hidden: !multiLevel },
    config.levels.map((l) => {
      const count = h('span.count.zero', '0');
      const b = h('button.floor', { 'aria-label': l.name, onclick: () => { haptic('tick'); showLevel(l.id); } }, h('span', l.name), count);
      floorButtons.set(l.id, { b, count });
      return b;
    }));

  // Back from wherever the camera was moved to; only there while it is somewhere else.
  const viewReset = h('button.view-reset', {
    title: 'Reset view',
    'aria-label': 'Reset view',
    onclick: () => { haptic('tick'); world?.resetView(); },
  }, icon('fit', 15, 2));

  const clip = h('div.card-clip',
    h('div.stage', canvas, floors, viewReset),
    h('div.tint'),
    h('header.top',
      h('div.home', h('div.home-badge', icon('home', 17)),
        h('div', h('div.home-name', config.name), homeSub)),
      aiBadge, gear, power),
    tooltip, panel, sheet, toastEl);
  const card = h('div.card.booting', h('div.notch'), clip);
  root.replaceChildren(card);

  /* ---------- scenes ---------- */

  const sceneButtons = new Map();
  for (const s of config.scenes) {
    const b = h('button.scene', { onclick: () => { haptic('medium'); store.applyScene(s.id); } }, icon(s.icon, 19), s.name);
    sceneButtons.set(s.id, b);
    scenes.append(b);
  }
  if (!config.scenes.length) scenes.style.display = 'none';

  /* ---------- rooms ---------- */

  const roomButtons = new Map();
  for (const r of [{ id: 'all', name: 'All' }, ...config.rooms]) {
    const count = h('span.count.zero', '0');
    const b = h('button.room', { onclick: () => { haptic('tick'); selectRoom(r.id); } }, r.name, count);
    roomButtons.set(r.id, { b, count });
    rooms.append(b);
  }

  function selectRoom(id) {
    if (ui.room === id) id = 'all';
    ui.room = id;
    layoutTiles();
    update();
    roomButtons.get(id).b.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    onFocus(id === 'all' ? null : { kind: 'room', id });
  }

  // The model shows another floor; a room on a different one is let go.
  function showLevel(id) {
    if (ui.room !== 'all' && roomLevel.get(ui.room) !== id) { ui.room = 'all'; layoutTiles(); }
    world?.setLevel(id);
    levelShown(id);
  }

  function levelShown(id) {
    if (ui.level === id) return;
    ui.level = id;
    if (multiLevel && ui.room === 'all') layoutTiles();
    update();
  }

  function inScope(cfg) {
    return ui.room === 'all' || cfg.room === ui.room;
  }

  function bulk(on) {
    haptic('medium');
    if (ui.room === 'all') { store.setAllLights(on); return; }
    for (const l of config.lights) if (l.room === ui.room) store.setLight(l.id, { on });
  }

  function toggleEverything() {
    haptic('heavy');
    const anyOn = Object.values(state.lights).some((l) => l.on) || Object.values(state.acs).some((a) => a.on)
      || Object.values(state.fans || {}).some((f) => f.on);
    if (anyOn) {
      store.setAllLights(false);
      for (const id of Object.keys(state.acs)) store.setAC(id, { on: false });
      store.setAllFans(false);
    } else {
      store.setAllLights(true);
      store.setAllFans(true);
    }
  }

  /* ---------- tiles ---------- */

  const tiles = new Map();

  function lightTile(cfg) {
    const dimmable = cfg.capabilities.includes('brightness');
    const hasSheet = cfg.capabilities.length > 0;
    const sub = h('div.tile-sub');
    // A phone has no room for the button: touching and holding the tile opens the sheet there.
    const more = hasSheet && !isPhone
      ? h('button.tile-more', { 'aria-label': `${cfg.name} settings`, onclick: (e) => { e.stopPropagation(); openSheet({ kind: 'light', id: cfg.id }); } }, icon('sliders', 15))
      : null;
    const el = h(`div.tile${dimmable ? '.dimmable' : ''}`, { role: 'button', tabindex: 0, 'aria-label': cfg.name },
      h('div.bubble', icon(cfg.capabilities.length ? cfg.type : 'plug', 19)),
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      more,
      h('div.tile-level'));

    // Tap toggles; dragging sideways dims (HomeKit-style).
    let gesture = null;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.tile-more') || ev.button !== 0) return;
      el.setPointerCapture(ev.pointerId);
      const s = state.lights[cfg.id];
      gesture = { x: ev.clientX, y: ev.clientY, start: s.on ? s.brightness : 0, moved: false, step: null };
      el.classList.add('pressed');
      if (isPhone && hasSheet) {
        gesture.hold = setTimeout(() => {
          if (!gesture || gesture.moved) return;
          gesture = null;
          el.classList.remove('pressed');
          haptic('medium');
          openSheet({ kind: 'light', id: cfg.id });
        }, 420);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (!gesture) return;
      const dx = ev.clientX - gesture.x;
      if (Math.hypot(dx, ev.clientY - gesture.y) > 8) clearTimeout(gesture.hold);
      // A mostly vertical move is the list being scrolled, not a dim.
      if (!gesture.moved && dimmable && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(ev.clientY - gesture.y)) {
        gesture.moved = true;
        el.classList.add('dragging');
      }
      if (gesture.moved) {
        const b = clamp(gesture.start + dx / el.clientWidth, 0, 1);
        const step = Math.round(b * 20);
        if (step !== gesture.step) { if (gesture.step !== null) haptic('tick'); gesture.step = step; }
        store.setLight(cfg.id, b < 0.04 ? { on: false } : { on: true, brightness: b });
      }
    });
    const finish = (ev) => {
      if (!gesture) return;
      const tapped = !gesture.moved && ev.type === 'pointerup';
      clearTimeout(gesture.hold);
      gesture = null;
      el.classList.remove('pressed', 'dragging');
      if (tapped) toggleLight(cfg.id);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggleLight(cfg.id); }
    });

    return {
      el, cfg, kind: 'light',
      update() {
        const s = state.lights[cfg.id];
        el.classList.toggle('on', s.on);
        el.style.setProperty('--c', css(lightColor(s, tmp)));
        el.style.setProperty('--level', s.on ? String(s.brightness) : '0');
        // On a phone the group heading above the tile already names the room.
        sub.textContent = ui.room === 'all' && !isPhone ? `${lightStatus(cfg, s)} · ${roomName.get(cfg.room)}` : lightStatus(cfg, s);
      },
    };
  }

  function acTile(cfg) {
    const sub = h('div.tile-sub');
    const value = h('div.value');
    const bubble = h('div.bubble');
    const step = (d) => (e) => {
      e.stopPropagation();
      haptic('tick');
      const s = state.acs[cfg.id];
      store.setAC(cfg.id, { on: true, target: s.target + d });
    };
    const el = h('div.tile.ac', { role: 'button', tabindex: 0, 'aria-label': cfg.name, onclick: () => openSheet({ kind: 'ac', id: cfg.id }) },
      bubble,
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      h('div.stepper',
        h('button', { 'aria-label': 'Cooler', onclick: step(-1) }, icon('minus', 15, 2.2)),
        value,
        h('button', { 'aria-label': 'Warmer', onclick: step(1) }, icon('plus', 15, 2.2))),
      h('button.mini-power', { 'aria-label': `${cfg.name} power`, onclick: (e) => { e.stopPropagation(); haptic('medium'); store.setAC(cfg.id, { on: !state.acs[cfg.id].on }); } }, icon('power', 16, 2.2)));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openSheet({ kind: 'ac', id: cfg.id }); });
    let shownMode = null;
    return {
      el, cfg, kind: 'ac',
      update() {
        const s = state.acs[cfg.id];
        el.classList.toggle('on', s.on);
        el.classList.toggle('idle', s.on && s.idle);
        el.style.setProperty('--c', MODE_COLORS[s.mode]);
        if (shownMode !== s.mode) { bubble.replaceChildren(icon(s.mode, 19)); shownMode = s.mode; }
        value.textContent = `${s.target}°`;
        sub.textContent = `${!s.on ? 'Off' : s.idle ? 'Idle' : MODE_LABEL[s.mode]} · Room ${s.roomTemp.toFixed(isPhone ? 0 : 1)}°`;
      },
    };
  }

  function fanTile(cfg) {
    const sub = h('div.tile-sub');
    const value = h('div.value');
    const bubble = h('div.bubble', icon('fan', 19));
    const step = (d) => (e) => {
      e.stopPropagation();
      haptic('tick');
      const f = state.fans[cfg.id];
      const next = clamp(Math.max(1, f.speed) + d, 1, 5);
      store.setFan(cfg.id, { on: true, speed: next });
    };
    const el = h('div.tile.ac.fan', { role: 'button', tabindex: 0, 'aria-label': cfg.name, onclick: () => openSheet({ kind: 'fan', id: cfg.id }) },
      bubble,
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      h('div.stepper',
        h('button', { 'aria-label': 'Slower', onclick: step(-1) }, icon('minus', 15, 2.2)),
        value,
        h('button', { 'aria-label': 'Faster', onclick: step(1) }, icon('plus', 15, 2.2))),
      h('button.mini-power', {
        'aria-label': `${cfg.name} power`, onclick: (e) => { e.stopPropagation(); haptic('medium'); store.toggleFan(cfg.id); },
      }, icon('power', 16, 2.2)));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openSheet({ kind: 'fan', id: cfg.id }); });
    return {
      el, cfg, kind: 'fan',
      update() {
        const f = state.fans[cfg.id];
        const level = fanLevel(f);
        el.classList.toggle('on', f.on);
        el.classList.toggle('sweeping', f.on && f.oscillate);
        el.style.setProperty('--c', FAN_GREEN);
        value.textContent = String(level);
        sub.textContent = ui.room === 'all' && !isPhone
          ? `${fanStatus(f)} · ${roomName.get(cfg.room)}` : fanStatus(f);
      },
    };
  }

  // A drying rack is a cover: the tile shows how far down it hangs, and one tap opens it.
  function rackTile(cfg) {
    const sub = h('div.tile-sub');
    const el = h('div.tile.rack', { role: 'button', tabindex: 0, 'aria-label': cfg.name, onclick: () => openSheet({ kind: 'rack', id: cfg.id }) },
      h('div.bubble', icon('rack', 19)),
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      h('div.tile-level'));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openSheet({ kind: 'rack', id: cfg.id }); });
    return {
      el, cfg, kind: 'rack',
      update() {
        const r = state.racks[cfg.id];
        el.style.setProperty('--c', '#cdd6e2');
        el.style.setProperty('--level', String(Math.max(0.03, r.open)));
        sub.textContent = ui.room === 'all' && !isPhone
          ? `${rackStatus(r)} · ${roomName.get(cfg.room)}` : rackStatus(r);
      },
    };
  }

  // A robot vacuum's tile is its remote: one tap starts or pauses it, the level line under
  // the name is the charge left in it.
  function vacuumTile(cfg) {
    const sub = h('div.tile-sub');
    const el = h('div.tile.vacuum', { role: 'button', tabindex: 0, 'aria-label': cfg.name, onclick: () => openSheet({ kind: 'vacuum', id: cfg.id }) },
      h('div.bubble', icon('bot', 19)),
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      h('div.tile-level'),
      h('button.mini-power', {
        'aria-label': `${cfg.name} start or pause`,
        onclick: (e) => {
          e.stopPropagation();
          haptic('medium');
          const v = state.vacuums[cfg.id];
          if (v.status === 'cleaning') store.setVacuum(cfg.id, { status: 'paused' });
          else store.cleanVacuum(cfg.id);
        },
      }, icon('power', 16, 2.2)));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openSheet({ kind: 'vacuum', id: cfg.id }); });
    return {
      el, cfg, kind: 'vacuum',
      update() {
        const v = state.vacuums[cfg.id];
        el.classList.toggle('on', v.status === 'cleaning');
        el.classList.toggle('low', v.battery <= 20);
        el.style.setProperty('--c', v.status === 'error' ? '#ef5f5f' : VACUUM_BLUE);
        el.style.setProperty('--level', String(Math.max(0.03, v.battery / 100)));
        sub.textContent = ui.room === 'all' && !isPhone
          ? `${vacuumStatus(v)} · ${roomName.get(cfg.room)}` : vacuumStatus(v);
      },
    };
  }

  // A curtain has no power of its own: the tile wears the cloth's colour and shows how far
  // it is drawn, and opening it is what the tap on the cloth does.
  function curtainTile(cfg) {
    const sub = h('div.tile-sub');
    const el = h('div.tile.curtain.on', { role: 'button', tabindex: 0, 'aria-label': cfg.name, onclick: () => openSheet({ kind: 'curtain', id: cfg.id }) },
      h('div.bubble', icon('blinds', 19)),
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      h('div.tile-level'));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openSheet({ kind: 'curtain', id: cfg.id }); });
    return {
      el, cfg, kind: 'curtain',
      update() {
        const c = state.curtains[cfg.id];
        el.style.setProperty('--c', c.color);
        el.style.setProperty('--level', String(c.open));
        sub.textContent = ui.room === 'all' && !isPhone
          ? `${curtainStatus(c)} · ${roomName.get(cfg.room)}` : curtainStatus(c);
      },
    };
  }

  for (const cfg of config.acs) tiles.set(cfg.id, acTile(cfg));
  for (const cfg of config.curtains || []) tiles.set(cfg.id, curtainTile(cfg));
  for (const cfg of config.vacuums || []) tiles.set(cfg.id, vacuumTile(cfg));
  for (const cfg of config.racks || []) tiles.set(cfg.id, rackTile(cfg));
  for (const cfg of config.fans || []) tiles.set(cfg.id, fanTile(cfg));
  for (const cfg of config.lights) tiles.set(cfg.id, lightTile(cfg));

  function toggleLight(id) {
    haptic('light');
    world?.lights.get(id)?.bump();
    store.toggleLight(id);
  }

  function layoutTiles() {
    const nodes = [];
    let i = 0;
    const add = (t) => { t.el.style.setProperty('--i', i++); nodes.push(t.el); };
    // On several floors the one on show comes first, each under its own heading.
    const levels = [...config.levels].sort((a, b) => (b.id === ui.level) - (a.id === ui.level));
    for (const level of levels) {
      const before = nodes.length;
      for (const room of config.rooms) {
        if (room.level !== level.id || (ui.room !== 'all' && room.id !== ui.room)) continue;
        const devices = [...tiles.values()].filter((t) => t.cfg.room === room.id);
        if (!devices.length) continue;
        if (ui.room === 'all') nodes.push(h('div.group-label', room.name));
        devices.filter((t) => t.kind === 'ac').forEach(add);
        devices.filter((t) => t.kind === 'fan').forEach(add);
        devices.filter((t) => t.kind === 'vacuum').forEach(add);
        devices.filter((t) => t.kind === 'rack').forEach(add);
        devices.filter((t) => t.kind === 'curtain').forEach(add);
        devices.filter((t) => t.kind === 'light').forEach(add);
      }
      if (multiLevel && ui.room === 'all' && nodes.length > before) nodes.splice(before, 0, h('div.level-label', level.name));
    }
    if (!nodes.length) nodes.push(h('div.group-label', 'No devices in this room yet'));
    else if (isPhone && config.lights.some((l) => l.capabilities.length && inScope(l))) {
      nodes.push(h('div.grid-hint', 'Touch and hold a light for brightness and colour'));
    }
    grid.replaceChildren(...nodes);
    grid.parentElement.scrollTop = 0;
  }

  /* ---------- sheets ---------- */

  let sheetView = null;

  function openSheet(target) {
    ui.sheet = target;
    sheetView = target.kind === 'ac' ? acSheet(target.id)
      : target.kind === 'fan' ? fanSheet(target.id)
        : target.kind === 'vacuum' ? vacuumSheet(target.id)
          : target.kind === 'rack' ? rackSheet(target.id)
          : target.kind === 'curtain' ? curtainSheet(target.id) : lightSheet(target.id);
    sheet.replaceChildren(...sheetView.nodes);
    panel.classList.add('hidden');
    sheet.classList.remove('hidden');
    panel.inert = true;
    sheet.inert = false;
    card.classList.add('detail');
    hideTooltip();
    onFocus(['ac', 'fan', 'curtain', 'vacuum', 'rack'].includes(target.kind)
      ? target : { kind: 'room', id: store.lightCfg.get(target.id).room });
    update();
  }

  function closeSheet() {
    if (!ui.sheet) return false;
    ui.sheet = null;
    sheetView = null;
    sheet.classList.add('hidden');
    panel.classList.remove('hidden');
    panel.inert = false;
    sheet.inert = true;
    card.classList.remove('detail');
    onFocus(ui.room === 'all' ? null : { kind: 'room', id: ui.room });
    update();
    return true;
  }

  function sheetHead(name, sub, powerBtn) {
    return h('div.sheet-head',
      h('button.round', { 'aria-label': 'Back', onclick: closeSheet }, icon('back', 19, 2.2)),
      h('div.sheet-title', h('div.sheet-name', name), sub),
      powerBtn);
  }

  function bigNumber(unit) {
    const num = h('span.num');
    const el = h('div.big', num, h('small', unit));
    let shown = null;
    return {
      el,
      set(value, off) {
        el.classList.toggle('off', off);
        if (value === shown) return;
        if (shown !== null) {
          num.classList.remove('tick-up', 'tick-down');
          void num.offsetWidth;
          num.classList.add(value > shown ? 'tick-up' : 'tick-down');
        }
        num.textContent = value;
        shown = value;
      },
    };
  }

  function acSheet(id) {
    const cfg = store.acCfg.get(id);
    const s = () => state.acs[id];
    const set = (patch) => store.setAC(id, patch);
    const sub = h('div.sheet-sub');
    const powerBtn = h('button.round.power', { 'aria-label': 'Power', onclick: () => { haptic('medium'); set({ on: !s().on }); } }, icon('power', 21, 2.2));
    const big = bigNumber('°C');
    const eco = h('button.toggle-chip', { onclick: () => { haptic('light'); set({ eco: !s().eco }); } }, icon('leaf', 17), 'Eco Mode', h('span.switch'));
    const slider = createSlider({
      min: cfg.min, max: cfg.max, value: s().target, gradient: TEMP_GRADIENT,
      labels: [`${cfg.min}°`, `${cfg.max}°`],
      onInput: (v) => set({ on: true, target: v }),
    });

    const features = () => store.acFeatures(id);
    const option = (key, label, labels, values, iconName) => {
      const value = h('div.option-value');
      let holder = h('span');
      const el = h('button.option', { onclick: () => {
        el.classList.add('open');
        openMenu(clip, el, values().map((v) => ({
          label: labels[v], selected: s()[key] === v, icon: s()[key] === v ? icon('check', 16, 2.4) : null,
          action: () => { haptic('light'); set(key === 'mode' ? { on: true, mode: v } : { [key]: v }); },
        })), { onClose: () => el.classList.remove('open') });
      } }, holder, h('span.corner', icon('down', 15, 2.2)), h('div.option-label', label), value);
      let shown = null;
      return {
        el,
        update() {
          value.textContent = labels[s()[key]];
          const ic = iconName || s().mode;
          if (shown !== ic) {
            const next = icon(ic, 24, 1.6);
            holder.replaceWith(next);
            holder = next;
            shown = ic;
          }
        },
      };
    };

    const mode = option('mode', 'Mode', MODE_LABEL, () => features().modes, null);
    const fan = option('fan', isPhone ? 'Fan' : 'Fan speed', FAN_LABEL, () => features().fans, 'fan');
    const swing = option('swing', 'Airflow', SWING_LABEL, () => AC_SWINGS, 'wind');
    const sleepValue = h('div.option-value');
    const sleep = h('button.option', { onclick: () => { haptic('light'); set({ sleep: !s().sleep }); } },
      icon('moon', 24, 1.6), h('span.corner.dot'), h('div.option-label', 'Sleep'), sleepValue);
    const options = h('div.options', mode.el, fan.el, sleep, swing.el);

    return {
      nodes: [
        sheetHead(cfg.name, sub, powerBtn),
        h('div.readout', big.el, eco),
        h('div.slider-row',
          h('button.round', { 'aria-label': 'Cooler', onclick: () => { haptic('tick'); set({ on: true, target: s().target - 1 }); } }, icon('minus', 18, 2.2)),
          slider.el,
          h('button.round', { 'aria-label': 'Warmer', onclick: () => { haptic('tick'); set({ on: true, target: s().target + 1 }); } }, icon('plus', 18, 2.2))),
        options,
      ],
      update() {
        const a = s();
        // A real AC only shows the controls it has a function for.
        const f = features();
        const shown = [[mode.el, f.modes.length > 0], [fan.el, f.fans.length > 0], [sleep, f.sleep], [swing.el, f.swing]];
        for (const [el, on] of shown) el.hidden = !on;
        eco.hidden = !f.eco;
        options.style.gridTemplateColumns = `repeat(${shown.filter(([, on]) => on).length || 1}, 1fr)`;
        powerBtn.classList.toggle('on', a.on);
        sub.replaceChildren(icon('thermo', 14), 'Room ', h('b', `${a.roomTemp.toFixed(1)}°C`),
          h('span.live', { style: { background: a.on ? MODE_COLORS[a.mode] : 'rgba(255,255,255,.25)', boxShadow: a.on && !a.idle ? `0 0 8px ${MODE_COLORS[a.mode]}` : 'none' } }));
        big.set(a.target, !a.on);
        slider.set(a.target);
        eco.classList.toggle('on', a.eco);
        mode.update(); fan.update(); swing.update();
        sleep.classList.toggle('active', a.sleep);
        sleepValue.textContent = a.sleep ? 'On' : 'Off';
      },
    };
  }

  // The sheet offers what a Home Assistant `fan` entity offers: a percentage in steps of its
  // own `percentage_step`, its preset names, oscillation and the direction it turns.
  function fanSheet(id) {
    const cfg = store.fanCfg.get(id);
    const s = () => state.fans[id];
    const set = (patch) => store.setFan(id, patch);
    const feat = () => store.fanFeatures(id);
    const sub = h('div.sheet-sub');
    const powerBtn = h('button.round.power', { 'aria-label': 'Power', onclick: () => { haptic('medium'); set({ on: !s().on }); } }, icon('power', 21, 2.2));
    const big = bigNumber('%');
    const step = () => Math.max(1, Math.min(100, Math.round(feat().percentageStep || 20)));
    const slider = createSlider({
      min: 1, max: 100, step: 1, value: Math.max(1, s().percent ?? 20), gradient: FAN_GRADIENT,
      labels: ['1', '100'], detent: step(),
      onInput: (v) => set({ on: true, percent: snapPercent(v, step()) }),
    });
    const osc = h('button.toggle-chip', {
      onclick: () => { haptic('light'); set({ oscillate: !s().oscillate }); },
    }, icon('rotate', 17), 'Oscillate', h('span.switch'));
    const reverse = h('button.toggle-chip', {
      onclick: () => { haptic('light'); set({ direction: s().direction === 'reverse' ? 'forward' : 'reverse' }); },
    }, icon('undo', 17, 2), h('span.dir'), h('span.switch'));
    const presets = h('div.options');
    const noteText = h('span');
    const live = h('span.live');

    return {
      nodes: [
        sheetHead(cfg.name, sub, powerBtn),
        h('div.readout', big.el),
        h('div.slider-row',
          h('button.round', { 'aria-label': 'Slower', onclick: () => { haptic('tick'); set({ on: true, percent: Math.max(step(), snapPercent(s().percent - step(), step())) }); } }, icon('minus', 18, 2.2)),
          slider.el,
          h('button.round', { 'aria-label': 'Faster', onclick: () => { haptic('tick'); set({ on: true, percent: Math.min(100, snapPercent(s().percent + step(), step())) }); } }, icon('plus', 18, 2.2))),
        presets,
        h('div.options', osc, reverse),
        h('div.sheet-note', icon('fan', 20), noteText),
      ],
      update() {
        const f = s();
        powerBtn.classList.toggle('on', f.on);
        sub.replaceChildren(live, h('b', FAN_SPEED_LABEL[fanLevel(f)]));
        live.style.background = f.on ? FAN_GREEN : 'rgba(255,255,255,.25)';
        live.style.boxShadow = f.on ? `0 0 8px ${FAN_GREEN}` : 'none';
        big.set(Math.round(f.percent ?? fanLevel(f) * 20), !f.on);
        slider.set(Math.max(1, Math.round(f.percent ?? 20)));
        osc.classList.toggle('on', f.oscillate);
        osc.classList.toggle('active', f.oscillate);
        const canReverse = feat().direction !== false;
        reverse.classList.toggle('hidden', !canReverse);
        reverse.classList.toggle('on', f.direction === 'reverse');
        reverse.classList.toggle('active', f.direction === 'reverse');
        reverse.querySelector('.dir').textContent = f.direction === 'reverse' ? 'Reverse' : 'Forward';
        const names = feat().presets || [];
        const key = names.join('|');
        if (presets.dataset.key !== key) {
          presets.dataset.key = key;
          presets.replaceChildren(...names.map((name) => h('button.toggle-chip.preset', {
            onclick: () => { haptic('light'); set({ preset: s().preset === name ? null : name }); },
          }, name)));
          presets.classList.toggle('hidden', !names.length);
        }
        for (const chip of presets.children) chip.classList.toggle('active', chip.textContent === f.preset);
        const link = cfg.link?.service
          ? ` · ${cfg.link.service === 'homeassistant' ? 'Home Assistant' : cfg.link.service} ${cfg.link.id}` : '';
        noteText.textContent = `${roomName.get(cfg.room)} · ${Math.round(100 / step())} speed steps, sweeping ${cfg.sweep}°${link}`;
      },
    };
  }

  // A robot vacuum's sheet: start/pause, how hard it scrubs, send it home. The big number is
  // the charge left, because that is what decides whether it can finish the floor.
  function vacuumSheet(id) {
    const cfg = store.vacuumCfg.get(id);
    const s = () => state.vacuums[id];
    const set = (patch) => store.setVacuum(id, patch);
    const sub = h('div.sheet-sub');
    const powerBtn = h('button.round.power', {
      'aria-label': 'Start or pause',
      onclick: () => {
        haptic('medium');
        set({ status: s().status === 'cleaning' ? 'paused' : 'cleaning' });
      },
    }, icon('power', 21, 2.2));
    const big = bigNumber('%');
    const speeds = VACUUM_SPEEDS.map((name) => h('button.toggle-chip.speed', {
      onclick: () => { haptic('light'); set({ speed: name }); },
    }, h('span.speed-name', VACUUM_SPEED_NAMES[name])));
    const dock = h('button.toggle-chip', {
      onclick: () => { haptic('medium'); store.dockVacuum(id); },
    }, icon('homeDock', 17), 'Return to dock', h('span.switch'));
    const locate = h('button.toggle-chip', {
      onclick: () => { haptic('light'); store.locateVacuum(id); },
    }, icon('radar', 17), 'Locate');
    const noteText = h('span');
    const live = h('span.live');

    return {
      nodes: [
        sheetHead(cfg.name, sub, powerBtn),
        h('div.readout', big.el),
        h('div.field-label', h('span', 'Cleaning power')),
        h('div.options', ...speeds),
        h('div.options', dock, locate),
        h('div.sheet-note', icon('bot', 20), noteText),
      ],
      update() {
        const v = s();
        const working = v.status === 'cleaning';
        powerBtn.classList.toggle('on', working);
        sub.replaceChildren(live, h('b', VACUUM_LABEL[v.status] || 'On dock'));
        const ring = v.status === 'error' ? '#ef5f5f' : v.status === 'cleaning' ? '#4ee79b' : VACUUM_BLUE;
        live.style.background = ring;
        live.style.boxShadow = working ? `0 0 8px ${ring}` : 'none';
        big.set(Math.round(v.battery), !working && v.status !== 'returning');
        for (const [i, chip] of speeds.entries()) {
          chip.classList.toggle('active', v.speed === VACUUM_SPEEDS[i]);
          chip.classList.toggle('on', v.speed === VACUUM_SPEEDS[i]);
        }
        dock.classList.toggle('active', v.status === 'returning');
        dock.classList.toggle('hidden', v.status === 'docked');
        // Find-it only exists where the platform has a `locate` service; a simulated robot
        // has nothing to flash, so the chip stays out of the way.
        locate.classList.toggle('hidden', !cfg.link?.service);
        const link = cfg.link?.service
          ? ` · ${cfg.link.service === 'homeassistant' ? 'Home Assistant' : cfg.link.service} ${cfg.link.id}` : ' · simulated';
        noteText.textContent = `${roomName.get(cfg.room)} · ${VACUUM_SPEED_NAMES[v.speed] || 'Standard'}, docked in ${roomName.get(cfg.room)}${link}`;
      },
    };
  }

  // A drying rack is a Home Assistant `cover`: the slider is its position, 0 up, 100 down.
  function rackSheet(id) {
    const cfg = store.rackCfg.get(id);
    const s = () => state.racks[id];
    const set = (open) => store.setRack(id, { open });
    const sub = h('div.sheet-sub');
    const powerBtn = h('button.round.power', {
      'aria-label': 'Lower or raise',
      onclick: () => { haptic('medium'); set(s().open > 0.5 ? 0 : 1); },
    }, icon('rack', 21, 1.8));
    const big = bigNumber('%');
    const slider = createSlider({
      min: 0, max: 100, step: 1, value: Math.round(s().open * 100), gradient: RACK_GRADIENT,
      labels: ['Up', 'Down'], detent: 5,
      onInput: (v) => set(v / 100),
    });
    const up = h('button.toggle-chip', { onclick: () => { haptic('light'); set(0); } }, icon('undo', 17, 2), 'Raise');
    const down = h('button.toggle-chip', { onclick: () => { haptic('light'); set(1); } }, icon('rotate', 17), 'Lower');
    const noteText = h('span');
    const live = h('span.live');

    return {
      nodes: [
        sheetHead(cfg.name, sub, powerBtn),
        h('div.readout', big.el),
        h('div.slider-row', slider.el),
        h('div.options', up, down),
        h('div.sheet-note', icon('rack', 20), noteText),
      ],
      update() {
        const r = s();
        sub.replaceChildren(live, h('b', rackStatus(r)));
        live.style.background = r.open > 0.02 ? '#63b7ff' : 'rgba(255,255,255,.25)';
        live.style.boxShadow = r.open > 0.02 ? '0 0 8px #63b7ff' : 'none';
        big.set(Math.round(r.open * 100));
        slider.set(Math.round(r.open * 100));
        powerBtn.classList.toggle('on', r.open > 0.02);
        up.classList.toggle('active', r.open <= 0.02);
        down.classList.toggle('active', r.open >= 0.98);
        const link = cfg.link?.service
          ? ` · ${cfg.link.service === 'homeassistant' ? 'Home Assistant' : cfg.link.service} ${cfg.link.id}` : ' · simulated';
        noteText.textContent = `${roomName.get(cfg.room)} · ${(cfg.width ?? 1.6).toFixed(2)} m wide, drops ${(cfg.lift ?? 1.3).toFixed(2)} m${link}`;
      },
    };
  }

  function curtainSheet(id) {
    const cfg = store.curtainCfg.get(id);
    const s = () => state.curtains[id];
    const set = (patch) => store.setCurtain(id, patch);
    const sub = h('div.sheet-sub');
    const big = bigNumber('%');
    const open = createSlider({
      min: 0, max: 100, step: 1, value: Math.round(s().open * 100), gradient: CURTAIN_GRADIENT,
      labels: ['Closed', 'Open'], detent: 5,
      onInput: (v) => set({ open: v / 100 }),
    });
    const sheerValue = h('span');
    const sheer = createSlider({
      min: 10, max: 100, step: 1, value: Math.round(s().opacity * 100), gradient: SHEER_GRADIENT,
      compact: true, detent: 5,
      onInput: (v) => set({ opacity: v / 100 }),
    });
    const colorLabel = h('span');
    const pad = createColorPad({ value: s().color, onInput: (c) => set({ color: c }) });
    const swatches = CLOTH_SWATCHES.map((c) => h('button.swatch', {
      'aria-label': `Fabric ${c}`, vars: { '--sw': c }, onclick: () => { haptic('light'); set({ color: c }); },
    }));
    const live = h('span.live');
    const noteText = h('span');

    return {
      nodes: [
        sheetHead(cfg.name, sub, null),
        h('div.readout', big.el),
        h('div.slider-row',
          h('button.round', { 'aria-label': 'Close a little', onclick: () => { haptic('tick'); set({ open: Math.max(0, s().open - 0.1) }); } }, icon('minus', 18, 2.2)),
          open.el,
          h('button.round', { 'aria-label': 'Open a little', onclick: () => { haptic('tick'); set({ open: Math.min(1, s().open + 0.1) }); } }, icon('plus', 18, 2.2))),
        h('div.field-label', h('span', 'Sheer'), sheerValue),
        h('div.slider-row', sheer.el),
        h('div.field-label', h('span', 'Fabric colour'), colorLabel),
        pad.el,
        h('div.swatches', swatches),
        h('div.sheet-note', icon('blinds', 20), noteText),
      ],
      update() {
        const c = s();
        sub.replaceChildren(live, h('b', `${Math.round(c.open * 100)}% open`));
        live.style.background = c.color;
        live.style.boxShadow = `0 0 8px ${c.color}`;
        big.set(Math.round(c.open * 100), false);
        open.set(Math.round(c.open * 100));
        sheer.set(Math.round(c.opacity * 100));
        sheerValue.textContent = `${Math.round(c.opacity * 100)}%`;
        colorLabel.textContent = c.color.toUpperCase();
        swatches.forEach((el, i) => el.classList.toggle('selected', c.color.toLowerCase() === CLOTH_SWATCHES[i]));
        pad.set(c.color);
        // A linked curtain follows a Home Assistant `cover`: say which one, and say when it is not.
        noteText.textContent = cfg.link
          ? `${roomName.get(cfg.room)} · ${cfg.link.service} ${cfg.link.id} · position only, colour and sheer are yours`
          : `${roomName.get(cfg.room)} · simulated: no platform, nothing is sent`;
      },
    };
  }

  function lightSheet(id) {
    const cfg = store.lightCfg.get(id);
    const s = () => state.lights[id];
    const set = (patch) => store.setLight(id, patch);
    const caps = cfg.capabilities;
    const sub = h('div.sheet-sub');
    const powerBtn = h('button.round.power', { 'aria-label': 'Power', onclick: () => toggleLight(id) }, icon('power', 21, 2.2));
    const big = bigNumber('%');
    const nodes = [sheetHead(cfg.name, sub, powerBtn), h('div.readout', big.el)];
    const sliders = {};

    if (caps.includes('brightness')) {
      sliders.brightness = createSlider({
        min: 5, max: 100, value: Math.round(s().brightness * 100), gradient: DIM_GRADIENT, detent: 5,
        onInput: (v) => set({ on: true, brightness: v / 100 }),
      });
      nodes.push(h('div.slider-row',
        h('button.round', { 'aria-label': 'Dimmer', onclick: () => { haptic('tick'); set({ on: true, brightness: s().brightness - 0.1 }); } }, icon('dim', 18)),
        sliders.brightness.el,
        h('button.round', { 'aria-label': 'Brighter', onclick: () => { haptic('tick'); set({ on: true, brightness: s().brightness + 0.1 }); } }, icon('bright', 18))));
    }
    let kelvinLabel = null;
    if (caps.includes('temp')) {
      kelvinLabel = h('span');
      sliders.temp = createSlider({
        min: 2200, max: 6500, step: 100, value: s().temp, gradient: KELVIN_GRADIENT, compact: true, detent: 500,
        onInput: (v) => set({ on: true, temp: v }),
      });
      nodes.push(h('div.field-label', h('span', 'Colour temperature'), kelvinLabel), h('div.slider-row', sliders.temp.el));
    }
    let swatches = [];
    let pad = null;
    let colorLabel = null;
    if (caps.includes('color')) {
      colorLabel = h('span');
      pad = createColorPad({ value: s().color, onInput: (c) => set({ on: true, color: c }) });
      swatches = SWATCHES.map((c) => h('button.swatch', { 'aria-label': `Colour ${c}`, vars: { '--sw': c }, onclick: () => { haptic('light'); set({ on: true, color: c }); } }));
      nodes.push(h('div.field-label', h('span', 'Colour'), colorLabel), pad.el, h('div.swatches', swatches));
    } else {
      nodes.push(h('div.sheet-note', icon(cfg.type, 20),
        `${roomName.get(cfg.room)} · drag across a light tile to dim it, or ${isPhone ? 'tap' : 'click'} the lamp in the 3D view to toggle.`));
    }

    return {
      nodes,
      update() {
        const l = s();
        powerBtn.classList.toggle('on', l.on);
        sub.replaceChildren(roomName.get(cfg.room), ' · ', h('b', l.on ? 'On' : 'Off'));
        big.set(caps.includes('brightness') ? Math.round(l.brightness * 100) : l.on ? 100 : 0, !l.on);
        sliders.brightness?.set(Math.round(l.brightness * 100));
        sliders.temp?.set(l.temp);
        if (kelvinLabel) kelvinLabel.textContent = l.color ? '—' : `${l.temp} K`;
        swatches.forEach((el, i) => el.classList.toggle('selected', l.color?.toLowerCase() === SWATCHES[i]));
        pad?.set(l.color);
        if (colorLabel) colorLabel.textContent = l.color ? l.color.toUpperCase() : 'White';
      },
    };
  }

  /* ---------- tooltip ---------- */

  function hideTooltip() { tooltip.classList.remove('show'); }

  function showTooltip(hit) {
    if (!hit) { hideTooltip(); return; }
    let name;
    let status;
    let on;
    let color;
    if (hit.kind === 'light') {
      const cfg = store.lightCfg.get(hit.id);
      const s = state.lights[hit.id];
      name = cfg.name; status = lightStatus(cfg, s); on = s.on; color = css(lightColor(s, tmp));
    } else if (hit.kind === 'curtain') {
      const cfg = store.curtainCfg.get(hit.id);
      const s = state.curtains[hit.id];
      name = cfg.name; status = curtainStatus(s); on = true; color = s.color;
    } else if (hit.kind === 'fan') {
      const cfg = store.fanCfg.get(hit.id);
      const s = state.fans[hit.id];
      name = cfg.name; status = fanStatus(s); on = s.on; color = FAN_GREEN;
    } else if (hit.kind === 'rack') {
      const cfg = store.rackCfg.get(hit.id);
      const s = state.racks[hit.id];
      name = cfg.name; status = rackStatus(s); on = s.open > 0.02; color = '#cdd6e2';
    } else if (hit.kind === 'vacuum') {
      const cfg = store.vacuumCfg.get(hit.id);
      const s = state.vacuums[hit.id];
      name = cfg.name; status = vacuumStatus(s); on = s.status === 'cleaning'; color = VACUUM_BLUE;
    } else {
      const cfg = store.acCfg.get(hit.id);
      const s = state.acs[hit.id];
      name = cfg.name; status = s.on ? `${s.idle ? 'Idle' : MODE_LABEL[s.mode]} ${s.target}°` : 'Off'; on = s.on && !s.idle; color = MODE_COLORS[s.mode];
    }
    tooltip.replaceChildren(h('i.dot'), name, h('span', status));
    tooltip.classList.toggle('on', on);
    tooltip.style.setProperty('--dot', color);
    tooltip.style.left = `${clamp(hit.x, 70, card.clientWidth - 70)}px`;
    tooltip.style.top = `${Math.max(64, hit.y)}px`;
    tooltip.classList.add('show');
  }

  /* ---------- derived state ---------- */

  function mood() {
    // A curtain's sheet is lit in the colour of the cloth on it.
    if (ui.sheet?.kind === 'curtain') {
      const c = state.curtains[ui.sheet.id];
      return new THREE.Color(c.color).multiplyScalar(0.10 + 0.10 * c.open);
    }
    // A robot vacuum's sheet is lit by how much charge it has left.
    if (ui.sheet?.kind === 'vacuum') {
      const v = state.vacuums[ui.sheet.id];
      return new THREE.Color(v.status === 'error' ? '#ef5f5f' : VACUUM_BLUE).multiplyScalar(0.10 + 0.06 * (v.battery / 100));
    }
    // A fan's sheet is lit in the colour of its own airflow.
    if (ui.sheet?.kind === 'fan') {
      const f = state.fans[ui.sheet.id];
      if (!f.on) return NAVY.clone().multiplyScalar(0.8);
      return new THREE.Color(FAN_GREEN).multiplyScalar(0.12 + 0.05 * Math.max(1, f.speed));
    }
    if (ui.sheet?.kind === 'ac') {
      const a = state.acs[ui.sheet.id];
      if (!a.on) return NAVY.clone().multiplyScalar(0.8);
      if (a.mode === 'cool' || a.mode === 'heat' || a.mode === 'auto') return acTemperatureColor(a.target, store.acCfg.get(ui.sheet.id));
      return new THREE.Color(MODE_COLORS[a.mode]).multiplyScalar(0.38);
    }
    const sum = new THREE.Color(0, 0, 0);
    let weight = 0;
    for (const cfg of config.lights) {
      const s = state.lights[cfg.id];
      if (!s.on) continue;
      const w = cfg.capabilities.includes('brightness') ? s.brightness : 1;
      lightColor(s, tmp);
      sum.r += tmp.r * w; sum.g += tmp.g * w; sum.b += tmp.b * w;
      weight += w;
    }
    if (!weight) return NAVY.clone();
    sum.multiplyScalar(0.42 / weight);
    return NAVY.clone().lerp(sum, clamp(weight / 3.5, 0.25, 0.8));
  }

  function update() {
    const lights = Object.values(state.lights);
    const onCount = lights.filter((l) => l.on).length;
    const acsOn = Object.values(state.acs).filter((a) => a.on);
    const anyOn = onCount > 0 || acsOn.length > 0;

    homeSub.replaceChildren(
      h('span.live', { style: anyOn ? {} : { background: 'rgba(255,255,255,.25)', boxShadow: 'none' } }),
      h('b', onCount ? `${onCount} of ${lights.length}` : 'No'), ' lights on',
      acsOn.length ? ` · AC ${acsOn[0].target}°` : '',
      Object.values(state.fans || {}).some((f) => f.on) ? ' · Fan on' : '');
    power.classList.toggle('on', anyOn);

    for (const [id, b] of sceneButtons) b.classList.toggle('active', state.scene === id);

    for (const [id, { b, count }] of roomButtons) {
      b.classList.toggle('active', ui.room === id);
      const n = config.lights.filter((l) => (id === 'all' || l.room === id) && state.lights[l.id].on).length;
      count.textContent = n;
      count.classList.toggle('zero', n === 0 || id === 'all');
    }
    for (const [id, { b, count }] of floorButtons) {
      b.classList.toggle('active', ui.level === id);
      b.setAttribute('aria-pressed', String(ui.level === id));
      const n = config.lights.filter((l) => l.level === id && state.lights[l.id].on).length;
      count.textContent = n;
      count.classList.toggle('zero', n === 0);
    }

    const scoped = config.lights.filter(inScope);
    const scopedOn = scoped.filter((l) => state.lights[l.id].on).length;
    listTitle.replaceChildren(h('b', ui.room === 'all' ? 'Whole home' : roomName.get(ui.room)), ` · ${scopedOn} of ${scoped.length} on`);

    for (const t of tiles.values()) t.update();
    sheetView?.update();
    const m = css(mood());
    card.style.setProperty('--mood', m);
  }

  store.on(() => update());
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !closeSheet()) onMenu(null, 'escape');
  });

  layoutTiles();
  update();

  return {
    canvas,
    card,
    attach(w) { world = w; card.classList.remove('booting'); levelShown(w.level); },
    /** The model went to another floor by itself (a room or a device on it was picked). */
    levelShown,
    viewMoved(moved) { viewReset.classList.toggle('show', moved); },
    showTooltip,
    openSheet,
    closeSheet,
    selectRoom,
    toggleLight,
    get room() { return ui.room; },
    setNotch(x) { card.style.setProperty('--notch-x', `${x}px`); },
    setAgentLive(live) { aiBadge.hidden = !live; },
    /** `ai`: something an AI assistant did (who, what), instead of an error. */
    toast(text, ai = null) {
      toastEl.replaceChildren(...(ai ? [h('span.toast-ai', icon('sparkles', 13, 2.2), ai), h('span', text)] : [text]));
      toastEl.classList.toggle('ai', Boolean(ai));
      toastEl.classList.add('show');
      clearTimeout(toastEl.timer);
      toastEl.timer = setTimeout(() => toastEl.classList.remove('show'), 3200);
    },
    anchorMenu: clip,
  };
}
