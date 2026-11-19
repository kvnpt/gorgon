// Gorgon — letterbox: a slit of the scan pinned above the score
// GPL-3.0
//
// For scans the line cutter can't cut well (handwriting that wanders, a page
// with ornaments, uneven spacing), the scan is not cut at all. A slit of it,
// one line high, stays above the score while you write; you move it along
// the page as you go:
//   drag in the slit       moves the page under it (up/down, and sideways
//                          when zoomed in);
//   pinch, or the zoom pill  1×, 1.5×, 2×, 3×;
//   ▼ / ▲                   the next / previous line: one slit further,
//                          settled on the emptiest row nearby, so the slit
//                          lands between two lines of the page;
//   the bar at its foot     makes the slit taller or shorter.
//
// Where things live: score.scan.view = 'letterbox' and
// score.scan.slit = { y, h, z, x } in units of a page's width (the pages are
// stacked one under the other, each scaled to the slit's width): y is the
// top of the slit, h its height, z the zoom, x the left edge when zoomed.
// Kept in the score, so the place is kept and synced like the rest.

import { pageUrl } from './scan.js';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ZOOMS = [1, 1.5, 2, 3];
const MIN_PX = 36;            // the slit is never shorter than this on screen
const MAX_Z = 4;

/** Where a new letterbox starts: on the first music, about a line high */
export function defaultSlit(pages) {
  const p = pages?.[0];
  if (!p) return { y: 0, h: 0.18, z: 1, x: 0 };
  // The line spacing the cutter found, if it found a sensible one
  const cuts = [...(p.cuts || [])].sort((a, b) => a - b);
  const gaps = cuts.slice(1).map((y, i) => y - cuts[i]).filter(g => g > 8).sort((a, b) => a - b);
  let h = gaps.length >= 3 ? gaps[gaps.length >> 1] / p.w * 1.1 : 0.18;
  if (!(h >= 0.1 && h <= 0.3)) h = 0.18;
  const top = p.musicTop ? Math.max(0, p.musicTop / p.w - h * 0.15) : 0;
  return { y: round(top), h: round(h), z: 1, x: 0 };
}

const round = (v) => Math.round(v * 10000) / 10000;

let root = null;
let view = null;
let track = null;
let scan = null;
let onChange = () => {};
let onSheet = () => {};
let shown = false;
const ink = new Map();         // page id -> { w, h, lum } small greyscale copy, for ▲▼

/**
 * Show (or hide) the letterbox for this scan. Called after every render:
 * cheap when nothing changed.
 */
export function updateLetterbox(sc, { visible, changed, sheet }) {
  onChange = changed || onChange;
  onSheet = sheet || onSheet;
  if (!root) build();
  scan = sc;
  shown = !!(visible && sc?.pages?.length);
  root.hidden = !shown;
  document.body.classList.toggle('letterbox-on', shown);
  if (!shown) return;
  if (!sc.slit) sc.slit = { ...defaultSlit(sc.pages), fresh: 1 };
  const want = sc.pages.map(p => `${p.id}:${pageUrl(p.id) ? 1 : 0}`).join(',');
  if (track.dataset.pages !== want) {
    track.dataset.pages = want;
    track.innerHTML = sc.pages.map((p, i) => {
      const url = pageUrl(p.id);
      return url
        ? `<img src="${esc(url)}" data-lb-page="${i}" alt="Page ${i + 1} of the scan" draggable="false" style="aspect-ratio:${p.w} / ${p.h}">`
        : `<div class="lb-missing" style="aspect-ratio:${p.w} / ${p.h}"><span>Page ${i + 1} is not on this device</span></div>`;
    }).join('');
    // A new letterbox finds its line once its pictures are in
    track.querySelectorAll('img').forEach(img => img.addEventListener('load', settle, { once: true }));
  }
  settle();
}

function settle() {
  const s = scan?.slit;
  if (s?.fresh && frame(true)) { delete s.fresh; place(true); onChange(); return; }
  place();
}

// The stacked pages' height, in page widths
const total = () => (scan?.pages || []).reduce((s, p) => s + p.h / p.w, 0);
const width = () => view.clientWidth || 1;

/**
 * Draw the slit, kept in bounds. Only a move made here (keep) writes the
 * bounds back into the score: a smaller screen showing the slit shorter
 * does not change it, so opening the score elsewhere changes nothing.
 */
let shownH = 0;
function place(keep = false) {
  if (!shown) return;
  const s = scan.slit;
  const W = width();
  const z = Math.max(1, Math.min(MAX_Z, s.z || 1));
  const maxPx = Math.max(MIN_PX, maxHeight());
  const h = Math.max(MIN_PX / (W * z), Math.min(maxPx / (W * z), s.h || 0.18));
  const x = Math.max(0, Math.min(1 - 1 / z, s.x || 0));
  const y = Math.max(-h * 0.5, Math.min(total() - h * 0.5, s.y || 0));
  if (keep) {
    s.z = round(z); s.x = round(x); s.y = round(y);
    s.h = round(s.h || h);
  }
  shownH = h;
  const k = W * z;              // px per page width
  view.style.height = `${Math.round(h * k)}px`;
  track.style.width = `${k}px`;
  track.style.transform = `translate(${-x * k}px, ${-y * k}px)`;
  const pill = root.querySelector('[data-lb-zoom]');
  const label = `${Math.round(z * 10) / 10}×`;
  if (pill.textContent !== label) pill.textContent = label;
}

// At most about two fifths of the screen (less with the keyboard up)
function maxHeight() {
  const H = window.visualViewport?.height || window.innerHeight;
  return H * (document.body.classList.contains('keyboard-open') ? 0.25 : 0.4);
}

function build() {
  root = document.createElement('div');
  root.id = 'letterbox';
  root.className = 'letterbox';
  root.hidden = true;
  root.innerHTML = `
    <div class="lb-view" role="img" aria-label="The scan, one line at a time: drag to move it, pinch to zoom">
      <div class="lb-track"></div>
    </div>
    <div class="lb-bar" title="Drag here to make the slit taller or shorter">
      <button type="button" class="lb-btn" data-lb-step="-1" title="Previous line" aria-label="Previous line"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 10 8 5.5 12.5 10"/></svg></button>
      <button type="button" class="lb-btn" data-lb-step="1" title="Next line" aria-label="Next line"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6"/></svg></button>
      <span class="lb-grip" aria-hidden="true"></span>
      <button type="button" class="lb-btn lb-zoom" data-lb-zoom title="Zoom" aria-label="Zoom">1×</button>
      <button type="button" class="lb-btn" data-lb-more title="The scan: view, pages, remove" aria-label="Scan options">⋯</button>
    </div>`;
  view = root.querySelector('.lb-view');
  track = root.querySelector('.lb-track');
  const main = document.getElementById('score-area');
  main.parentNode.insertBefore(root, main);

  root.querySelector('.lb-bar').addEventListener('click', (e) => {
    const b = e.target.closest('.lb-btn');
    if (!b || !scan?.slit) return;
    if (b.dataset.lbStep) step(+b.dataset.lbStep);
    else if (b.hasAttribute('data-lb-zoom')) {
      const s = scan.slit;
      const next = ZOOMS.find(z => z > s.z + 0.01) || 1;
      zoomAbout(next, width() / 2);
    } else if (b.hasAttribute('data-lb-more')) { onSheet(); return; }
    place(true);
    onChange();
  });

  // Drag to move, pinch to zoom
  const pts = new Map();
  let pinch = null;
  view.addEventListener('pointerdown', (e) => {
    if (!scan?.slit) return;
    e.preventDefault();
    view.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch = null;
    view.classList.add('dragging');
  });
  view.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const s = scan.slit;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const [c, d] = [...pts.values()];
      const after = Math.hypot(c.x - d.x, c.y - d.y);
      const r = view.getBoundingClientRect();
      if (!pinch) pinch = true;
      if (before > 10) zoomAbout(s.z * after / before, (c.x + d.x) / 2 - r.left);
    } else {
      const k = width() * s.z;
      s.x -= (e.clientX - p.x) / k;
      s.y -= (e.clientY - p.y) / k;
      p.x = e.clientX; p.y = e.clientY;
    }
    place(true);
  });
  const up = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (!pts.size) { view.classList.remove('dragging'); onChange(); }
  };
  view.addEventListener('pointerup', up);
  view.addEventListener('pointercancel', up);
  // A mouse wheel or trackpad scrolls the page under the slit
  view.addEventListener('wheel', (e) => {
    if (!scan?.slit) return;
    e.preventDefault();
    const s = scan.slit;
    const k = width() * s.z;
    if (e.ctrlKey) zoomAbout(s.z * Math.exp(-e.deltaY / 200), e.offsetX);
    else { s.y += e.deltaY / k; s.x += e.deltaX / k; }
    place(true);
    clearTimeout(view._wheel);
    view._wheel = setTimeout(() => onChange(), 400);
  }, { passive: false });

  // The grip: the slit's height
  const grip = root.querySelector('.lb-bar');
  let g = null;
  grip.addEventListener('pointerdown', (e) => {
    if (!scan?.slit || e.target.closest('.lb-btn')) return;
    e.preventDefault();
    grip.setPointerCapture?.(e.pointerId);
    g = { y: e.clientY, h: scan.slit.h };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!g) return;
    e.preventDefault();
    scan.slit.h = g.h + (e.clientY - g.y) / (width() * scan.slit.z);
    place();
  });
  // Kept as tall as it shows: no taller than the screen allows
  const gripEnd = () => { if (g) { g = null; scan.slit.h = round(shownH); place(true); onChange(); } };
  grip.addEventListener('pointerup', gripEnd);
  grip.addEventListener('pointercancel', gripEnd);

  window.addEventListener('resize', () => place());
  window.visualViewport?.addEventListener('resize', () => place());
}

// Zoom to z, keeping the point of the page at x = mx in the slit where it
// is. The slit shows the same band of the page, taller (up to its limit),
// so a line stays whole as it grows.
function zoomAbout(z, mx) {
  const s = scan.slit;
  const W = width();
  z = Math.max(1, Math.min(MAX_Z, z));
  const px = s.x + mx / (W * s.z);
  s.x = px - mx / (W * z);
  s.z = z;
}

// One line on (or back). Lines of a score look alike: the marks over the
// neumes, the neumes, the words under them. So the slit moves to where the
// page's ink, row by row, looks most like what it shows now, framed the way
// this line is framed; near one line spacing on (the page's, found by
// autocorrelation), allowing for a wider gap or a tighter one.
function step(dir) {
  const s = scan.slit;
  if (!s.pitch) frame(false);
  const guess = s.pitch || s.h;
  const prof = profile(s.x, s.x + 1 / s.z);
  const got = prof && bestMatch(prof, s.y, s.h, dir, guess);
  s.y = got ?? s.y + dir * guess;
}

// The page's line spacing (autocorrelation of its ink, row by row) and, the
// first time, a slit one line high on the first line of music
function frame(place1) {
  const s = scan.slit;
  const prof = profile(0, 1);
  if (!prof) return false;
  const n = prof.length;
  const m = prof.reduce((x, v) => x + v, 0) / n;
  const d = prof.map(v => v - m);
  let best = 0;
  let pitch = 0;
  const ac = [];
  for (let L = Math.round(0.03 * RES); L <= Math.round(0.35 * RES) && L < n / 2; L++) {
    let v = 0;
    for (let i = 0; i + L < n; i++) v += d[i] * d[i + L];
    ac[L] = v / (n - L);
  }
  // The first lag that is a peak and nearly as strong as the strongest
  const lags = Object.keys(ac).map(Number);
  for (const L of lags) if (ac[L] > best) best = ac[L];
  for (const L of lags) {
    if (ac[L] >= best * 0.8 && ac[L] >= (ac[L - 1] ?? -Infinity) && ac[L] >= (ac[L + 1] ?? -Infinity)) { pitch = L / RES; break; }
  }
  if (!(pitch > 0)) return false;
  s.pitch = round(pitch);
  if (!place1) return true;
  // A line of handwriting reaches into the next (the marks over its
  // neumes, the words under them): the slit is a little over a line high,
  // with the first row of neumes (the first strong row of ink from where
  // the music starts) just under its middle
  s.h = round(pitch * 1.4);
  const p0 = scan.pages[0];
  const top = Math.round((p0?.musicTop ? p0.musicTop / p0.w : 0) * RES);
  const P = Math.round(pitch * RES);
  let peak = 0;
  for (let y = top; y < Math.min(n, top + P * 1.2); y++) peak = Math.max(peak, prof[y]);
  let at = top + Math.round(P * 0.75);
  for (let y = top; y < Math.min(n, top + P * 1.2); y++) {
    if (prof[y] >= peak * 0.85 && prof[y] >= (prof[y - 1] ?? 0) && prof[y] >= (prof[y + 1] ?? 0)) { at = y; break; }
  }
  at = Math.max(0, at - Math.round(P * 0.75));
  s.y = round(at / RES);
  return true;
}

const RES = 200;              // profile rows per page width

// Ink per row down the stacked pages, in the columns [x0, x1] (page widths)
function profile(x0, x1) {
  const rows = [];
  for (const p of scan.pages) {
    const im = inkOf(p);
    if (!im) return null;
    const c0 = Math.max(0, Math.floor(x0 * im.w));
    const c1 = Math.min(im.w, Math.ceil(x1 * im.w));
    const n = Math.round(im.h / im.w * RES);
    for (let r = 0; r < n; r++) {
      const ir = Math.min(im.h - 1, Math.floor(r * im.w / RES));
      let v = 0;
      for (let c = c0; c < c1; c++) v += im.lum[ir * im.w + c];
      rows.push(v);
    }
  }
  // Smoothed a little, so a stroke a row off still matches
  return rows.map((_, i) => {
    let v = 0;
    for (let j = -2; j <= 2; j++) v += rows[Math.max(0, Math.min(rows.length - 1, i + j))];
    return v / 5;
  });
}

function bestMatch(prof, y, h, dir, guess) {
  const a = Math.round(y * RES);
  const L = Math.max(4, Math.round(h * RES));
  const at = (i) => (i >= 0 && i < prof.length ? prof[i] : 0);
  const tpl = Array.from({ length: L }, (_, i) => at(a + i));
  const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
  const mt = mean(tpl);
  const st = Math.sqrt(tpl.reduce((x, v) => x + (v - mt) ** 2, 0));
  if (st <= 0) return null;     // nothing on show to go by
  const g = Math.round(guess * RES);
  let best = null;
  let bestScore = -Infinity;
  for (let d = Math.round(g * 0.7); d <= Math.round(g * 1.35); d++) {
    const b = a + dir * d;
    if (b + L < 0 || b > prof.length) continue;
    const cand = Array.from({ length: L }, (_, i) => at(b + i));
    const mc = mean(cand);
    let num = 0;
    let sc = 0;
    for (let i = 0; i < L; i++) { num += (tpl[i] - mt) * (cand[i] - mc); sc += (cand[i] - mc) ** 2; }
    if (sc <= 0) continue;
    // Alike, and not far from the length expected
    const score = num / (st * Math.sqrt(sc)) - 0.3 * Math.abs(d - g) / g;
    if (score > bestScore) { bestScore = score; best = b / RES; }
  }
  return best;
}

// A small greyscale copy of a page (300 px wide): darkness per pixel, 0–255
function inkOf(p) {
  if (ink.has(p.id)) return ink.get(p.id);
  const img = track.querySelector(`img[data-lb-page="${scan.pages.indexOf(p)}"]`);
  if (!img?.complete || !img.naturalWidth) return null;
  const w = 300;
  const h = Math.max(1, Math.round(w * p.h / p.w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = new Uint8Array(w * h);
  for (let i = 0, q = 0; q < w * h; i += 4, q++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    lum[q] = v < 170 ? 255 - v : 0;           // ink only, paper counts nothing
  }
  const got = { w, h, lum };
  ink.set(p.id, got);
  return got;
}

/** ▼ / ▲ from elsewhere (the Line button over the pad) */
export function stepLetterbox(dir) {
  if (!shown || !scan?.slit) return;
  step(dir);
  place(true);
  onChange();
}
