// Robot vacuum: a disc that parks on its dock, drives around the room while it cleans, and
// turns back when it is told to return. The dock is where the plan puts it; the robot's
// wander stays inside the room it belongs to.
// Built from the same primitives as the rest of the model (kit.js) at the same scale.
import * as THREE from 'three';
import { box, cyl, mat } from './kit.js';

const BODY = '#3b4250';        // graphite disc
const TOP = '#232a35';         // glass top plate
const BUMPER = '#c9ced6';      // light bumper round the front half
const TRIM = '#8f97a3';
const DOCK = '#e5e8ec';

// Diameter 0.34 m, 0.095 m tall — a real robot vacuum, so it reads correctly beside a chair leg.
const RADIUS = 0.17;
const BODY_H = 0.076;

// Speed the robot drives at, per fan-speed name, m/s. Quiet really does crawl.
const DRIVE = { quiet: 0.16, standard: 0.26, strong: 0.36, max: 0.46 };

// Status ring colours: cleaning, paused, returning, docked, error.
const RING = { cleaning: '#4ee79b', paused: '#f0b45a', returning: '#63b7ff', docked: '#7b8494', error: '#ef5f5f' };

/* ---------- parts ---------- */

// A disc lying flat: kit's cyl stands on y = 0, which is what a body wants.
function disc(r, h, material, y, seg = 44) {
  const mesh = cyl(r, r, h, material, seg);
  mesh.position.y = y;
  return mesh;
}

// A three-armed side brush, flat on the floor and spun about y.
function sideBrush(material) {
  const group = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.003, 0.009), material);
    arm.position.x = 0.026;
    arm.rotation.z = 0;
    const pivot = new THREE.Group();
    pivot.rotation.y = (i / 3) * Math.PI * 2;
    pivot.add(arm);
    group.add(pivot);
  }
  return group;
}

// The charging dock: a low plate the robot sits on, with two contacts at the back.
function dock() {
  const group = new THREE.Group();
  const plate = box(0.30, 0.014, 0.20, mat(DOCK, { rough: 0.55 }), { r: 0.006 });
  plate.position.y = 0.001;
  const back = box(0.26, 0.052, 0.045, mat('#f2f4f7', { rough: 0.5 }), { r: 0.008 });
  back.position.set(0, 0.012, 0.088);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), mat('#4ee79b', { emissive: '#4ee79b', rough: 1 }));
  led.position.set(0.09, 0.062, 0.088);
  group.add(plate, back, led);
  return group;
}

/* ---------- the unit ---------- */

export class VacuumUnit {
  constructor(cfg = {}, { onDocked = null } = {}) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.onDocked = onDocked;

    this.group = new THREE.Group();
    this.group.position.set(cfg.pos?.[0] ?? 0, cfg.y ?? 0, cfg.pos?.[1] ?? 0);
    this.group.rotation.y = THREE.MathUtils.degToRad(cfg.rot || 0);

    this.dock = dock();
    this.group.add(this.dock);

    // Everything that turns or drives sits under `chassis`, so the heading is one rotation.
    this.chassis = new THREE.Group();
    this.group.add(this.chassis);

    const body = disc(RADIUS, BODY_H, mat(BODY, { rough: 0.42, metal: 0.15 }), 0.008);
    body.castShadow = true;
    body.receiveShadow = true;

    const bumper = disc(RADIUS + 0.004, 0.026, mat(BUMPER, { rough: 0.5 }), 0.012, 44);
    bumper.castShadow = true;

    const plate = disc(RADIUS - 0.012, 0.006, mat(TOP, { rough: 0.28, metal: 0.3 }), 0.086);
    plate.castShadow = false;
    plate.receiveShadow = true;

    // The lidar turret sits off centre, towards the back, the way real ones do.
    const turret = disc(0.037, 0.020, mat('#2a3038', { rough: 0.4 }), 0.090, 26);
    turret.position.z = -0.026;
    const window = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0385, 0.0385, 0.009, 26, 1, true),
      mat('#10151c', { rough: 0.2, metal: 0.5 }),
    );
    window.position.set(0, 0.100, -0.026);

    // The status ring: a thin glowing annulus on the top plate.
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.062, 0.0045, 8, 40),
      mat('#4ee79b', { rough: 1, emissive: '#4ee79b', emissiveIntensity: 0 }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.090;

    const button = disc(0.011, 0.004, mat('#5b6472', { rough: 0.6 }), 0.090, 16);
    button.position.set(0.075, 0.090, -0.026);

    // Two drive wheels, half sunk, and a caster at the front: enough to read as a robot.
    this.wheels = [];
    for (const sx of [-1, 1]) {
      const wheel = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.026, 0.052), mat('#161b23', { rough: 0.9 }));
      wheel.position.set(sx * 0.122, 0.012, 0.055);
      this.wheels.push(wheel);
    }
    const caster = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 8), mat('#20262f', { rough: 0.8 }));
    caster.position.set(0, 0.012, -0.132);

    // A side brush at the front left, spinning while it cleans.
    this.brush = sideBrush(mat('#5e646d', { rough: 0.9 }));
    this.brush.position.set(-0.118, 0.006, 0.112);

    this.chassis.add(body, bumper, plate, turret, window, this.ring, button, caster, this.brush, ...this.wheels);

    // Invisible, slightly generous hit volume for picking.
    const hitGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.13, 16);
    hitGeo.translate(0, 0.06, 0);
    this.hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
    this.hit.userData = { kind: 'vacuum', id: cfg.id };
    this.group.add(this.hit);

    /* ----- driving ----- */
    this.status = 'docked';
    this.speed = 'standard';
    this.battery = cfg.battery ?? 70;
    this.x = cfg.pos?.[0] ?? 0;
    this.z = cfg.pos?.[1] ?? 0;
    this.heading = THREE.MathUtils.degToRad(cfg.rot || 0) + Math.PI;   // faces out of the dock
    this.aim = this.heading;
    this.brushAngle = 0;
    this.clock = 0;
    this.wait = 0;
    this.target = null;                    // { x, z } the robot is driving to
    // The room it may wander in, with a margin so it never clips a wall.
    const r = cfg.rect;
    this.area = r ? { minX: r.x + 0.28, maxX: r.x + r.w - 0.28, minZ: r.z + 0.28, maxZ: r.z + r.d - 0.28 } : null;
    if (this.area && this.area.maxX < this.area.minX + 0.1) this.area = null;

    this.apply(cfg.state || { status: 'docked', battery: this.battery, speed: this.speed }, { instant: true });
  }

  anchor(out) {
    return out.set(0, 0.10, 0).applyMatrix4(this.group.matrixWorld);
  }

  get cleaning() { return this.status === 'cleaning'; }

  /** where the robot actually is, for the panel's note or a test */
  position() { return { x: this.x, z: this.z, heading: this.heading }; }

  /**
   * state = { status, battery, speed } — the same `status` a Home Assistant vacuum reports
   * (cleaning / paused / returning / docked / error), plus what the panel lets you set.
   */
  apply(state = {}, { instant = false } = {}) {
    if (state.status && state.status !== this.status) {
      const before = this.status;
      this.status = state.status;
      // Told to clean from the dock: leave it and pick a first waypoint.
      if (this.status === 'cleaning' && before !== 'cleaning') this.target = null;
      // Told to go home: aim at the dock, whatever it was doing.
      if (this.status === 'returning') this.target = { x: this.cfg.pos?.[0] ?? 0, z: this.cfg.pos?.[1] ?? 0 };
    }
    if (typeof state.speed === 'string' && DRIVE[state.speed] != null) this.speed = state.speed;
    if (typeof state.battery === 'number') this.battery = Math.max(0, Math.min(100, state.battery));
    if (instant && this.status === 'docked') {
      this.x = this.cfg.pos?.[0] ?? 0;
      this.z = this.cfg.pos?.[1] ?? 0;
    }
    if (instant) this.write();
  }

  write() {
    this.chassis.position.x = 0;
    this.chassis.position.z = 0;
    this.chassis.rotation.y = this.heading;
    this.brush.rotation.y = this.brushAngle;
    const ring = RING[this.status] || RING.docked;
    this.ring.material.color.set(ring);
    this.ring.material.emissive.set(ring);
    this.ring.material.emissiveIntensity = this.status === 'docked' ? 0.15 : 1.1;
  }

  /** returns true while it still moves, so the renderer can idle when everything is parked */
  update(dt) {
    this.clock += dt;
    const moving = this.status === 'cleaning' || this.status === 'returning';
    if (!moving) {
      this.write();
      return false;                       // parked: nothing to redraw until the store says otherwise
    }

    // Speed: a paused or returning robot goes home at a steady, unhurried pace.
    const speed = this.status === 'returning' ? 0.24 : (DRIVE[this.speed] ?? DRIVE.standard);
    if (!this.target) this.target = this.pickWaypoint();

    const dx = this.target.x - this.x;
    const dz = this.target.z - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.06) {
      this.target = null;
      if (this.status === 'returning') {
        // Dock reached: sit on it and let the store hear about it.
        this.x = this.cfg.pos?.[0] ?? this.x;
        this.z = this.cfg.pos?.[1] ?? this.z;
        this.heading = THREE.MathUtils.degToRad(this.cfg.rot || 0);
        this.write();
        this.onDocked?.();
        return false;
      }
      this.wait = 0.4 + ((this.clock * 7.3) % 1) * 0.7;    // a short pause, then a new waypoint
    }

    if (this.wait > 0) {
      this.wait -= dt;
      this.write();
      return true;
    }

    if (this.target) {
      // Turn towards the waypoint first, then drive: a robot vacuum never slides sideways.
      const want = Math.atan2(dx, dz);
      let diff = ((want - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const turn = Math.min(Math.abs(diff), dt * 2.2);
      this.heading += Math.sign(diff) * turn;
      // Only drive once roughly pointed the right way.
      if (Math.abs(diff) < 0.5) {
        const step = Math.min(dist, speed * dt);
        this.x += Math.sin(this.heading) * step;
        this.z += Math.cos(this.heading) * step;
      }
      this.brushAngle += dt * (speed === DRIVE.max ? 26 : 18);
    }

    this.group.position.x = this.x;
    this.group.position.z = this.z;
    this.chassis.rotation.y = this.heading;
    this.brush.rotation.y = this.brushAngle;
    const ring = RING[this.status] || RING.docked;
    this.ring.material.color.set(ring);
    this.ring.material.emissive.set(ring);
    this.ring.material.emissiveIntensity = 1.1;
    return true;
  }

  /** A waypoint inside the room, kept away from where it just was. */
  pickWaypoint() {
    const a = this.area;
    if (!a) return { x: this.x, z: this.z };
    for (let i = 0; i < 6; i++) {
      const x = a.minX + Math.random() * (a.maxX - a.minX);
      const z = a.minZ + Math.random() * (a.maxZ - a.minZ);
      if (Math.hypot(x - this.x, z - this.z) > 0.5) return { x, z };
    }
    return { x: (a.minX + a.maxX) / 2, z: (a.minZ + a.maxZ) / 2 };
  }
}
