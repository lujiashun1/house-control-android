import { haptic } from '../bridge.js';

// Minimal hyperscript helper: h('div.class', { onclick, style, ... }, ...children)
export function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (props instanceof Node || typeof props !== 'object' || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'vars') for (const [name, val] of Object.entries(v)) el.style.setProperty(name, val);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Horizontal slider with a gradient fill that reveals under a chunky thumb.
// `detent` is how far the value travels between two haptic ticks on a phone.
export function createSlider({ min, max, step = 1, value, gradient, compact = false, labels, onInput, detent = step }) {
  const fill = h('div.slider-fill');
  const thumb = h('div.slider-thumb');
  const track = h('div.slider-track', { vars: { '--gradient': gradient } }, fill, thumb);
  const el = h(`div.slider${compact ? '.compact' : ''}`, track,
    labels ? h('div.slider-scale', h('span', labels[0]), h('span', labels[1])) : null);

  let current = value;
  let notch = Math.round(value / detent);
  const input = (next) => {
    current = next;
    paint();
    const at = Math.round(next / detent);
    if (at !== notch) { notch = at; haptic('tick'); }
    onInput(current);
  };
  const paint = () => {
    el.style.setProperty('--p', String(clamp((current - min) / (max - min), 0, 1)));
  };
  new ResizeObserver(() => el.style.setProperty('--track-w', `${track.clientWidth}px`)).observe(track);

  const fromEvent = (ev) => {
    const r = track.getBoundingClientRect();
    const size = r.height; // the thumb is square
    const p = clamp((ev.clientX - r.left - size / 2) / (r.width - size), 0, 1);
    const raw = min + p * (max - min);
    return clamp(Math.round(raw / step) * step, min, max);
  };

  // Horizontal drag changes the value; a mostly vertical drag belongs to the sheet's
  // scroll, so it must not capture the pointer or nudge the value on the way up.
  let gesture = null;
  track.addEventListener('pointerdown', (ev) => {
    gesture = { x: ev.clientX, y: ev.clientY, dragging: false };
  });
  track.addEventListener('pointermove', (ev) => {
    if (!gesture) return;
    const dx = ev.clientX - gesture.x;
    const dy = ev.clientY - gesture.y;
    if (!gesture.dragging) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { gesture = null; return; }
      if (Math.abs(dx) < 5) return;
      gesture.dragging = true;
      try { track.setPointerCapture(ev.pointerId); } catch { /* capture is a nicety */ }
      el.classList.add('dragging');
    }
    const next = fromEvent(ev);
    if (next !== current) input(next);
  });
  const end = (ev) => {
    if (!gesture) return;
    // A tap (no drag) still moves the thumb to the touched point.
    if (ev.type === 'pointerup' && !gesture.dragging) {
      const next = fromEvent(ev);
      if (next !== current) input(next);
    }
    gesture = null;
    el.classList.remove('dragging');
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', () => { gesture = null; el.classList.remove('dragging'); });

  paint();
  return {
    el,
    set(v) { if (v !== current && !el.classList.contains('dragging')) { current = v; notch = Math.round(v / detent); paint(); } },
  };
}

// Popup menu anchored to an element, opening upwards (the tiles sit at the bottom of the card).
export function openMenu(host, anchor, items, { onClose } = {}) {
  const menu = h('div.menu');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    menu.classList.add('closing');
    setTimeout(() => menu.remove(), 150);
    onClose?.();
  };
  const outside = (ev) => {
    if (menu.contains(ev.target)) return;
    if (anchor.contains(ev.target)) ev.stopPropagation(); // the click that would re-open it
    close();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };

  for (const item of items) {
    if (item === '-') { menu.append(h('hr')); continue; }
    menu.append(h(`button${item.selected ? '.selected' : ''}`, {
      onclick: () => { close(); item.action(); },
    }, h('span', item.label), item.icon));
  }

  host.append(menu);
  const hr = host.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const below = ar.top - hr.top < mh + 16;
  const left = clamp(ar.right - hr.left - mw, 10, hr.width - mw - 10);
  menu.style.left = `${left}px`;
  menu.style.top = below ? `${ar.bottom - hr.top + 8}px` : `${ar.top - hr.top - mh - 8}px`;
  const ox = clamp(((ar.left + ar.width / 2 - hr.left - left) / mw) * 100, 10, 90);
  menu.style.setProperty('--origin', `${ox}% ${below ? '0%' : '100%'}`);

  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return close;
}

/* ---------- colour helpers + picker ---------- */

export function hexToHsv(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (Number.isNaN(n)) return null;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { h: hue, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex(hue, s, v = 1) {
  const f = (k) => {
    const x = (k + hue / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(x, 4 - x, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

// Hue runs left to right, saturation fades towards white at the bottom.
// Brightness is not part of the pad: the lamp's own brightness slider owns it.
const PAD_MIN_SAT = 0.12;

export function createColorPad({ value, onInput }) {
  const thumb = h('div.pad-thumb');
  const el = h('div.pad', { role: 'slider', tabindex: 0, 'aria-label': 'Colour' }, thumb);
  let dragging = false;

  const place = (x, y, hex) => {
    el.classList.remove('empty');
    thumb.style.left = `${x * 100}%`;
    thumb.style.top = `${y * 100}%`;
    thumb.style.background = hex;
  };
  const show = (hex) => {
    const c = hex && hexToHsv(hex);
    if (!c) { el.classList.add('empty'); return; }
    place(c.h / 360, clamp((1 - c.s) / (1 - PAD_MIN_SAT), 0, 1), hsvToHex(c.h, c.s, 1));
  };
  const pick = (ev) => {
    const r = el.getBoundingClientRect();
    const x = clamp((ev.clientX - r.left) / r.width, 0, 1);
    const y = clamp((ev.clientY - r.top) / r.height, 0, 1);
    const hex = hsvToHex(Math.min(359.9, x * 360), 1 - y * (1 - PAD_MIN_SAT), 1);
    place(x, y, hex);
    onInput(hex);
  };

  // The pad sits at the bottom of the sheet. While there is still content below the fold, a
  // mostly vertical drag on it scrolls the sheet instead of picking a colour; once the sheet
  // is at the end, the same drag picks hue/saturation as usual.
  let gesture = null;
  el.addEventListener('pointerdown', (ev) => {
    try { el.setPointerCapture(ev.pointerId); } catch { /* capture is a nicety, not a requirement */ }
    const sheet = el.closest('.sheet');
    gesture = { x: ev.clientX, y: ev.clientY, mode: null, sheet, top: sheet ? sheet.scrollTop : 0 };
  });
  el.addEventListener('pointermove', (ev) => {
    if (!gesture) return;
    const dx = ev.clientX - gesture.x;
    const dy = ev.clientY - gesture.y;
    if (!gesture.mode) {
      const sheet = gesture.sheet;
      const max = sheet ? sheet.scrollHeight - sheet.clientHeight : 0;
      if (sheet && max > 0 && gesture.top < max - 1 && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        gesture.mode = 'scroll';
      } else if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        gesture.mode = 'pick';
        dragging = true;
        el.classList.add('dragging');
      } else return;
    }
    if (gesture.mode === 'scroll') {
      gesture.sheet.scrollTop = clamp(gesture.top - dy, 0, gesture.sheet.scrollHeight - gesture.sheet.clientHeight);
      return;
    }
    pick(ev);
  });
  const end = (ev) => {
    if (!gesture) return;
    if (ev.type === 'pointerup' && !gesture.mode) pick(ev); // a tap is a colour, not a scroll
    gesture = null;
    dragging = false;
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { gesture = null; dragging = false; el.classList.remove('dragging'); });
  el.addEventListener('keydown', (ev) => {
    const step = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[ev.key];
    if (!step) return;
    ev.preventDefault();
    const x = clamp((parseFloat(thumb.style.left) || 0) / 100 + step[0], 0, 1);
    const y = clamp((parseFloat(thumb.style.top) || 0) / 100 + step[1], 0, 1);
    const hex = hsvToHex(Math.min(359.9, x * 360), 1 - y * (1 - PAD_MIN_SAT), 1);
    place(x, y, hex);
    onInput(hex);
  });

  show(value);
  return { el, set(hex) { if (!dragging) show(hex); } };
}
