import { post, call, isNative } from './bridge.js';

const STORAGE_KEY = 'house-control:state:v1';

export const AC_MODES = ['cool', 'heat', 'dry', 'fan', 'auto'];
export const AC_FANS = ['auto', 'low', 'medium', 'high', 'turbo'];
export const AC_SWINGS = ['swing', 'l1', 'l2', 'l3', 'l4', 'l5', 'off'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function defaultLight(cfg) {
  return { on: false, brightness: 0.8, temp: 3000, color: cfg.color || null };
}

// A fan is either simulated here or driven through a Home Assistant `fan` entity, in the
// same vocabulary a Home Assistant fan speaks: on, percentage 0…100, a preset name, the
// direction it turns and whether it oscillates. `speed` (0…5) stays the one number the
// rotor uses in the 3D view, so a percentage and a step are two views of the same thing.
function defaultFan(cfg) {
  const speed = cfg.speed ?? 2;
  return {
    on: false, speed, percent: speed * 20, oscillate: false,
    preset: cfg.preset ?? null, direction: cfg.direction ?? 'forward',
  };
}

// A curtain is cloth and a rod: how far it is drawn, what colour the cloth is, and how much
// light it lets through. Nothing about it is a device.
function defaultCurtain(cfg) {
  return { open: cfg.open ?? 0.3, color: cfg.color || '#e8e2d6', opacity: cfg.opacity ?? 0.62 };
}

// A robot vacuum: where it is (status, the same words a Home Assistant vacuum uses), how
// full it is, and how hard it scrubs. No `on` — the status says whether it is working.
function defaultVacuum(cfg) {
  return { status: 'docked', battery: cfg.battery ?? 70, speed: cfg.speed || 'standard' };
}

function defaultRack(cfg) {
  return { open: cfg.open ?? 0.15 };
}

export const VACUUM_SPEEDS = ['quiet', 'standard', 'strong', 'max'];
export const VACUUM_SPEED_NAMES = { quiet: 'Quiet', standard: 'Standard', strong: 'Strong', max: 'Max' };

function defaultAC(cfg, outdoor) {
  return {
    on: false, target: 24, mode: 'cool', fan: 'auto', swing: 'swing',
    sleep: false, eco: false, roomTemp: Math.min(outdoor - 2, 27),
    // On but not running right now (a real thermostat says so); never sent to a device.
    idle: false,
  };
}

export function createStore(config) {
  const listeners = new Set();
  const lightCfg = new Map(config.lights.map((l) => [l.id, l]));
  const acCfg = new Map(config.acs.map((a) => [a.id, a]));
  const fanCfg = new Map((config.fans || []).map((f) => [f.id, f]));
  const curtainCfg = new Map((config.curtains || []).map((c) => [c.id, c]));
  const vacuumCfg = new Map((config.vacuums || []).map((v) => [v.id, v]));
  const rackCfg = new Map((config.racks || []).map((r) => [r.id, r]));

  const state = { lights: {}, acs: {}, fans: {}, curtains: {}, racks: {}, vacuums: {}, scene: null };
  for (const l of config.lights) state.lights[l.id] = defaultLight(l);
  for (const f of config.fans || []) state.fans[f.id] = defaultFan(f);
  for (const c of config.curtains || []) state.curtains[c.id] = defaultCurtain(c);
  for (const v of config.vacuums || []) state.vacuums[v.id] = defaultVacuum(v);
  for (const r of config.racks || []) state.racks[r.id] = defaultRack(r);
  for (const a of config.acs) state.acs[a.id] = defaultAC(a, config.outdoorTemp);
  // What each real AC can do, as reported by the native side. A simulated AC can do everything.
  const features = {};
  // What each real fan does, from its Home Assistant entity: percentage step, preset names,
  // whether it can oscillate and reverse. An unlinked fan can do all of it.
  const fanFeatures = {};

  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.home === config.name) {
      for (const [id, s] of Object.entries(saved.lights || {})) if (state.lights[id]) Object.assign(state.lights[id], s);
      for (const [id, s] of Object.entries(saved.acs || {})) if (state.acs[id]) Object.assign(state.acs[id], s);
      for (const [id, s] of Object.entries(saved.fans || {})) if (state.fans[id]) Object.assign(state.fans[id], s);
      for (const [id, s] of Object.entries(saved.curtains || {})) if (state.curtains[id]) Object.assign(state.curtains[id], s);
      for (const [id, s] of Object.entries(saved.vacuums || {})) if (state.vacuums[id]) Object.assign(state.vacuums[id], s);
      for (const [id, s] of Object.entries(saved.racks || {})) if (state.racks[id]) Object.assign(state.racks[id], s);
      for (const [id, f] of Object.entries(saved.features || {})) if (state.acs[id]) features[id] = f;
      for (const [id, f] of Object.entries(saved.fanFeatures || {})) if (state.fans[id]) fanFeatures[id] = f;
      state.scene = saved.scene || null;
      restored = true;
    }
  } catch { /* storage unavailable: start from defaults */ }

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ home: config.name, ...state, features, fanFeatures }));
      } catch { /* ignore */ }
    }, 200);
  }

  function emit(change) {
    for (const fn of listeners) fn(change);
    if (change.type !== 'tick') {
      persist();
      post('summary', summary());
      // The native shell passes this on to its other views of the same home (the panel
      // and the island each run their own store), which adopt it without re-sending.
      if (!change.adopted) post('state', { lights: state.lights, acs: state.acs, fans: state.fans, curtains: state.curtains, racks: state.racks, vacuums: state.vacuums, scene: state.scene, source: change.source ?? store.source ?? null });
    }
  }

  // One command per device is in flight at a time. Whatever changes meanwhile is merged
  // into a single follow-up, so dragging a slider costs a couple of requests (or infrared
  // key presses) instead of dozens. A change the device refuses is rolled back.
  const COOL_DOWN = { light: 300, ac: 900, fan: 500, cover: 700, rack: 700, vacuum: 800 };
  const outbox = new Map();

  const stateOf = (kind, id) => kind === 'light' ? state.lights[id]
    : kind === 'fan' ? state.fans[id]
    : kind === 'cover' ? state.curtains[id]
    : kind === 'vacuum' ? state.vacuums[id]
    : kind === 'rack' ? state.racks[id]
    : state.acs[id];

  function transmit(kind, id, patch) {
    if (!isNative) return Promise.resolve();
    const current = stateOf(kind, id);
    const sent = call('command', { kind, id, patch, state: { ...current } });
    // Never let a lost reply block the device for good.
    return Promise.race([sent, new Promise((resolve) => setTimeout(resolve, 20000))]);
  }

  function dispatch(kind, id, patch, before) {
    const slot = outbox.get(id);
    if (slot) {
      slot.pending = { ...slot.pending, ...patch };
      slot.before = { ...before, ...slot.before }; // the oldest value is the one to return to
      return;
    }
    const entry = { pending: null, before: null };
    outbox.set(id, entry);
    run(kind, id, patch, before, entry);
  }

  function run(kind, id, patch, before, entry) {
    const started = performance.now();
    transmit(kind, id, patch)
      .catch((error) => rollback(kind, id, patch, before, entry, error))
      .then(() => setTimeout(() => {
        if (!entry.pending) { outbox.delete(id); return; }
        const [next, prior] = [entry.pending, entry.before];
        entry.pending = entry.before = null;
        run(kind, id, next, prior, entry);
      }, Math.max(0, COOL_DOWN[kind] - (performance.now() - started))));
  }

  function rollback(kind, id, patch, before, entry, error) {
    const current = stateOf(kind, id);
    let any = false;
    for (const key of error.detail?.failed || Object.keys(patch)) {
      if (!(key in patch)) continue;
      // Changed again in the meantime: that follow-up now falls back to the last good value.
      if (entry.pending && key in entry.pending) { entry.before[key] = before[key]; continue; }
      if (current[key] !== patch[key]) continue; // a real device reported something newer
      current[key] = before[key];
      any = true;
    }
    if (any) emit({ type: kind, id, reverted: true });
    store.onDeviceError?.(id, error.message);
  }

  function sanitizeLight(id, patch) {
    const caps = lightCfg.get(id).capabilities;
    const out = {};
    if ('on' in patch) out.on = Boolean(patch.on);
    if ('brightness' in patch && caps.includes('brightness')) out.brightness = clamp(patch.brightness, 0.05, 1);
    if ('temp' in patch && caps.includes('temp')) { out.temp = clamp(patch.temp, 2200, 6500); out.color = null; }
    if ('color' in patch && caps.includes('color')) out.color = patch.color;
    return out;
  }

  function writeLight(id, patch, { remote = false } = {}) {
    const cur = state.lights[id];
    if (!cur) return false;
    const clean = sanitizeLight(id, patch);
    // Only what actually changed is worth sending to the device.
    const diff = Object.fromEntries(Object.entries(clean).filter(([k, v]) => cur[k] !== v));
    if (!Object.keys(diff).length) return false;
    const before = Object.fromEntries(Object.keys(diff).map((k) => [k, cur[k]]));
    Object.assign(cur, clean);
    if (!remote) dispatch('light', id, diff, before);
    return true;
  }

  function writeAC(id, patch, { remote = false } = {}) {
    const cur = state.acs[id];
    const cfg = acCfg.get(id);
    if (!cur) return false;
    const clean = { ...patch };
    if ('target' in clean) clean.target = clamp(Math.round(clean.target), cfg.min, cfg.max);
    // Switched on here: running until the thermostat says otherwise at the next poll.
    if (!remote && clean.on === true && !cur.on) clean.idle = false;
    const diff = Object.fromEntries(Object.entries(clean).filter(([k, v]) => cur[k] !== v));
    if (!Object.keys(diff).length) return false;
    const before = Object.fromEntries(Object.keys(diff).map((k) => [k, cur[k]]));
    Object.assign(cur, clean);
    const { roomTemp, idle, ...sendable } = diff;
    if (!remote && Object.keys(sendable).length) dispatch('ac', id, sendable, before);
    return true;
  }

  // A fan is not a real device: it is the little 3D one standing in the room, so nothing
  // leaves this WebView. Only the shape of the state is kept clean, like a lamp's.
  function sanitizeFan(patch) {
    const out = {};
    if ('on' in patch) out.on = Boolean(patch.on);
    if ('speed' in patch) out.speed = clamp(Math.round(Number(patch.speed) || 0), 0, 5);
    if ('percent' in patch) out.percent = clamp(Math.round(Number(patch.percent) || 0), 0, 100);
    if ('oscillate' in patch) out.oscillate = Boolean(patch.oscillate);
    if ('direction' in patch) out.direction = patch.direction === 'reverse' ? 'reverse' : 'forward';
    if ('preset' in patch) out.preset = patch.preset == null ? null : String(patch.preset);
    // The step and the percentage follow each other; 0 steps means it is off.
    if ('speed' in out) out.percent = out.speed * 20;
    if ('percent' in out) out.speed = out.percent > 0 ? clamp(Math.round(out.percent / 20), 1, 5) : 0;
    return out;
  }

  // A fan is a real device when it carries a `link` to a Home Assistant `fan` entity; then a
 // change goes out through the native side like an AC's. Otherwise it is only the 3D one.
  function writeFan(id, patch, { remote = false } = {}) {
    const cur = state.fans[id];
    const cfg = fanCfg.get(id);
    if (!cur) return false;
    const clean = sanitizeFan(patch);
    // Switching it on at step 0 switches it on at the first step.
    const step = clean.speed ?? cur.speed;
    if (clean.on === true && step === 0) { clean.speed = 1; clean.percent = 20; }
    const diff = Object.fromEntries(Object.entries(clean).filter(([k, v]) => cur[k] !== v));
    if (!Object.keys(diff).length) return false;
    // A speed change implies it is on; the off step is what turns it off.
    if ((diff.speed > 0 || diff.percent > 0) && diff.on === undefined && !cur.on) diff.on = true;
    const before = Object.fromEntries(Object.keys(diff).map((k) => [k, cur[k]]));
    Object.assign(cur, clean, diff.on === true ? { on: true } : {});
    // A fan with a `link` to a Home Assistant fan entity is a real device; a change goes out
    // through the native side the same way an AC's does.
    if (!remote && cfg.link?.service) dispatch('fan', id, diff, before);
    return true;
  }

  // A vacuum's status is a closed set: anything else falls back to docked.
  const VACUUM_STATUS = ['cleaning', 'paused', 'returning', 'docked', 'error'];
  function sanitizeVacuum(patch) {
    const out = {};
    if ('status' in patch && VACUUM_STATUS.includes(patch.status)) out.status = patch.status;
    if ('battery' in patch) out.battery = clamp(Math.round(Number(patch.battery)), 0, 100);
    if ('speed' in patch && VACUUM_SPEEDS.includes(patch.speed)) out.speed = patch.speed;
    // `locate` is a request, not a state: a counter that only ever goes up, so a second
    // tap is still a change and still reaches the robot.
    if ('locate' in patch) out.locate = Math.round(Number(patch.locate)) || 0;
    return out;
  }

  // A drying rack only has a position, so it needs nothing but 0…1 clamped.
  function sanitizeRack(patch) {
    return 'open' in patch ? { open: clamp(Number(patch.open), 0, 1) } : {};
  }

  function writeRack(id, patch, { remote = false } = {}) {
    const cur = state.racks[id];
    const cfg = rackCfg.get(id);
    if (!cur) return false;
    const clean = sanitizeRack(patch);
    const diff = Object.fromEntries(Object.entries(clean).filter(([k, v]) => cur[k] !== v));
    if (!Object.keys(diff).length) return false;
    const before = Object.fromEntries(Object.keys(diff).map((k) => [k, cur[k]]));
    Object.assign(cur, diff);
    // A rack wired to a Home Assistant cover sends its position; a simulated one just moves.
    if (!remote && cfg.link?.service && 'open' in diff) dispatch('rack', id, { open: diff.open }, before);
    return true;
  }

  function writeVacuum(id, patch, { remote = false } = {}) {
    const cur = state.vacuums[id];
    const cfg = vacuumCfg.get(id);
    if (!cur) return false;
    const clean = sanitizeVacuum(patch);
    const diff = Object.fromEntries(Object.entries(clean).filter(([k, v]) => cur[k] !== v));
    if (!Object.keys(diff).length) return false;
    const before = Object.fromEntries(Object.keys(diff).map((k) => [k, cur[k]]));
    Object.assign(cur, diff);
    // A robot linked to a Home Assistant vacuum acts through the native side; a simulated
    // one just drives around this WebView. Battery is a reading, never sent.
    if (!remote && cfg.link?.service) {
      const out = { ...diff };
      delete out.battery;
      if (Object.keys(out).length) dispatch('vacuum', id, out, before);
    }
    return true;
  }

  // The cloth's shape is kept clean whether the curtain is simulated or a real cover.
  function sanitizeCurtain(patch) {
    const out = {};
    if ('open' in patch) out.open = clamp(Number(patch.open) || 0, 0, 1);
    if ('opacity' in patch) out.opacity = clamp(Number(patch.opacity) || 0, 0.06, 1);
    if ('color' in patch) out.color = /^#[0-9a-f]{6}$/i.test(String(patch.color)) ? String(patch.color).toLowerCase() : null;
    if (out.color === null) delete out.color;
    return out;
  }

  function writeCurtain(id, patch, { remote = false } = {}) {
    const cur = state.curtains[id];
    const cfg = curtainCfg.get(id);
    if (!cur) return false;
    const clean = sanitizeCurtain(patch);
    // Opacity and colour are ours alone: a cover entity knows nothing about them.
    const diff = Object.fromEntries(Object.entries(clean).filter(([k, v]) => cur[k] !== v));
    if (!Object.keys(diff).length) return false;
    const before = Object.fromEntries(Object.keys(diff).map((k) => [k, cur[k]]));
    Object.assign(cur, diff);
    // A curtain linked to a Home Assistant cover sends its position; a simulated one just moves.
    if (!remote && cfg.link?.service && 'open' in diff) dispatch('cover', id, { open: diff.open }, before);
    return true;
  }

  function summary() {
    const lights = Object.values(state.lights);
    const acs = Object.entries(state.acs).filter(([, a]) => a.on);
    return {
      lightsOn: lights.filter((l) => l.on).length,
      lightsTotal: lights.length,
      acOn: acs.length,
      acTarget: acs.length ? acs[0][1].target : null,
      acMode: acs.length ? acs[0][1].mode : null,
    };
  }

  const store = {
    state,
    config,
    restored,
    lightCfg,
    acCfg,
    fanCfg,
    curtainCfg,
    rackCfg,
    vacuumCfg,
    summary,
    /** Set by the UI: called with (device id, message) when a real device refuses a change. */
    onDeviceError: null,
    /** Who is changing things right now when it is not the person at this screen ("ChatGPT"…). */
    source: null,

    /** What the panel may offer for this AC: modes, fan speeds, and the optional extras. */
    acFeatures(id) {
      return features[id] || { modes: AC_MODES, fans: AC_FANS, sleep: true, eco: true, swing: true };
    },
    /** What the panel may offer for this fan: the percentage step, presets, oscillation and reverse. */
    fanFeatures(id) {
      return fanFeatures[id] || { percentageStep: 20, presets: [], oscillate: true, direction: false };
    },

    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    setLight(id, patch) {
      if (writeLight(id, patch)) { state.scene = null; emit({ type: 'light', id }); }
    },
    toggleLight(id) { store.setLight(id, { on: !state.lights[id].on }); },

    setAllLights(on) {
      let any = false;
      for (const id of Object.keys(state.lights)) any = writeLight(id, { on }) || any;
      if (any) { state.scene = null; emit({ type: 'bulk' }); }
    },

    setAC(id, patch) {
      if (writeAC(id, patch)) emit({ type: 'ac', id });
    },

    setFan(id, patch) {
      if (writeFan(id, patch)) emit({ type: 'fan', id });
    },
    toggleFan(id) {
      const fan = state.fans[id];
      if (fan) store.setFan(id, { on: !fan.on });
    },
    setCurtain(id, patch) {
      if (writeCurtain(id, patch)) emit({ type: 'curtain', id });
    },
    /**
     * Changes the span of a curtain's rod. Width belongs to the plan, not to the device state,
     * so nothing is sent to a platform: the model is re-hung and the edit stays local until the
     * plan is saved.
     */
    setCurtainWidth(id, width) {
      const cfg = curtainCfg.get(id);
      const next = Math.min(8, Math.max(0.4, Math.round(Number(width) * 10) / 10));
      if (!cfg || !Number.isFinite(next) || Math.abs(next - cfg.width) < 1e-3) return false;
      cfg.width = next;
      emit({ type: 'curtain-width', id });
      return true;
    },
    setRack(id, patch) {
      if (writeRack(id, patch)) emit({ type: 'rack', id });
    },
    setVacuum(id, patch) {
      if (writeVacuum(id, patch)) emit({ type: 'vacuum', id });
    },
    cleanVacuum(id) { store.setVacuum(id, { status: 'cleaning' }); },
    locateVacuum(id) {
      // Make the robot beep where it is. Simulated robots have nowhere to beep, so the
      // panel only offers this on a linked one.
      const v = state.vacuums[id];
      if (v) store.setVacuum(id, { locate: (v.locate || 0) + 1 });
    },
    dockVacuum(id) { store.setVacuum(id, { status: 'returning' }); },
    setAllCurtains(open) {
      let any = false;
      for (const id of Object.keys(state.curtains)) any = writeCurtain(id, { open }) || any;
      if (any) emit({ type: 'bulk' });
    },
    setAllFans(on) {
      let any = false;
      for (const id of Object.keys(state.fans)) {
        if (on) any = writeFan(id, { on: true, speed: Math.max(1, state.fans[id].speed) }) || any;
        else any = writeFan(id, { on: false }) || any;
      }
      if (any) emit({ type: 'bulk' });
    },

    applyScene(sceneId) {
      const scene = config.scenes.find((s) => s.id === sceneId);
      if (!scene) return;
      for (const id of Object.keys(state.lights)) {
        const patch = { ...(scene.lights['*'] || {}), ...(scene.lights[id] || {}) };
        // A scene that sets a white temperature should not be overridden by a stale colour.
        if (!('color' in patch) && 'temp' in patch) patch.color = null;
        writeLight(id, patch);
      }
      for (const id of Object.keys(state.acs)) {
        const patch = { ...(scene.acs['*'] || {}), ...(scene.acs[id] || {}) };
        if (Object.keys(patch).length) writeAC(id, patch);
      }
      state.scene = sceneId;
      emit({ type: 'bulk', scene: sceneId });
    },

    /** Reports the state again, for a view that has only just started. */
    share() { post('state', { lights: state.lights, acs: state.acs, fans: state.fans, curtains: state.curtains, scene: state.scene }); },

    // The state of another view of this home (see emit). Nothing goes to the devices:
    // the view where the change was made has already sent it.
    adopt(other) {
      let any = false;
      for (const [id, s] of Object.entries(other.lights || {})) any = writeLight(id, s, { remote: true }) || any;
      for (const [id, s] of Object.entries(other.acs || {})) any = writeAC(id, s, { remote: true }) || any;
      for (const [id, s] of Object.entries(other.fans || {})) any = writeFan(id, s, { remote: true }) || any;
      for (const [id, s] of Object.entries(other.curtains || {})) any = writeCurtain(id, s, { remote: true }) || any;
      for (const [id, s] of Object.entries(other.vacuums || {})) any = writeVacuum(id, s, { remote: true }) || any;
      for (const [id, s] of Object.entries(other.racks || {})) any = writeRack(id, s, { remote: true }) || any;
      const scene = other.scene ?? null;
      if (scene !== state.scene) { state.scene = scene; any = true; }
      if (any) emit({ type: 'bulk', remote: true, adopted: true, source: other.source || null });
    },

    // State reported by real devices (native provider). Never echoed back as a command.
    applyRemote(update) {
      let any = false;
      for (const [id, patch] of Object.entries(update.lights || {})) any = writeLight(id, patch, { remote: true }) || any;
      for (const [id, patch] of Object.entries(update.acs || {})) any = writeAC(id, patch, { remote: true }) || any;
      for (const [id, f] of Object.entries(update.fans || {})) any = writeFan(id, f, { remote: true }) || any;
      for (const [id, c] of Object.entries(update.curtains || {})) any = writeCurtain(id, c, { remote: true }) || any;
      for (const [id, v] of Object.entries(update.vacuums || {})) any = writeVacuum(id, v, { remote: true }) || any;
      for (const [id, r] of Object.entries(update.racks || {})) any = writeRack(id, r, { remote: true }) || any;
      for (const [id, f] of Object.entries(update.features || {})) {
        if (state.acs[id] && JSON.stringify(features[id]) !== JSON.stringify(f)) { features[id] = f; any = true; }
        if (state.fans[id] && JSON.stringify(fanFeatures[id]) !== JSON.stringify(f)) { fanFeatures[id] = f; any = true; }
      }
      if (any) emit({ type: 'bulk', remote: true });
    },
  };

  // Without real sensors the room temperature is simulated: it drifts towards the
  // set-point while an AC runs and back towards the outdoor-ish ambient when it is off.
  setInterval(() => {
    let any = false;
    for (const [id, a] of Object.entries(state.acs)) {
      const cfg = acCfg.get(id);
      if (cfg.tuya?.sensorId || cfg.sensor?.id || cfg.link?.id) continue; // a real sensor or unit reports this room
      const ambient = Math.min(config.outdoorTemp - 2, 27);
      const goal = a.on && a.mode !== 'fan' ? a.target : ambient;
      const step = a.on ? 0.2 : 0.1;
      const next = Math.abs(goal - a.roomTemp) <= step ? goal : a.roomTemp + Math.sign(goal - a.roomTemp) * step;
      if (next !== a.roomTemp) { a.roomTemp = Math.round(next * 10) / 10; any = true; }
    }
    // A robot that is not linked to a platform drains while it cleans and charges on its
    // dock. One that is linked reports its own level, so we never guess for it.
    for (const [id, v] of Object.entries(state.vacuums)) {
      if (vacuumCfg.get(id)?.link?.service) continue;
      const next = v.status === 'cleaning' ? Math.max(3, v.battery - 1)
        : v.status === 'docked' ? Math.min(100, v.battery + 1)
        : v.status === 'returning' ? Math.max(3, v.battery - 0.5)
        : v.battery;
      if (next !== v.battery) { v.battery = Math.round(next); any = true; }
    }
    if (any) { for (const fn of listeners) fn({ type: 'tick' }); persist(); }
  }, 3000);

  return store;
}
