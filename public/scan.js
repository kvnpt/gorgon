// Gorgon — transcription mode: a scanned score beside the transcription
// GPL-3.0
//
// A scan (photos or a PDF of a printed or handwritten score) is cut into its
// lines, and each line of the scan is shown above the notes written for it,
// so the two can be read one against the other and corrected with the pad.
//
// Where things live:
//   score.scan = { pages: [{ id, w, h }], lines: [{ page, y0, y1 }] }
//     in the score itself (saved and synced like the rest);
//   { type: 'scanline', line: k } elements in score.elements, where line k
//     of the scan starts (app.js). They draw nothing outside transcription
//     mode and never print, so the score reflows as usual;
//   the page pictures, in this browser's IndexedDB (gorgon-scans), by page
//     id. They stay on the device that imported them: another device shows
//     the lines as blank strips.

const DB_NAME = 'gorgon-scans';
const STORE = 'pages';
const MAX_W = 1600;          // pages are kept at most this wide (px)
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Page pictures (IndexedDB)
// ---------------------------------------------------------------------------

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbp;
}

async function idb(mode, fn) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result ?? null);
    tx.onerror = tx.onabort = () => resolve(null);
  });
}

const putPage = (id, blob) => idb('readwrite', s => s.put(blob, id));
const getPage = (id) => idb('readonly', s => s.get(id));
export const deletePage = (id) => idb('readwrite', s => s.delete(id));

// Object URLs of the pages this browser holds: id -> url, or null if absent
const urls = new Map();

export function pageUrl(id) { return urls.get(id) || null; }

/** Load the pictures of a scan's pages. Resolves true if any new one came in. */
export async function loadPages(scan) {
  let got = false;
  for (const p of scan?.pages || []) {
    if (urls.has(p.id)) continue;
    urls.set(p.id, null);
    const blob = await getPage(p.id);
    if (blob) { urls.set(p.id, URL.createObjectURL(blob)); got = true; }
  }
  return got;
}

// ---------------------------------------------------------------------------
// Import: image files and PDFs become page canvases
// ---------------------------------------------------------------------------

function fitCanvas(src, w, h) {
  const scale = Math.min(1, MAX_W / w);
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function imageCanvas(file) {
  // createImageBitmap honours the photo's EXIF rotation where supported
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (bmp) return fitCanvas(bmp, bmp.width, bmp.height);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    return fitCanvas(img, img.naturalWidth, img.naturalHeight);
  } finally { URL.revokeObjectURL(url); }
}

// pdf.js is loaded only when a PDF is chosen (cdnjs, about 350 kB)
let pdfjs = null;
async function pdfCanvases(file) {
  if (!pdfjs) {
    pdfjs = await import(/* @vite-ignore */ PDFJS + 'pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
  }
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: MAX_W / base.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(c);
  }
  return out;
}

const toBlob = (c) => new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));

/**
 * Files -> pages: each page kept (IndexedDB) and its lines found.
 * Returns [{ id, w, h, url, cuts }].
 */
export async function importFiles(files) {
  const canvases = [];
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) canvases.push(...await pdfCanvases(f));
    else canvases.push(await imageCanvas(f));
  }
  const pages = [];
  for (const c of canvases) {
    const id = newId();
    const blob = await toBlob(c);
    await putPage(id, blob);
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    const cuts = detectCuts(c);
    pages.push({ id, w: c.width, h: c.height, url, cuts, musicTop: musicTop(c, cuts) });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Finding the lines
//
// Ink per pixel row gives a profile with a peak for each row of neumes and
// another for its words. The lines of the score repeat at a steady spacing,
// which autocorrelation finds; the cuts are then the set of low points in
// the profile, spaced as near that period as they can be (dynamic
// programming), so a line's neumes and words stay together.
// ---------------------------------------------------------------------------

export function detectCuts(canvas) {
  const W = canvas.width;
  const H = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const x0 = Math.floor(W * 0.05);
  const x1 = Math.ceil(W * 0.95);

  // Ink threshold: well below the paper's brightness (photos are rarely white)
  const lum = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    const v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0;
    lum[p] = v;
    hist[v]++;
  }
  let acc = 0;
  let paper = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > W * H * 0.5) { paper = v; break; } }
  const thr = paper * 0.62;

  const rows = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = x0, p = y * W + x0; x < x1; x++, p++) if (lum[p] < thr) n++;
    rows[y] = n;
  }
  const k = Math.max(3, Math.round(H / 150)) | 1;
  const sm = new Float64Array(H);
  let run = 0;
  for (let y = 0; y < H + (k >> 1); y++) {
    if (y < H) run += rows[y];
    if (y - k >= 0) run -= rows[y - k];
    const c = y - (k >> 1);
    if (c >= 0 && c < H) sm[c] = run / k;
  }
  let peak = 0;
  for (const v of sm) peak = Math.max(peak, v);
  if (peak <= 0) return [0, H];

  let top = 0;
  while (top < H - 1 && sm[top] <= peak * 0.02) top++;
  let bot = H - 1;
  while (bot > top && sm[bot] <= peak * 0.02) bot--;
  top = Math.max(0, top - k);
  bot = Math.min(H, bot + k);

  // Period: the strongest autocorrelation between H/40 and H/5
  let mean = 0;
  for (let y = top; y < bot; y++) mean += sm[y];
  mean /= Math.max(1, bot - top);
  let best = -Infinity;
  let P = H / 12;
  for (let L = Math.round(H / 40); L < Math.round(H / 5); L++) {
    let s = 0;
    for (let y = top; y + L < bot; y++) s += (sm[y] - mean) * (sm[y + L] - mean);
    if (s > best) { best = s; P = L; }
  }

  // Low points
  const valleys = [];
  for (let y = top + 1; y < bot - 1; y++) {
    if (sm[y] <= sm[y - 1] && sm[y] <= sm[y + 1]) {
      const last = valleys[valleys.length - 1];
      if (last !== undefined && y - last < k) { if (sm[y] < sm[last]) valleys[valleys.length - 1] = y; }
      else valleys.push(y);
    }
  }
  const cand = [top, ...valleys, bot];
  const n = cand.length;
  const cost = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  cost[0] = 0;
  for (let j = 1; j < n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const L = cand[j] - cand[i];
      if (L > 1.6 * P) break;
      if (L < 0.5 * P || cost[i] === Infinity) continue;
      const c = cost[i] + (j === n - 1 ? 0 : (sm[cand[j]] / peak) * 10) + ((L - P) / P) ** 2 * 3;
      if (c < cost[j]) { cost[j] = c; prev[j] = i; }
    }
  }
  if (cost[n - 1] === Infinity) return [top, bot];
  const cuts = [];
  for (let j = n - 1; j >= 0; j = prev[j]) cuts.unshift(cand[j]);
  return cuts;
}

/**
 * Where the music starts on a page: the top of the first band whose ink
 * spreads across most of the width. A heading (title, tone) is centred
 * and narrower, so its bands come before it.
 */
export function musicTop(canvas, cuts) {
  const W = canvas.width;
  const data = canvas.getContext('2d').getImageData(0, 0, W, canvas.height).data;
  const x0 = Math.floor(W * 0.05);
  const x1 = Math.ceil(W * 0.95);
  const lumAt = (x, y) => { const i = (y * W + x) * 4; return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000; };
  for (let b = 0; b + 1 < cuts.length; b++) {
    const ya = Math.round(cuts[b]);
    const yb = Math.round(cuts[b + 1]);
    let first = -1;
    let last = -1;
    for (let x = x0; x < x1; x += 2) {
      for (let y = ya; y < yb; y += 2) {
        if (lumAt(x, y) < 110) { if (first < 0) first = x; last = x; break; }
      }
    }
    if (first >= 0 && (last - first) / (x1 - x0) > 0.7) return ya;
  }
  return 0;
}

/** Cuts -> lines: [{ page, y0, y1 }] */
export function linesFromPages(pages) {
  const lines = [];
  for (const p of pages) {
    const cuts = [...p.cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      if (cuts[i + 1] - cuts[i] > 8) lines.push({ page: p.id, y0: Math.round(cuts[i]), y1: Math.round(cuts[i + 1]) });
    }
  }
  return lines;
}

/** Cuts of each page from the lines already set */
export function cutsFromLines(scan) {
  return (scan.pages || []).map(p => {
    const set = new Set();
    for (const l of scan.lines || []) if (l.page === p.id) { set.add(l.y0); set.add(l.y1); }
    return { ...p, url: pageUrl(p.id), cuts: [...set].sort((a, b) => a - b) };
  });
}

/**
 * The lines above the music (title, mode) on the first page: they get no
 * notes when the lines are first laid over a score.
 */
export function headingLines(lines, pages) {
  const first = pages[0];
  if (!first?.musicTop) return 0;
  let n = 0;
  while (n < lines.length - 1 && lines[n].page === first.id && lines[n].y1 <= first.musicTop + 4) n++;
  return n;
}

// ---------------------------------------------------------------------------
// One line of the scan, as drawn above its notes
// ---------------------------------------------------------------------------

export function stripHtml(scan, k, { shift = true, zoomed = false } = {}) {
  const line = scan?.lines?.[k];
  if (!line) return '';
  const page = scan.pages.find(p => p.id === line.page);
  if (!page) return '';
  const h = Math.max(1, line.y1 - line.y0);
  const url = pageUrl(page.id);
  const top = (-line.y0 / h * 100).toFixed(3);
  const pic = url
    ? `<img src="${esc(url)}" alt="" draggable="false" style="top:${top}%">`
    : `<span class="scan-missing">The scan is on the device that added it</span>`;
  return `<div class="scan-strip${zoomed ? ' zoomed' : ''}" data-scan-line="${k}">
    <div class="scan-view"><div class="scan-frame" style="aspect-ratio:${page.w} / ${h}">${pic}</div></div>
    <div class="scan-tools">
      <span class="scan-n">Line ${k + 1}</span>
      ${shift ? `<button type="button" class="scan-shift" data-scan-shift="-1" title="Start this line one note earlier" aria-label="Start line ${k + 1} one note earlier">‹</button>
      <button type="button" class="scan-shift" data-scan-shift="1" title="Start this line one note later" aria-label="Start line ${k + 1} one note later">›</button>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// The cutter: the pages with their cuts, to check and correct by hand.
// Drag an orange line to move it, tap its handle to take it away, tap the
// page to add one. Resolves with the pages and their cuts, or null.
// ---------------------------------------------------------------------------

export function openCutter(pages, { title = 'Lines of the scan' } = {}) {
  return new Promise((resolve) => {
    const sheet = document.createElement('div');
    sheet.className = 'cutter';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', title);
    const state = pages.map(p => ({ ...p, cuts: [...p.cuts].sort((a, b) => a - b) }));

    const count = () => linesFromPages(state).length;
    sheet.innerHTML = `
      <div class="cutter-head">
        <button type="button" class="header-btn" data-cancel>Cancel</button>
        <span class="cutter-title"></span>
        <button type="button" class="header-btn accent" data-done>Use</button>
      </div>
      <p class="cutter-hint">Each band is one line of the score: its neumes and its words. Drag an orange line to move it, tap its handle to remove it, tap the page to add one.</p>
      <div class="cutter-pages"></div>`;
    const wrap = sheet.querySelector('.cutter-pages');

    function draw() {
      sheet.querySelector('.cutter-title').textContent = `${count()} line${count() === 1 ? '' : 's'}`;
      let n = 0;
      wrap.innerHTML = state.map((p, pi) => {
        const bands = [];
        for (let i = 0; i + 1 < p.cuts.length; i++) {
          const a = p.cuts[i] / p.h * 100;
          const b = p.cuts[i + 1] / p.h * 100;
          bands.push(`<div class="cut-band${n % 2 ? ' odd' : ''}" style="top:${a}%;height:${b - a}%"><span>${++n}</span></div>`);
        }
        const lines = p.cuts.map((y, ci) => `<div class="cut" data-page="${pi}" data-cut="${ci}" style="top:${y / p.h * 100}%">
            <button type="button" class="cut-handle" aria-label="Cut ${ci + 1}: drag to move, tap to remove"></button></div>`).join('');
        return `<div class="cutter-page" data-page="${pi}" style="aspect-ratio:${p.w} / ${p.h}">
          ${p.url ? `<img src="${esc(p.url)}" alt="Page ${pi + 1}" draggable="false">` : '<span class="scan-missing">Page not on this device</span>'}
          ${bands.join('')}${lines}</div>`;
      }).join('');
    }

    // Pointer handling: a handle drags (or, unmoved, removes); the page adds
    let drag = null;
    wrap.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.cut-handle');
      const pageEl = e.target.closest('.cutter-page');
      if (!pageEl) return;
      const pi = +pageEl.dataset.page;
      const rect = pageEl.getBoundingClientRect();
      const yOf = (cy) => Math.max(0, Math.min(state[pi].h, (cy - rect.top) / rect.height * state[pi].h));
      if (handle) {
        e.preventDefault();
        const cutEl = handle.closest('.cut');
        drag = { pi, ci: +cutEl.dataset.cut, el: cutEl, y0: e.clientY, moved: false, yOf };
        handle.setPointerCapture?.(e.pointerId);
      } else {
        drag = { pi, add: true, y0: e.clientY, x0: e.clientX, yOf };
      }
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.add) {
        if (Math.abs(e.clientY - drag.y0) > 8 || Math.abs(e.clientX - drag.x0) > 8) drag = null;   // a scroll
        return;
      }
      if (Math.abs(e.clientY - drag.y0) > 4) drag.moved = true;
      if (!drag.moved) return;
      e.preventDefault();
      const y = drag.yOf(e.clientY);
      state[drag.pi].cuts[drag.ci] = y;
      drag.el.style.top = `${y / state[drag.pi].h * 100}%`;
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      const p = state[d.pi];
      if (d.add) {
        if (e.type === 'pointercancel') return;
        p.cuts.push(Math.round(d.yOf(e.clientY)));
      } else if (!d.moved) {
        if (p.cuts.length > 2) p.cuts.splice(d.ci, 1);
      }
      p.cuts = p.cuts.map(Math.round).sort((a, b) => a - b).filter((y, i, a) => i === 0 || y - a[i - 1] > 4);
      draw();
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);

    const close = (result) => {
      sheet.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    sheet.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    sheet.querySelector('[data-done]').addEventListener('click', () => close(state));

    draw();
    document.body.appendChild(sheet);
  });
}

// ---------------------------------------------------------------------------
// File picker
// ---------------------------------------------------------------------------

export function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf,.pdf';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...(input.files || [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}
