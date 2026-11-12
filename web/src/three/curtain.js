// A pair of pleated curtain panels hanging from a rod. They gather to the sides as they open,
// and the cloth is a translucent material whose colour and opacity the panel sets. The set is
// freely placed (no wall snapping) and its width can be changed while the home runs.
import * as THREE from 'three';
import { box, cyl, mat } from './kit.js';

// Old plans stored a wall instead of an angle; keep reading them, but positions are free now.
const WALL_ROT = { north: 0, south: Math.PI, west: Math.PI / 2, east: -Math.PI / 2 };

const ROD_Z = 0.10;   // how far the rod stands off the cloth's hanging line, metres
const PLEATS = 5;     // folds across the full width
const FOLD = 0.055;   // half depth of one fold
const GATHER = 0.12;  // how narrow a panel gets when fully open

export const CURTAIN_MIN_WIDTH = 0.4;
export const CURTAIN_MAX_WIDTH = 8;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** A pleated panel one metre wide and `drop` tall; the folds run along its width. */
function panelGeometry(drop) {
  const cols = PLEATS * 8;
  const rows = 10;
  const pos = [];
  const idx = [];
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    const y = -v * drop;
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      // Folds open out a little towards the hem, the way cloth does under its own weight.
      const z = FOLD * (0.82 + 0.3 * v) * Math.sin(u * PLEATS * Math.PI * 2);
      pos.push(u, y, z);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export class CurtainUnit {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.color = cfg.color;
    this.open = clamp(cfg.open, 0, 1);
    this.openGoal = this.open;
    this.opacity = clamp(cfg.opacity, 0.06, 1);
    this.opacityGoal = this.opacity;
    this.width = clamp(cfg.width ?? 2, CURTAIN_MIN_WIDTH, CURTAIN_MAX_WIDTH);
    this.drop = cfg.height ?? 2.2;
    // `rot` is the angle the set is turned to, in degrees; plans written before this field
    // existed carry a wall instead, which still resolves to the same angle.
    this.rot = Number.isFinite(cfg.rot)
      ? cfg.rot
      : ((WALL_ROT[cfg.wall] ?? 0) * 180) / Math.PI;

    this.group = new THREE.Group();
    this.group.position.set(cfg.pos[0], cfg.top ?? 2.35, cfg.pos[1]);
    this.group.rotation.y = THREE.MathUtils.degToRad(this.rot);

    // Semi-transparent and double sided: a sheer curtain is seen from both sides. One material
    // is kept for the unit's life, so a rebuild (a width change) does not lose its colour.
    this.cloth = new THREE.MeshStandardMaterial({
      color: cfg.color,
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: this.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.build();
  }

  /** (Re)builds the rod, the two panels and the picking box for the current width. */
  build() {
    for (const child of this.group.children) {
      child.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material !== this.cloth) o.material.dispose();
      });
    }
    this.group.clear();

    /* ---------- rod ---------- */
    const metal = mat('#cfd3da', { rough: 0.38, metal: 0.7 });
    const len = this.width + 0.12;
    // `cyl` stands on y = 0; laid on its side it spans x = [-len/2, len/2] once offset.
    this.rod = cyl(0.016, 0.016, len, metal, 18);
    this.rod.rotation.z = Math.PI / 2;
    this.rod.position.set(len / 2, 0, ROD_Z);
    this.group.add(this.rod);
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 10), metal);
      cap.position.set(s * len / 2, 0, ROD_Z);
      const arm = box(0.028, 0.028, ROD_Z + 0.012, metal, { r: 0.008 });
      arm.position.set(s * (this.width / 2 - 0.02), -0.014, (ROD_Z + 0.012) / 2);
      this.group.add(cap, arm);
    }

    /* ---------- cloth ---------- */
    const geo = panelGeometry(this.drop);
    // Left panel grows rightwards from the left end of the rod; the right one is turned round,
    // which keeps its winding (and its lighting) correct instead of mirroring it with a scale.
    this.panels = [-1, 1].map((side) => {
      const panel = new THREE.Mesh(geo, this.cloth);
      panel.position.set(side * this.width / 2, 0, ROD_Z + 0.035);
      panel.rotation.y = side < 0 ? 0 : Math.PI;
      panel.receiveShadow = true;
      panel.castShadow = false;
      this.group.add(panel);
      return panel;
    });

    // One picking box per panel, not one across the whole opening: when the curtain is drawn
    // the cloth gathers at the ends, and a tap in the empty middle has to reach whatever stands
    // behind it. Each box is a unit width here and stretched in `layout()` with the cloth.
    this.hits = [-1, 1].map((side) => {
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(1, this.drop, 0.34),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.set(0, -this.drop / 2, ROD_Z + 0.02);
      hit.userData = { kind: 'curtain', id: this.cfg.id, side };
      this.group.add(hit);
      return hit;
    });

    // Last, so the boxes are already there when the cloth is placed for the current opening.
    this.layout();
  }

  /** Places both panels for the current opening: gathered cloth is narrower and thicker. */
  layout() {
    const span = this.width / 2 * (GATHER + (1 - this.open) * (1 - GATHER));
    this.panels[0].scale.x = span;
    this.panels[1].scale.x = span;
    this.panels[1].position.z = ROD_Z + 0.035 + this.open * 0.022;
    // The picking boxes follow the cloth, so the drawn-open middle is left clickable for the
    // furniture and devices behind it.
    if (this.hits) {
      for (const [i, hit] of this.hits.entries()) {
        const side = i === 0 ? -1 : 1;
        hit.scale.x = span;
        hit.position.x = side * (this.width - span) / 2;
      }
    }
  }

  /** Changes the span of the opening, keeping the panels, their draw and the cloth colour. */
  setWidth(width) {
    const next = clamp(Number(width) || this.width, CURTAIN_MIN_WIDTH, CURTAIN_MAX_WIDTH);
    if (Math.abs(next - this.width) < 1e-3) return false;
    this.width = next;
    this.cfg.width = next;
    this.build();
    return true;
  }

  apply(state = {}, { instant = false } = {}) {
    if (!state) return;
    if (Number.isFinite(state.width)) this.setWidth(state.width);
    if (Number.isFinite(state.open)) this.openGoal = clamp(state.open, 0, 1);
    if (Number.isFinite(state.opacity)) this.opacityGoal = clamp(state.opacity, 0.06, 1);
    if (typeof state.color === 'string' && state.color !== this.color) {
      this.color = state.color;
      this.cloth.color.set(state.color);
    }
    if (instant) {
      this.open = this.openGoal;
      this.opacity = this.opacityGoal;
      this.cloth.opacity = this.opacity;
      this.layout();
    }
  }

  /** Pulls towards the target opening and opacity; true while anything still has to move. */
  update(dt) {
    let active = false;
    const ease = 1 - Math.exp(-dt * 8);

    const d = this.openGoal - this.open;
    if (Math.abs(d) > 0.001) { this.open += d * ease; active = true; }
    else if (this.open !== this.openGoal) { this.open = this.openGoal; active = true; }

    const od = this.opacityGoal - this.opacity;
    if (Math.abs(od) > 0.001) { this.opacity += od * ease; active = true; }
    else if (this.opacity !== this.opacityGoal) { this.opacity = this.opacityGoal; active = true; }

    if (this.cloth.opacity !== this.opacity) this.cloth.opacity = this.opacity;
    if (active) this.layout();
    return active;
  }

  anchor(out) {
    return out.set(0, -this.drop * 0.4, ROD_Z + 0.04).applyMatrix4(this.group.matrixWorld);
  }

  /** How open it is, 0-100, for the panel. */
  get openPercent() {
    return Math.round(this.open * 100);
  }
}
