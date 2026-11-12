// Loads and normalises a floor plan ("home.json"). Everything the 3D scene and the UI
// know about the apartment comes from this one document, so swapping the file swaps the home.

const LIGHT_TYPES = ['ceiling', 'pendant', 'spots', 'floor', 'table', 'strip'];
const WALLS = ['north', 'south', 'east', 'west'];
// The two air treatment units share one plan list; `type` says which one it is.
export const CLIMATE_TYPES = ['dehumidifier', 'humidifier'];
export const CLIMATE_MODES = ['auto', 'continuous', 'sleep'];

export class ConfigError extends Error {}

export const LIGHT_KINDS = LIGHT_TYPES;

// A lamp or an AC is real when it is linked to a device of a connected platform:
// `link: { service, id }` (Home Assistant, Philips Hue, Apple Home) or, for Smart Life,
// `tuya: { deviceId }`. An AC's `sensor: { service, id }` is a thermometer for its room.
export const LINK_FIELDS = ['tuya', 'link', 'sensor'];

export function linkOf(d) {
  if (d?.link?.service && d.link.id) return { service: d.link.service, id: d.link.id };
  if (d?.tuya?.deviceId) return { service: 'smartlife', id: d.tuya.deviceId };
  return null;
}

export const isLinked = (d) => Boolean(linkOf(d));

/** The platforms House Control can link to, in the order the editor lists them. */
export const SERVICES = {
  smartlife: { name: 'Smart Life', short: 'Smart Life' },
  homeassistant: { name: 'Home Assistant', short: 'Home Assistant' },
  hue: { name: 'Philips Hue', short: 'Hue' },
  homekit: { name: 'Apple Home', short: 'Apple Home' },
};
export const FLOOR_KINDS = ['oak', 'walnut', 'tile', 'stone'];

// A home on several floors lists them in "levels", lowest first: [{ id, name, wallHeight? }].
// Rooms, furniture and openings say which one they are on with "level"; lamps and ACs are on
// their room's. Without "levels" (or without "level" on an item) everything is on the first.
export const SLAB = 0.3; // thickness of the floor between two levels, metres

export function levelsOf(raw) {
  const list = Array.isArray(raw?.levels) ? raw.levels.filter((l) => l && typeof l.id === 'string' && l.id) : [];
  return list.length ? list : [{ id: 'main', name: 'Ground floor' }];
}

// The plan exactly as written on disk (the editor works on this form).
export async function loadRawConfig() {
  const boot = window.__HOUSE_BOOT__;
  if (boot?.config) return boot.config;
  const plan = (boot?.plan !== 'custom' && boot?.plan) || new URLSearchParams(location.search).get('plan') || 'home';
  const res = await fetch(`./plans/${plan}.json`);
  if (!res.ok) throw new ConfigError(`Plan "${plan}" not found (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch (e) {
    throw new ConfigError(`Plan "${plan}" is not valid JSON: ${e.message}`);
  }
}

export async function loadConfig() {
  return normalize(await loadRawConfig());
}

function need(cond, msg) {
  if (!cond) throw new ConfigError(msg);
}

const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

export function normalize(raw) {
  need(raw && typeof raw === 'object', 'Plan must be a JSON object');
  need(Array.isArray(raw.rooms) && raw.rooms.length > 0, 'Plan needs at least one room in "rooms"');

  const ids = new Set();
  const unique = (id, what) => {
    need(typeof id === 'string' && id, `${what} is missing an "id"`);
    need(!ids.has(id), `Duplicate id "${id}"`);
    ids.add(id);
  };

  const wallHeight = raw.wallHeight ?? 2.6;
  const levelIds = new Set();
  let elevation = 0;
  const levels = levelsOf(raw).map((l) => {
    need(!levelIds.has(l.id), `Duplicate floor id "${l.id}"`);
    levelIds.add(l.id);
    const H = Number.isFinite(l.wallHeight) && l.wallHeight > 0 ? l.wallHeight : wallHeight;
    const level = { id: l.id, name: l.name || l.id, wallHeight: H, elevation };
    elevation += H + SLAB;
    return level;
  });
  const ground = levels[0].id;
  const levelOf = (item, what) => {
    if (item.level == null) return ground;
    need(levelIds.has(item.level), `${what} is on unknown floor "${item.level}"`);
    return item.level;
  };

  const rooms = raw.rooms.map((r) => {
    unique(r.id, 'A room');
    need(Array.isArray(r.rect) && r.rect.length === 4 && r.rect.every(Number.isFinite),
      `Room "${r.id}" needs "rect": [x, z, width, depth]`);
    const [x, z, w, d] = r.rect;
    need(w > 0 && d > 0, `Room "${r.id}" has an empty rect`);
    return { id: r.id, name: r.name || r.id, x, z, w, d, floor: r.floor || 'oak', level: levelOf(r, `Room "${r.id}"`) };
  });
  const roomIds = new Set(rooms.map((r) => r.id));
  const roomLevel = new Map(rooms.map((r) => [r.id, r.level]));

  const openings = (raw.openings || []).map((o, i) => {
    need(isPoint(o.from) && isPoint(o.to), `Opening #${i + 1} needs "from" and "to" points`);
    need(o.from[0] === o.to[0] || o.from[1] === o.to[1], `Opening #${i + 1} must be axis-aligned`);
    return { type: o.type || 'door', from: o.from, to: o.to, sill: o.sill ?? 0.85, head: o.head ?? 2.1, level: levelOf(o, `Opening #${i + 1}`) };
  });

  const lights = (raw.lights || []).map((l) => {
    unique(l.id, 'A light');
    need(roomIds.has(l.room), `Light "${l.id}" refers to unknown room "${l.room}"`);
    need(LIGHT_TYPES.includes(l.type), `Light "${l.id}" has unknown type "${l.type}" (use ${LIGHT_TYPES.join(', ')})`);
    need(isPoint(l.pos), `Light "${l.id}" needs "pos": [x, z]`);
    return {
      ...l,
      name: l.name || l.id,
      rot: l.rot || 0,
      capabilities: l.capabilities || [], // plain smart plugs: on/off only
      level: roomLevel.get(l.room),
    };
  });

  const acs = (raw.acs || []).map((a) => {
    unique(a.id, 'An AC');
    need(roomIds.has(a.room), `AC "${a.id}" refers to unknown room "${a.room}"`);
    need(isPoint(a.pos), `AC "${a.id}" needs "pos": [x, z]`);
    need(WALLS.includes(a.wall), `AC "${a.id}" needs "wall": one of ${WALLS.join(', ')}`);
    return { ...a, name: a.name || a.id, y: a.y ?? 2.2, min: a.min ?? 16, max: a.max ?? 30, level: roomLevel.get(a.room) };
  });

  // A pedestal fan stands on the floor of a room: it has a place, a heading and a speed
    // range, but no wall and no thermostat.
  const fans = (raw.fans || []).map((f) => {
    unique(f.id, 'A fan');
    need(roomIds.has(f.room), `Fan "${f.id}" refers to unknown room "${f.room}"`);
    need(isPoint(f.pos), `Fan "${f.id}" needs "pos": [x, z]`);
    return {
      ...f,
      name: f.name || f.id,
      rot: f.rot || 0,
      height: f.height ?? 0.95,
      sweep: f.sweep ?? 45,
      level: roomLevel.get(f.room),
    };
  });

  // A curtain is a rod, a drop of cloth and two panels that gather aside as it opens. It used
  // to be pinned to a wall of its room; it is now placed freely, so the plan position is the
  // real one and `rot` is the angle the set faces. Its colour and sheerness are runtime state.
  const curtains = (raw.curtains || []).map((c) => {
    unique(c.id, 'A curtain');
    need(roomIds.has(c.room), `Curtain "${c.id}" refers to unknown room "${c.room}"`);
    need(isPoint(c.pos), `Curtain "${c.id}" needs "pos": [x, z]`);
    need(c.rot === undefined || Number.isFinite(c.rot), `Curtain "${c.id}" has a "rot" that is not a number`);
    need(c.wall === undefined || WALLS.includes(c.wall), `Curtain "${c.id}" has an unknown "wall": ${c.wall}`);
    const width = c.width ?? 2;
    need(width >= 0.4 && width <= 8, `Curtain "${c.id}" needs a "width" between 0.4 and 8 m`);
    need((c.height ?? 2.2) > 0.6, `Curtain "${c.id}" needs a "height" over 0.6 m`);
    // A plan that only knows the wall still lands on the same angle the wall used to mean.
    const wallRot = { north: 0, south: 180, west: 90, east: -90 };
    const rot = Number.isFinite(c.rot) ? c.rot : wallRot[c.wall] ?? 0;
    return {
      ...c,
      name: c.name || c.id,
      rot,
      width,
      height: c.height ?? 2.2,
      top: c.top ?? 2.35,
      open: c.open ?? 0.3,
      color: c.color || '#e8e2d6',
      opacity: c.opacity ?? 0.62,
      level: roomLevel.get(c.room),
    };
  });

  // A robot vacuum parks on its dock: the plan position is the dock, and the room it belongs
  // to is the area it cleans, so the model is given that room's rectangle to wander in.
  const vacuums = (raw.vacuums || []).map((v) => {
    unique(v.id, 'A robot vacuum');
    need(roomIds.has(v.room), `Vacuum "${v.id}" refers to unknown room "${v.room}"`);
    need(isPoint(v.pos), `Vacuum "${v.id}" needs "pos": [x, z]`);
    const room = rooms.find((r) => r.id === v.room);
    return {
      ...v,
      name: v.name || v.id,
      rot: v.rot || 0,
      battery: v.battery ?? 70,
      speed: v.speed || 'standard',
      rect: { x: room.x, z: room.z, w: room.w, d: room.d },
      level: roomLevel.get(v.room),
    };
  });

  // A motorised drying rack hangs from a ceiling: it belongs to a room but stands anywhere
  // in it, and it lifts what a `cover` position says (1 = fully lowered).
  const racks = (raw.racks || []).map((r) => {
    unique(r.id, 'A drying rack');
    need(roomIds.has(r.room), `Rack "${r.id}" refers to unknown room "${r.room}"`);
    need(isPoint(r.pos), `Rack "${r.id}" needs "pos": [x, z]`);
    const room = rooms.find((x) => x.id === r.room);
    return {
      ...r,
      name: r.name || r.id,
      rot: r.rot || 0,
      width: r.width ?? 1.6,
      lift: r.lift ?? 1.3,
      top: r.top ?? 2.62,
      level: roomLevel.get(r.room),
    };
  });

  // A dehumidifier or a humidifier stands on the floor like a fan: a place, a heading, a
  // humidity it works towards and the mode it runs in. `type` is what decides which of the
  // two it is; both share one list, because they behave the same way.
  const climates = (raw.climates || []).map((c) => {
    unique(c.id, 'An air treatment unit');
    need(roomIds.has(c.room), `Air treatment "${c.id}" refers to unknown room "${c.room}"`);
    need(isPoint(c.pos), `Air treatment "${c.id}" needs "pos": [x, z]`);
    need(CLIMATE_TYPES.includes(c.type), `Air treatment "${c.id}" needs a "type": one of ${CLIMATE_TYPES.join(', ')}`);
    const target = c.target ?? 50;
    need(target >= 30 && target <= 80, `Air treatment "${c.id}" needs a "target" between 30 and 80 %`);
    return {
      ...c,
      name: c.name || c.id,
      rot: c.rot || 0,
      target,
      mode: c.mode || 'auto',
      humidity: c.humidity ?? 58,
      tank: c.tank ?? 0.65,
      level: roomLevel.get(c.room),
    };
  });

  const scenes = (raw.scenes || []).map((s) => {
    need(typeof s.id === 'string' && s.id, 'A scene is missing an "id"');
    return { id: s.id, name: s.name || s.id, icon: s.icon || 'sun', lights: s.lights || {}, acs: s.acs || {} };
  });

  const furniture = (raw.furniture || []).map((f, i) => {
    const level = levelOf(f, `Furniture #${i + 1}`);
    // Stairs climb to the floor above unless told otherwise.
    const H = levels.find((l) => l.id === level).wallHeight;
    return f.type === 'stairs' && f.height == null ? { ...f, level, height: H + SLAB } : { ...f, level };
  });

  const box = (rs) => ({
    minX: Math.min(...rs.map((r) => r.x)),
    minZ: Math.min(...rs.map((r) => r.z)),
    maxX: Math.max(...rs.map((r) => r.x + r.w)),
    maxZ: Math.max(...rs.map((r) => r.z + r.d)),
  });
  // A floor with no rooms yet borrows the outline of the whole home.
  const all = box(rooms);
  for (const l of levels) {
    const own = rooms.filter((r) => r.level === l.id);
    l.bounds = own.length ? box(own) : all;
  }

  return {
    name: raw.name || 'Home',
    wallHeight,
    interiorWallHeight: raw.interiorWallHeight ?? 1.25,
    camera: { azimuth: raw.camera?.azimuth ?? 34, elevation: raw.camera?.elevation ?? 47 },
    outdoorTemp: raw.outdoorTemp ?? 27,
    levels,
    rooms,
    openings,
    furniture,
    lights,
    acs,
    fans,
    curtains,
    racks,
    vacuums,
    climates,
    scenes,
    bounds: all,
  };
}
