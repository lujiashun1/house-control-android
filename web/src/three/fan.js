// Pedestal (standing) fan: a fixed shell, a rotor that spins up and coasts down, a head that
// sweeps side to side, and a green airflow that follows the head.
// Built from the same primitives as the rest of the model (kit.js), so it stands in a room at
// the same scale as the furniture and shadows like the AC does.
import * as THREE from 'three';
import { box, cyl, mat, at } from './kit.js';

const SHELL = '#eef0f2';
const TRIM = '#dde1e6';
const WIRE = '#c6ced6';
const MOTOR = '#2c3138';
const BLADE = '#e6e9ec';

// Speed levels 0-5 as target angular velocity, rad/s. Low enough to read as separate blades,
// high enough that 5 looks like the blur a real fan makes at 60 fps.
export const SPEEDS = [0, 9, 17, 25, 34, 44];
export const SPEED_NAMES = ['off', 'quiet', 'low', 'medium', 'high', 'turbo'];

// Front face of the guard, in the head's own frame: the air leaves from just outside it.
const FRONT_Z = 0.118;

// How far the air visibly travels, metres, and how many motes carry it.
const WIND_REACH = 1.7;
const WIND_MOTES = 260;

/* ---------- parts ---------- */

// A cylinder lying along z, centred on the origin (kit's cyl stands on y = 0, which is no
// good for a motor or a badge that faces the room).
function tubeZ(rTop, rBottom, len, material, seg = 24) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, len, seg);
  geo.rotateX(Math.PI / 2);
  return new THREE.Mesh(geo, material);
}

// A guard ring facing +z.
function ring(r, tube, z, material, seg = r < 0.12 ? 40 : 56) {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, seg), material);
  mesh.position.z = z;
  return mesh;
}

// One radial guard wire in the XY plane at z.
function spoke(radius, z, angle, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(radius, 0.0048, 0.0048), material);
  mesh.position.set(Math.cos(angle) * radius / 2, Math.sin(angle) * radius / 2, z);
  mesh.rotation.z = angle;
  return mesh;
}

// One blade as a twisted, swept plate: a small grid bent the way a fan blade is actually
// bent, so the silhouette reads as a blade and not as a paddle.
function bladeGeometry({
  root = 0.048, length = 0.152, chord = 0.098, pitch = [24, 44], sweep = 0.03, camber = 0.012,
  nu = 12, nv = 7,
} = {}) {
  const positions = [];
  const index = [];
  for (let i = 0; i < nu; i++) {
    const u = i / (nu - 1);                                     // root -> tip
    const r = root + u * length;
    const p = THREE.MathUtils.degToRad(pitch[0] + (pitch[1] - pitch[0]) * Math.pow(u, 0.8));
    const c = chord * (0.40 + 0.60 * Math.sin(Math.PI * Math.min(1, 0.06 + u * 0.92)));
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);                                   // leading -> trailing edge
      const d = (v - 0.5) * c;
      const bend = camber * Math.cos(Math.PI * (v - 0.5)) * Math.sin(Math.PI * u);
      positions.push(
        r,
        -Math.sin(p) * d + bend,                                // pitch grows towards the tip
        Math.cos(p) * d + sweep * u * u * 2 * (v - 0.5),        // swept back, so the tip trails
      );
    }
  }
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nv - 1; j++) {
      const a = i * nv + j;
      const b = a + nv;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// Soft round sprite for the airflow motes. Additive blending means black is invisible, so
// the per-mote fade rides in the vertex colour and this stays one draw call.
let GLOW = null;
function glow() {
  if (GLOW) return GLOW;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  GLOW = new THREE.CanvasTexture(c);
  GLOW.colorSpace = THREE.SRGBColorSpace;
  return GLOW;
}

/**
 * The fan, with its moving parts handed back separately:
 *   pivot  — the whole head, turns for the sweep (yaw)
 *   tilt   — guard + rotor, fixed up/down tilt
 *   rotor  — blades + hub, spins on z
 */
export function standingFan({
  color = SHELL, bladeColor = BLADE, guard = 0.212, height = 0.95, tilt = 0,
} = {}) {
  const shell = mat(color, { rough: 0.45 });
  const trim = mat(TRIM, { rough: 0.5 });
  const wire = mat(WIRE, { rough: 0.32, metal: 0.55 });
  const motor = mat(MOTOR, { rough: 0.45 });
  const led = new THREE.MeshStandardMaterial({ color: '#243038', emissive: '#4fc3ff', emissiveIntensity: 0, roughness: 0.4 });

  const root = new THREE.Group();

  // Weighted base, domed to the pole so it does not read as a puddle on the floor.
  root.add(
    at(cyl(0.178, 0.202, 0.026, trim, 40), 0, 0, 0),
    at(cyl(0.166, 0.178, 0.018, shell, 40), 0, 0.026, 0),
    at(cyl(0.026, 0.03, 0.03, trim, 20), 0, 0.044, 0),
  );

  // Pole, with the height collar and its knob.
  const poleTop = Math.max(0.5, height - 0.07);
  root.add(
    at(cyl(0.016, 0.019, poleTop - 0.074, mat('#cfd4d9', { rough: 0.3, metal: 0.6 }), 20), 0, 0.074, 0),
    at(cyl(0.023, 0.023, 0.05, trim, 20), 0, poleTop * 0.55, 0),
  );
  const knob = at(tubeZ(0.011, 0.011, 0.045, motor, 16), 0.03, poleTop * 0.55 + 0.025, 0);
  knob.rotation.y = Math.PI / 2;
  root.add(knob);
  root.add(at(box(0.05, 0.016, 0.014, led, { r: 0.003 }), 0.036, poleTop - 0.12, 0));

  /* ----- the swinging head ----- */

  const pivot = new THREE.Group();
  pivot.position.y = height;
  root.add(pivot);

  // Neck up from the pole, and the yoke arms that hold the guard. On a real fan the
  // oscillator turns this whole bracket, so they belong to the pivot, not to the base.
  pivot.add(at(box(0.05, 0.17, 0.05, shell, { r: 0.012 }), 0, -0.17, -0.045));
  for (const s of [-1, 1]) {
    pivot.add(at(box(0.016, 0.10, 0.052, trim, { r: 0.006 }), s * (guard + 0.014), -0.03, -0.008));
    const pivotKnob = at(tubeZ(0.014, 0.014, 0.02, motor, 16), s * (guard + 0.026), 0, 0.012);
    pivotKnob.rotation.y = Math.PI / 2;
    pivot.add(pivotKnob);
  }

  const tiltGroup = new THREE.Group();
  tiltGroup.rotation.x = THREE.MathUtils.degToRad(tilt);
  pivot.add(tiltGroup);

  // Guard: concentric rings on both faces plus radial wires, the way a fan guard is woven.
  const backZ = 0.012;
  const frontZ = FRONT_Z;
  const bladeZ = 0.066;
  // Front face carries the fine rings (that is the side you look at); the back is coarser,
  // the way a real guard is wound.
  const fine = [
    ring(guard, 0.0046, backZ, wire), ring(guard, 0.0046, frontZ, wire),
  ];
  for (const r of [0.048, 0.094, 0.14, 0.184]) fine.push(ring(r, 0.0028, backZ, wire));
  for (const r of [0.038, 0.076, 0.112, 0.148, 0.184]) fine.push(ring(r, 0.0028, frontZ, wire));
  for (let i = 0; i < 8; i++) fine.push(spoke(guard, backZ, (i / 8) * Math.PI * 2 + 0.3, wire));
  for (let i = 0; i < 12; i++) fine.push(spoke(guard, frontZ, (i / 12) * Math.PI * 2, wire));
  tiltGroup.add(...fine);

  // Motor block behind the blades, its rear cap, and the collar the guard hangs on.
  tiltGroup.add(
    at(tubeZ(0.058, 0.052, 0.10, mat('#3a4048', { rough: 0.4, metal: 0.25 })), 0, 0, -0.012),
    at(tubeZ(0.052, 0.026, 0.03, motor), 0, 0, -0.075),
    at(tubeZ(0.062, 0.062, 0.012, trim), 0, 0, 0.032),
    // Badge in the middle of the front guard.
    at(tubeZ(0.032, 0.032, 0.01, trim, 32), 0, 0, frontZ + 0.004),
    at(tubeZ(0.021, 0.021, 0.014, mat('#3f6fa8', { rough: 0.4 }), 32), 0, 0, frontZ + 0.008),
  );

  const rotor = new THREE.Group();
  rotor.position.z = bladeZ;
  const bladeMaterial = new THREE.MeshStandardMaterial({
    color: bladeColor, roughness: 0.55, metalness: 0, side: THREE.DoubleSide,
  });
  const bladeGeo = bladeGeometry();
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(bladeGeo, bladeMaterial);
    blade.rotation.z = (i / 3) * Math.PI * 2;
    rotor.add(blade);
  }
  rotor.add(
    at(tubeZ(0.044, 0.05, 0.045, trim, 28), 0, 0, 0),
    at(tubeZ(0.026, 0.044, 0.02, mat('#b9c0c7', { rough: 0.4 }), 24), 0, 0, 0.03),
  );
  tiltGroup.add(rotor);

  // Picking target for the whole appliance.
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(guard * 2 + 0.06, 0.34, 0.34), new THREE.MeshBasicMaterial(),
  );
  hit.position.set(0, height + 0.03, 0.04);
  hit.visible = false;
  root.add(hit);

  root.traverse((o) => {
    if (!o.isMesh || o === hit) return;
    o.receiveShadow = true;
    // The woven guard is dozens of thin meshes: lovely in the picture, and dozens of draw
    // calls in every shadow map. Let the solid parts cast, the wires only receive.
    o.castShadow = !fine.includes(o);
  });

  return { group: root, pivot, tilt: tiltGroup, rotor, hit, led };
}

/* ---------- the unit, driven like a lamp or an AC ---------- */

export class FanUnit {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.id = cfg.id;
    const parts = standingFan(cfg);
    this.group = parts.group;
    this.group.position.set(cfg.pos?.[0] ?? 0, cfg.y ?? 0, cfg.pos?.[1] ?? 0);
    this.group.rotation.y = THREE.MathUtils.degToRad(cfg.rot || 0);
    this.pivot = parts.pivot;
    this.tilt = parts.tilt;
    this.rotor = parts.rotor;
    this.reverse = false;
    this.hit = parts.hit;
    this.hit.userData = { kind: 'fan', id: cfg.id };
    this.led = parts.led;

    this.omega = 0;                              // rad/s the blades are doing right now
    this.target = 0;                             // rad/s the speed setting asks for
    this.spin = 0;                               // accumulated angle, so a speed change never jumps
    this.level = 0;                              // 0-5, for the readout
    this.angle = 0;                              // head yaw, radians
    this.phase = 0;                              // sweep phase
    this.oscOn = false;
    this.sweep = THREE.MathUtils.degToRad(cfg.sweep ?? 45);   // half-swing: 90° total
    this.oscRate = cfg.oscRate ?? 0.85;          // rad/s of the sweep sine: one sweep every ~7 s

    /* ----- airflow ----- */

    // Motes carried out of the guard. They live in the tilt group, so they turn and tilt
    // with the head: the wind goes where the fan points, including through a sweep.
    this.windColor = new THREE.Color(cfg.windColor || '#4ee79b');
    this.windPhase = 0;
    this.clock = 0;
    this.windSeeds = Array.from({ length: WIND_MOTES }, (_, i) => {
      const a = i * 2.399963;                   // golden angle: an even scatter in the disc
      const k = (i * 0.754877) % 1;
      return {
        phase: (i * 0.618034) % 1,
        angle: a,
        radius: 0.028 + Math.sqrt(k) * 0.152,   // area-uniform inside the guard
        rate: 0.85 + ((i * 0.618034) % 1) * 0.4,
        bright: 0.55 + ((i * 0.381966) % 1) * 0.45,
        wobble: (i * 2.399) % (Math.PI * 2),
      };
    });
    const windGeo = new THREE.BufferGeometry();
    this.windPos = new Float32Array(WIND_MOTES * 3);
    this.windCol = new Float32Array(WIND_MOTES * 3);
    windGeo.setAttribute('position', new THREE.BufferAttribute(this.windPos, 3).setUsage(THREE.DynamicDrawUsage));
    windGeo.setAttribute('color', new THREE.BufferAttribute(this.windCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.wind = new THREE.Points(windGeo, new THREE.PointsMaterial({
      size: 0.072, sizeAttenuation: true, map: glow(), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.wind.frustumCulled = false;
    this.wind.position.z = FRONT_Z + 0.012;
    this.wind.visible = false;
    this.tilt.add(this.wind);

    this.apply(cfg.state || { on: false }, { instant: true });
  }

  anchor(out) {
    return out.set(0, this.cfg.height ?? 0.95, 0.06).applyMatrix4(this.group.matrixWorld);
  }

  /** display rpm, for the panel or a tooltip */
  get rpm() {
    return Math.round((this.omega / (Math.PI * 2)) * 60);
  }

  /**
   * state = { on, speed: 0-5 | 'low' | 'high' …, oscillate, sweep: half-swing degrees }
   * Same shape as a lamp's or an AC's state, so world.js can drive it in one loop.
   */
  apply(state = {}, { instant = false } = {}) {
    const on = state.on !== false;
    const asked = state.speed ?? this.level;
    const level = typeof asked === 'number'
      ? Math.round(asked)
      : SPEED_NAMES.indexOf(asked);
    // An unknown name falls back to medium rather than to "off".
    this.level = level >= 0 ? Math.min(SPEEDS.length - 1, level) : 3;
    this.target = on ? SPEEDS[this.level] : 0;
    this.oscOn = on && !!state.oscillate;
    this.reverse = state.direction === 'reverse';
    if (typeof state.sweep === 'number') this.sweep = THREE.MathUtils.degToRad(state.sweep);
    if (instant) {
      this.omega = this.target;
      this.phase = 0;
      this.angle = 0;
      this.write();
    }
  }

  // "reverse" is a Home Assistant fan's winter direction: same speed, blades turning the
  // other way, air pushed up along the wall instead of straight at you.
  get turn() { return (this.reverse ? 1 : -1); }

  write() {
    this.rotor.rotation.z = this.turn * this.spin;
    this.pivot.rotation.y = this.angle;
    this.led.emissiveIntensity = this.level > 0 ? 1.6 : 0;
    this.wind.visible = this.omega > 0.6;
    if (this.wind.visible) this.writeWind();
  }

  /** The motes: a cone out of the guard, slowly twisting as the air turns. */
  writeWind() {
    const pos = this.windPos;
    const col = this.windCol;
    const c = this.windColor;
    // Below about a third of full speed the air barely carries, so it fades out with it.
    const strength = Math.min(1, this.omega / 34);
    for (let i = 0; i < WIND_MOTES; i++) {
      const s = this.windSeeds[i];
      const t = (s.phase + this.windPhase * s.rate) % 1;
      const swirl = t * 0.55 + Math.sin(this.clock * 1.6 + s.wobble) * 0.05;
      const ang = s.angle + swirl;
      const rad = s.radius * (1 + 0.18 * t);   // spreads a touch, never wider than the guard
      pos[i * 3] = Math.cos(ang) * rad;
      pos[i * 3 + 1] = Math.sin(ang) * rad;
      pos[i * 3 + 2] = t * WIND_REACH;
      // Fade in off the guard and out at the far end.
      const fade = Math.pow(Math.sin(Math.PI * t), 0.55) * strength * s.bright * 0.58;
      col[i * 3] = c.r * fade;
      col[i * 3 + 1] = c.g * fade;
      col[i * 3 + 2] = c.b * fade;
    }
    this.wind.geometry.attributes.position.needsUpdate = true;
    this.wind.geometry.attributes.color.needsUpdate = true;
  }

  /** returns true while anything still moves, so the renderer can skip a redraw when idle */
  update(dt) {
    // Spins up briskly, coasts down slowly — a real fan takes a second to get going and
    // several to stop, and that coast is most of what sells the motion.
    if (this.target !== this.omega) {
      const k = 1 - Math.exp(-dt * (this.target > this.omega ? 2.4 : 1.2));
      this.omega += (this.target - this.omega) * k;
      if (Math.abs(this.target - this.omega) < 0.03) this.omega = this.target;
    }

    this.clock = (this.clock || 0) + dt;
    this.spin += this.omega * dt;
    this.rotor.rotation.z = this.turn * this.spin;

    // Sweep only while the blades are turning: the oscillator runs off the same motor.
    if (this.oscOn && this.omega > 0.5) {
      this.phase += dt * this.oscRate;
      const want = Math.sin(this.phase) * this.sweep;
      this.angle += (want - this.angle) * (1 - Math.exp(-dt * 6));
    } else if (this.angle !== 0) {
      // Head eases back to face forward instead of freezing mid-sweep.
      this.angle += (0 - this.angle) * (1 - Math.exp(-dt * 2.5));
      if (Math.abs(this.angle) < 0.001) this.angle = 0;
    }
    this.pivot.rotation.y = this.angle;

    // Air travels with the blades: about 4 m/s at full tilt.
    this.windPhase += this.omega * dt * 0.045;
    const blowing = this.omega > 0.6;
    this.wind.visible = blowing;
    if (blowing) this.writeWind();

    this.led.emissiveIntensity = this.level > 0 ? 1.6 : 0;

    return this.omega > 0.03 || this.angle !== 0 || this.target !== this.omega || blowing;
  }
}
