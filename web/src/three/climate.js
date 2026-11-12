// Air treatment: a dehumidifier and a humidifier, both floor-standing boxes of the same
// family, both with something visibly working while they run.
//
// A dehumidifier pulls damp air in through its top grille, spins a fan behind it, and the
// water it collects climbs up the window of its tank. A humidifier pushes a plume of mist
// out of its spout, and the water in its tank goes down as the mist goes up.
//
// The plan gives each of them a `type`, a place, a heading and a working humidity. Like a
// fan, a unit is driven by `{ on, target, mode }` from the store, so world.js treats them
// in the same loop.
import * as THREE from 'three';
import { box, cyl, mat, at } from './kit.js';

const SHELL = '#f1f3f5';
const SHELL_DARK = '#e2e6ea';
const GLASS = '#b9c2cc';
const DARK = '#2f343b';
const WATER = '#79d8e8';
const DRY = '#7fe3c8';       // the cool, dry air a dehumidifier gives off
const AIR = '#22ff8f';       // the stream it blows out of the grille
const MIST = '#a8f6ff';      // the plume a humidifier gives off

export const CLIMATE_TYPES = ['dehumidifier', 'humidifier'];
export const CLIMATE_MODES = ['auto', 'continuous', 'sleep'];
export const CLIMATE_MODE_NAMES = { auto: 'Auto', continuous: 'Continuous', sleep: 'Sleep' };
export const TARGET_MIN = 30;
export const TARGET_MAX = 80;

/** Hashed per-particle randomness. Two golden-ratio sequences stay correlated, so a
 *  particle's phase and its rate must come from different, independent hash chains. */
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// One sprite for every mote in the scene: a soft round dot, additive, tinted per vertex.
let GLOW = null;
function glow() {
  if (GLOW) return GLOW;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  GLOW = new THREE.CanvasTexture(c);
  GLOW.colorSpace = THREE.SRGBColorSpace;
  return GLOW;
}

/** A little three-blade rotor, seen from above through the grille. */
function rotorGeometry() {
  const blades = [];
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.BoxGeometry(0.012, 0.004, 0.085);
    geo.translate(0, 0, 0.052);
    geo.rotateY((i / 3) * Math.PI * 2);
    blades.push(geo);
  }
  const pos = [];
  const idx = [];
  let base = 0;
  for (const g of blades) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const index = g.getIndex();
    for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + base);
    base += p.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export class ClimateUnit {
  constructor(cfg) {
    this.cfg = cfg;
    this.type = cfg.type === 'humidifier' ? 'humidifier' : 'dehumidifier';
    this.target = null;
    this.on = false;
    this.level = 0;            // fan speed 0…1, eased towards the target
    this.clock = 0;
    this.spin = 0;
    this.mode = cfg.mode || 'auto';
    this.humidity = cfg.humidity ?? 58;
    this.water = cfg.tank ?? 0.65;   // 0…1, how full the tank is
    this.waterRate = this.type === 'dehumidifier' ? 0.0032 : -0.00008;

    this.group = new THREE.Group();
    this.group.position.set(cfg.pos[0], 0, cfg.pos[1]);
    this.group.rotation.y = (cfg.rot || 0) * Math.PI / 180;

    if (this.type === 'dehumidifier') this.buildDry();
    else this.buildHumid();

    this.buildMotes();
    if (this.type === 'dehumidifier') this.buildAir();

    // A picking box the size of the body: these are floor units, so a tap on the shell works.
    this.hit = new THREE.Mesh(
      new THREE.BoxGeometry(this.w + 0.06, this.h, this.d + 0.06),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.hit.position.y = this.h / 2;
    this.hit.userData = { kind: this.type === 'dehumidifier' ? 'dehumidifier' : 'humidifier', id: cfg.id };
    this.group.add(this.hit);

    this.apply(cfg.state || { on: false }, { instant: true });
  }

  /* ---------- dehumidifier ---------- */

  buildDry() {
    this.w = 0.34;
    this.d = 0.27;
    this.h = 0.58;
    const shell = mat(SHELL, { rough: 0.55 });
    const trim = mat(SHELL_DARK, { rough: 0.6 });
    const dark = mat(DARK, { rough: 0.45, metal: 0.2 });

    // Body: a rounded cabinet with a darker plinth, and four castors so it can be moved.
    this.group.add(box(this.w, this.h, this.d, shell, { r: 0.035 }).translateY(0));
    this.group.add(box(this.w - 0.03, 0.045, this.d - 0.03, trim, { r: 0.02 }).translateY(0.004));
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const c = cyl(0.022, 0.022, 0.026, dark, 12);
      at(c, x * (this.w / 2 - 0.045), 0, z * (this.d / 2 - 0.045));
      this.group.add(c);
    }

    // Front: the tank window, with the water that climbs while it collects.
    const front = this.d / 2 + 0.002;
    this.window = box(0.22, 0.24, 0.012, mat(GLASS, { rough: 0.18, opacity: 0.55 }), { r: 0.012 });
    at(this.window, 0, 0.13, front);
    this.group.add(this.window);
    const waterGeo = new THREE.BoxGeometry(0.205, 1, 0.016);
    waterGeo.translate(0, 0.5, 0);          // scale about its base, so it fills upwards
    this.waterMesh = new THREE.Mesh(waterGeo, mat(WATER, { rough: 0.22, opacity: 0.88 }));
    this.waterMesh.position.set(0, 0.142, front + 0.013);
    this.group.add(this.waterMesh);

    // The top: a circular intake with the rotor behind the slats, and a reading lamp.
    const top = this.h + 0.004;
    const lid = cyl(0.145, 0.155, 0.022, trim, 40);
    at(lid, 0, this.h - 0.018, 0);
    this.group.add(lid);
    this.rotor = new THREE.Mesh(rotorGeometry(), mat('#8b96a3', { rough: 0.35, metal: 0.5 }));
    this.rotor.position.y = top + 0.012;
    this.group.add(this.rotor);
    // Grille slats over the rotor, so the blades are seen through them rather than on top.
    for (let i = 0; i < 7; i++) {
      const r = 0.035 + i * 0.017;
      const bar = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0032, 5, 40), dark);
      bar.rotation.x = Math.PI / 2;
      at(bar, 0, top + 0.028, 0);
      this.group.add(bar);
    }
    this.group.add((() => { const d = cyl(0.019, 0.019, 0.008, dark, 16); at(d, 0, top + 0.026, 0); return d; })());

    // Status LED on the front skirt: green while it is working, dark when it is not.
    this.ledMat = new THREE.MeshStandardMaterial({ color: '#22352f', emissive: new THREE.Color(DRY), emissiveIntensity: 0, roughness: 0.4 });
    this.led = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.009, 0.006), this.ledMat);
    at(this.led, 0, 0.075, this.d / 2 + 0.004);
    this.group.add(this.led);
  }

  /* ---------- humidifier ---------- */

  buildHumid() {
    this.w = 0.23;
    this.d = 0.23;
    this.h = 0.34;
    const shell = mat(SHELL, { rough: 0.5 });
    const trim = mat(SHELL_DARK, { rough: 0.6 });
    const glass = mat(GLASS, { rough: 0.15, opacity: 0.42 });

    // A column: the outer body is translucent so the water inside is the level indicator.
    const body = cyl(0.108, 0.115, 0.3, glass, 36);
    at(body, 0, 0.02, 0);
    this.group.add(body);
    const base = cyl(0.118, 0.122, 0.045, shell, 36);
    at(base, 0, 0, 0);
    this.group.add(base);
    const collar = cyl(0.11, 0.108, 0.014, trim, 36);
    at(collar, 0, 0.315, 0);
    this.group.add(collar);

    const waterGeo = new THREE.CylinderGeometry(0.099, 0.102, 1, 32);
    waterGeo.translate(0, 0.5, 0);
    this.waterMesh = new THREE.Mesh(waterGeo, mat(WATER, { rough: 0.2, opacity: 0.6 }));
    this.waterMesh.position.y = 0.03;
    this.group.add(this.waterMesh);

    // Spout and the small ultrasonic disc that makes the mist.
    const spout = cyl(0.036, 0.042, 0.03, shell, 24);
    at(spout, 0, 0.322, 0);
    this.group.add(spout);
    this.disc = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.004, 24), mat('#dfe6ea', { rough: 0.25, metal: 0.6 }));
    at(this.disc, 0, 0.334, 0);
    this.group.add(this.disc);

    // A ring of light at the base, the only thing that says "on" from across the room.
    this.ledMat = new THREE.MeshStandardMaterial({ color: '#1e3431', emissive: new THREE.Color('#66e6cf'), emissiveIntensity: 0, roughness: 0.35 });
    this.led = new THREE.Mesh(new THREE.TorusGeometry(0.113, 0.0075, 8, 40), this.ledMat);
    this.led.rotation.x = Math.PI / 2;
    at(this.led, 0, 0.012, 0);
    this.group.add(this.led);
  }

  /* ---------- the moving part ---------- */

  buildMotes() {
    // Dehumidifier: a few drops falling inside the tank window, so the collecting reads even
    // when the water line has barely moved. Humidifier: the mist plume itself.
    this.moteCount = this.type === 'dehumidifier' ? 12 : 220;
    // Hashed per-mote randomness, not another golden-ratio sequence: with `phase` and `rate`
    // both taken from i * irrational the two stay correlated, every mote advances by the same
    // fraction, and the plume collapses into a single band instead of a column.
    this.motes = Array.from({ length: this.moteCount }, (_, i) => ({
      phase: hash(i + 1),
      angle: i * 2.399963,
      radius: 0.012 + hash(i + 7) * (this.type === 'humidifier' ? 0.055 : 0.09),
      rate: this.type === 'humidifier' ? 0.55 + hash(i + 31) * 0.35 : 0.55 + hash(i + 31) * 0.4,
      bright: 0.5 + hash(i + 61) * 0.5,
      wobble: hash(i + 97) * Math.PI * 2,
    }));
    const geo = new THREE.BufferGeometry();
    this.motePos = new Float32Array(this.moteCount * 3);
    this.moteCol = new Float32Array(this.moteCount * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.moteCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.moteColor = new THREE.Color(this.type === 'humidifier' ? MIST : DRY);
    this.motesMesh = new THREE.Points(geo, new THREE.PointsMaterial({
      size: this.type === 'humidifier' ? 0.140 : 0.028,
      sizeAttenuation: true, map: glow(), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.motesMesh.frustumCulled = false;
    this.motesMesh.visible = false;
    this.group.add(this.motesMesh);
  }

  /** The air a dehumidifier blows up out of its grille: a short, widening, lightly swirling
   *  column of motes above the lid, on top of the drops falling behind the tank window. */
  buildAir() {
    this.airCount = 260;
    this.airParts = Array.from({ length: this.airCount }, (_, i) => ({
      phase: hash(i + 131),
      angle: hash(i + 149) * Math.PI * 2,
      radius: 0.028 + hash(i + 163) * 0.075,
      speed: 0.5 + hash(i + 179) * 0.45,
      bright: 0.45 + hash(i + 191) * 0.55,
      swirl: (hash(i + 211) > 0.5 ? 1 : -1) * (0.6 + hash(i + 223) * 0.7),
    }));
    this.airPos = new Float32Array(this.airCount * 3);
    this.airCol = new Float32Array(this.airCount * 3);
    this.flow = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.airPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.airCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.airMesh = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.110, sizeAttenuation: true, map: glow(), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.airMesh.frustumCulled = false;
    this.airMesh.visible = false;
    this.group.add(this.airMesh);
  }

  /** Where the stream is right now: 0.60 m (the grille) up to 1.02 m, widening as it rises. */
  writeAir() {
    const pos = this.airPos;
    const col = this.airCol;
    const c = new THREE.Color(AIR);
    for (let i = 0; i < this.airCount; i++) {
      const p = this.airParts[i];
      const t = (p.phase + this.flow * p.speed) % 1;
      const a = p.angle + t * p.swirl;
      const rad = p.radius * (0.45 + t * 1.80);
      pos[i * 3] = Math.cos(a) * rad;
      pos[i * 3 + 1] = 0.605 + t * 0.72;
      pos[i * 3 + 2] = Math.sin(a) * rad;
      const fade = Math.pow(Math.sin(Math.PI * Math.min(1, t)), 0.45) * p.bright * 1.20 * this.level;
      col[i * 3] = c.r * fade; col[i * 3 + 1] = c.g * fade; col[i * 3 + 2] = c.b * fade;
    }
    this.airMesh.geometry.attributes.position.needsUpdate = true;
    this.airMesh.geometry.attributes.color.needsUpdate = true;
  }

  anchor(out) {
    return out.set(0, this.h + 0.02, 0).applyMatrix4(this.group.matrixWorld);
  }

  /**
   * state = { on, target: 30…80, mode: 'auto' | 'continuous' | 'sleep', humidity }
   * Nothing here is a Home Assistant vocabulary yet: the unit works the humidity it is given.
   */
  apply(state = {}, { instant = false } = {}) {
    const s = state || {};
    this.on = s.on !== false;
    this.target = THREE.MathUtils.clamp(Math.round(s.target ?? this.target ?? 50), TARGET_MIN, TARGET_MAX);
    this.mode = CLIMATE_MODES.includes(s.mode) ? s.mode : this.mode;
    if (Number.isFinite(s.humidity)) this.humidity = s.humidity;
    if (instant) {
      this.level = this.on ? 1 : 0;
      this.write();
    }
  }

  /** The humidity the room is drifting towards while the unit runs. */
  stepHumidity(dt) {
    if (!this.on) return;
    const pull = this.mode === 'sleep' ? 0.06 : this.mode === 'continuous' ? 0.22 : 0.12;
    this.humidity += (this.target - this.humidity) * Math.min(1, dt * pull);
    if (this.type === 'dehumidifier') this.water = Math.min(1, this.water + dt * this.waterRate * (this.mode === 'sleep' ? 0.6 : 1));
    else this.water = Math.max(this.on ? 0.05 : 0, this.water + dt * this.waterRate * (this.mode === 'sleep' ? 0.6 : 1));
    // A full tank stops a humidifier, an empty one stops a dehumidifier: the store is told,
    // so the panel agrees with the model instead of drifting apart.
    if (this.type === 'humidifier' && this.water <= 0 && this.on) this.onWater?.('empty');
    if (this.type === 'dehumidifier' && this.water >= 1 && this.on) this.onWater?.('full');
  }

  write() {
    this.waterMesh.scale.y = this.type === 'humidifier'
      ? Math.max(0.02, this.water * 0.27) : Math.max(0.02, this.water * 0.22);
    this.ledMat.emissiveIntensity = this.on ? 1.5 + Math.sin(this.clock * 2.2) * 0.35 : 0;
    if (this.rotor) this.rotor.rotation.y = this.spin;
    if (this.motesMesh) {
      const working = this.on && (this.type === 'humidifier' ? this.water > 0 : true);
      this.motesMesh.visible = working;
      if (working) this.writeMotes();
    }
    // The blown air only exists while the fan does; it fades out with the rotor on the way down.
    if (this.airMesh) {
      this.airMesh.visible = this.on || this.level > 0.05;
      if (this.airMesh.visible) this.writeAir();
    }
  }

  /** Motes: drops falling in the tank, or a plume that rises and spreads. */
  writeMotes() {
    const pos = this.motePos;
    const col = this.moteCol;
    const c = this.moteColor;
    const humid = this.type === 'humidifier';
    const spoutY = 0.335;
    for (let i = 0; i < this.moteCount; i++) {
      const m = this.motes[i];
      const t = (m.phase + this.clock * m.rate) % 1;
      if (humid) {
        // Up and out: a column that widens as it leaves the spout, swaying a little.
        const sway = Math.sin(this.clock * 1.1 + m.wobble) * 0.02 * t;
        const rad = m.radius * (1 + t * 2.2);
        pos[i * 3] = Math.cos(m.angle) * rad + sway;
        pos[i * 3 + 1] = spoutY + t * 0.90;
        pos[i * 3 + 2] = Math.sin(m.angle) * rad + sway;
        const fade = Math.pow(Math.sin(Math.PI * Math.min(1, t)), 0.45) * m.bright * 1.00;
        col[i * 3] = c.r * fade; col[i * 3 + 1] = c.g * fade; col[i * 3 + 2] = c.b * fade;
      } else {
        // Down inside the window: a short fall, fading as it reaches the water.
        const top = 0.36;
        pos[i * 3] = (m.phase - 0.5) * 0.17;
        pos[i * 3 + 1] = top - t * 0.2;
        pos[i * 3 + 2] = this.d / 2 + 0.02;
        const fade = Math.sin(Math.PI * t) * 0.42 * m.bright;
        col[i * 3] = c.r * fade; col[i * 3 + 1] = c.g * fade; col[i * 3 + 2] = c.b * fade;
      }
    }
    this.motesMesh.geometry.attributes.position.needsUpdate = true;
    this.motesMesh.geometry.attributes.color.needsUpdate = true;
  }

  /** True while anything still moves, so the renderer can skip a redraw when idle. */
  update(dt) {
    this.clock += dt;
    const target = this.on ? 1 : 0;
    this.level += (target - this.level) * (1 - Math.exp(-dt * (target > this.level ? 3 : 1.6)));
    if (Math.abs(target - this.level) < 0.01) this.level = target;
    if (this.type === 'dehumidifier') this.spin += dt * this.level * 26;
    if (this.airMesh) this.flow += dt * (0.2 + 0.8 * this.level);
    if (this.on) this.stepHumidity(dt);
    this.write();
    return this.level > 0.02 || this.motesMesh.visible || this.airMesh?.visible || this.on;
  }
}
