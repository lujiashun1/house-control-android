// A motorised drying rack: a ceiling-mounted frame that rises and falls like a
// Home Assistant `cover` — position 1 is fully lowered, 0 is up against the ceiling.
import * as THREE from 'three';

const METAL = '#cfd6df';   // anodised aluminium bars
const DARK = '#6f7a88';    // motors and end caps
const CABLE = '#9aa3ae';
const CEILING = 2.62;      // the house's wall height, where the mount sits
const RISE = 1.30;         // how far the frame travels from the ceiling

const box = (w, h, d, color) => new THREE.Mesh(
  new THREE.BoxGeometry(w, h, d),
  new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.35 }),
);

export class RackUnit {
  constructor(cfg) {
    this.cfg = cfg;
    this.pct = 0.15;             // where the frame is, 0…1
    this.target = 0.15;          // where the model says it should be
    this.width = cfg.width ?? 1.6;
    this.top = (cfg.top ?? CEILING);
    this.lift = cfg.lift ?? RISE;

    this.group = new THREE.Group();
    this.group.position.set(cfg.pos[0], 0, cfg.pos[1]);
    this.group.rotation.y = (cfg.rot || 0) * Math.PI / 180;

    // The mount: two motor housings bolted to the ceiling, and the cables they wind.
    this.group.add(
      box(this.width + 0.12, 0.035, 0.15, DARK).translateY(this.top - 0.018),
      box(0.26, 0.10, 0.13, DARK).translateY(this.top - 0.07).translateX(-this.width / 2 + 0.2),
      box(0.26, 0.10, 0.13, DARK).translateY(this.top - 0.07).translateX(this.width / 2 - 0.2),
    );

    // The frame rides in its own group so the cables can stretch with it.
    this.frame = new THREE.Group();
    const depth = 0.52;
    const bar = (w, d, x, z) => box(w, 0.028, d, METAL).translateX(x).translateZ(z);
    this.frame.add(
      bar(this.width, 0.032, 0, -depth / 2),
      bar(this.width, 0.032, 0, depth / 2),
      bar(0.032, depth, -this.width / 2, 0),
      bar(0.032, depth, this.width / 2, 0),
      // Six studs to hang clothes from.
      ...[-2, -1, 0, 1, 2].map((i) => {
        const x = (i / 2) * (this.width / 2 - 0.08);
        return new THREE.Mesh(
          new THREE.CylinderGeometry(0.018, 0.018, 0.10, 8),
          new THREE.MeshStandardMaterial({ color: METAL, roughness: 0.4, metalness: 0.4 }),
        ).translateY(-0.062).translateX(x);
      }),
    );
    this.group.add(this.frame);

    // Four cables, each stretched from the mount down to its corner of the frame.
    const cable = () => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.008, 1, 6).translate(0, -0.5, 0),
        new THREE.MeshStandardMaterial({ color: CABLE, roughness: 0.6, metalness: 0.2 }),
      );
      this.group.add(mesh);
      return mesh;
    };
    this.cables = [
      { mesh: cable(), x: -this.width / 2 + 0.06, z: -depth / 2 + 0.03 },
      { mesh: cable(), x: this.width / 2 - 0.06, z: -depth / 2 + 0.03 },
      { mesh: cable(), x: -this.width / 2 + 0.06, z: depth / 2 - 0.03 },
      { mesh: cable(), x: this.width / 2 - 0.06, z: depth / 2 - 0.03 },
    ];
    for (const c of this.cables) {
      c.mesh.position.set(c.x, this.top - 0.03, c.z);
    }

    // The hit box covers the whole travel, so the frame is easy to pick at any height.
    this.hit = new THREE.Mesh(
      new THREE.BoxGeometry(this.width + 0.2, this.lift + 0.24, 0.9),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.hit.position.set(0, this.top - (this.lift + 0.24) / 2, 0);
    this.hit.userData = { kind: 'rack', id: cfg.id };
    this.group.add(this.hit);

    this.write();
  }

  frameY() {
    return this.top - 0.13 - this.lift * this.pct;
  }

  /** Re-draw from `pct`: the frame's height and each cable's stretched length. */
  write() {
    const y = this.frameY();
    this.frame.position.y = y;
    for (const c of this.cables) c.mesh.scale.y = Math.max(0.02, this.top - 0.03 - y);
  }

  apply(state, { instant = false } = {}) {
    if (!state) return;
    const target = Math.max(0, Math.min(1, state.open ?? this.target));
    if (Math.abs(target - this.target) < 0.001) return;
    this.target = target;
    if (instant) { this.pct = target; this.write(); }
  }

  update(dt) {
    const diff = this.target - this.pct;
    if (Math.abs(diff) < 0.002) {
      if (this.pct !== this.target) { this.pct = this.target; this.write(); }
      return false;
    }
    // A motorised rack takes a few seconds end to end: it moves at a steady pace.
    this.pct += Math.sign(diff) * Math.min(Math.abs(diff), dt * 0.42);
    this.write();
    return true;
  }

  /** Where the frame hangs, in world space — the panel anchors its tooltip there. */
  anchor(out) {
    return out.set(0, this.frameY(), 0).applyMatrix4(this.group.matrixWorld);
  }

  get lowered() { return this.pct; }
  get moving() { return Math.abs(this.target - this.pct) > 0.002; }
}
