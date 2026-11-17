// Gorgon — transcription mode: a scanned score beside the transcription
// GPL-3.0
//
// A scan (photos or a PDF of a printed or handwritten score) is cut into its
// lines, and each line of the scan is shown above the notes written for it,
// so the two can be read one against the other and corrected with the pad.
//
// Where things live:
//   score.scan = { pages: [{ id, w, h, skew? }], lines: [{ page, y0, y1, skew? }] }
//     in the score itself (saved and synced like the rest). A line written
//     on a slant has skew, its rise per pixel across (dy/dx): y0 and y1
//     are then where its cuts cross the middle of the page;
//   { type: 'scanline', line: k } elements in score.elements, where line k
//     of the scan starts (app.js). They draw nothing outside transcription
//     mode and never print, so the score reflows as usual;
//   the page pictures, in this browser's IndexedDB (gorgon-scans), by page
//     id. They stay on the device that imported them: another device shows
//     the lines as blank strips.

const DB_NAME = 'gorgon-scans';
const STORE = 'pages';
const MAX_W = 2400;          // pages are kept at most this wide (px): the small
                             // signs need the pixels, and the reader takes
                             // pictures up to 2576 px on the long edge
const MAX_READ_W = 2576;
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
    const blob = await getPage(p.id) || await fetchFile(p.id);
    if (blob) { urls.set(p.id, URL.createObjectURL(blob)); got = true; }
  }
  return got;
}

// ---------------------------------------------------------------------------
// The account's copy (lib/files.js): signed in, the pictures and the file
// they came from are sent once, so the account's other devices can fetch
// them. Signed out, these find nothing and the pictures stay on this device.
// ---------------------------------------------------------------------------

const FILES = '/api/admin/files';
const call = (path, opts = {}) => fetch(FILES + path, { cache: 'no-store', redirect: 'manual', credentials: 'same-origin', ...opts }).catch(() => null);

/** A picture or file this device lacks, from the account (then kept here) */
async function fetchFile(id) {
  const res = await call('/' + encodeURIComponent(id), { cache: 'default' });
  if (!res || !res.ok) return null;
  const blob = await res.blob().catch(() => null);
  if (blob?.size) await putPage(id, blob);
  return blob?.size ? blob : null;
}

/** The scan's files: its pages and the files they came from */
const filesOf = (scan) => [
  ...(scan?.pages || []).map(p => ({ id: p.id, name: '' })),
  ...(scan?.sources || []).map(s => ({ id: s.id, name: s.name || '' })),
];

const sent = new Set();     // ids the account has, as far as this page knows
/**
 * Send the account whichever of this scan's files it lacks and this device
 * holds. Resolves { sent, missing } (missing: on neither), or null when not
 * signed in.
 */
export async function sendFiles(scan) {
  const want = filesOf(scan).filter(f => !sent.has(f.id));
  if (!want.length) return { sent: 0, missing: 0 };
  const res = await call('');
  if (!res || !res.ok) return null;
  const { files = [] } = await res.json().catch(() => ({}));
  for (const f of files) sent.add(f.id);
  let n = 0, missing = 0;
  for (const f of want) {
    if (sent.has(f.id)) continue;
    const blob = await getPage(f.id);
    if (!blob) { missing++; continue; }
    const put = await call('/' + encodeURIComponent(f.id), {
      method: 'PUT',
      headers: { 'content-type': blob.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name) },
      body: blob,
    });
    if (!put) return { sent: n, missing, failed: true };
    if (put.status === 401 || put.type === 'opaqueredirect') return null;
    if (!put.ok) return { sent: n, missing, failed: true, full: put.status === 507 };
    sent.add(f.id);
    n++;
  }
  return { sent: n, missing };
}

/** Forget a page or file here and in the account (kept there while another score uses it) */
export async function deleteFile(id, doc = '') {
  await deletePage(id);
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  sent.delete(id);
  await call('/' + encodeURIComponent(id) + (doc ? '?doc=' + encodeURIComponent(doc) : ''), { method: 'DELETE' });
}

/** The file a scan came from, to save: { blob, name } or null */
export async function sourceFile(src) {
  const blob = await getPage(src.id) || await fetchFile(src.id);
  return blob ? { blob, name: src.name || 'scan.pdf' } : null;
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
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      // A PDF is kept as it came, beside its pages' pictures (a photo's
      // picture is the photo, near enough)
      const src = { id: newId(), name: f.name || 'scan.pdf', size: f.size };
      await putPage(src.id, f);
      for (const c of await pdfCanvases(f)) canvases.push({ c, src });
    } else canvases.push({ c: await imageCanvas(f) });
  }
  const pages = [];
  for (const { c, src } of canvases) {
    const id = newId();
    const blob = await toBlob(c);
    await putPage(id, blob);
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    const { cuts, skew } = detectLines(c);
    pages.push({ id, w: c.width, h: c.height, url, cuts, skew, musicTop: musicTop(c, cuts, skew), ...(src ? { src } : {}) });
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
//
// Handwriting drifts: a line may climb or fall across the page, and a photo
// may be tilted. So the rows are not taken straight across but along the
// slant found for each part of the page: the one that gathers the ink into
// the sharpest rows. A cut is then a slanted line, given by where it
// crosses the middle of the page and the slant there (skewAt).
// ---------------------------------------------------------------------------

const BANDS = 32;            // the page in vertical bands, to shear the rows
const SLANTS = 57;           // slants tried, from -MAX_SLANT to +MAX_SLANT
const MAX_SLANT = 0.14;      // dy/dx, about 8 degrees either way

/** The slant of the writing at height y of a page (dy/dx; 0 = level) */
export function skewAt(page, y) {
  const f = page?.skew;
  if (!f?.length) return 0;
  if (y <= f[0][0]) return f[0][1];
  for (let i = 1; i < f.length; i++) {
    if (y <= f[i][0]) {
      const t = (y - f[i - 1][0]) / Math.max(1, f[i][0] - f[i - 1][0]);
      return f[i - 1][1] + (f[i][1] - f[i - 1][1]) * t;
    }
  }
  return f[f.length - 1][1];
}

function smooth(rows, k) {
  const H = rows.length;
  const sm = new Float64Array(H);
  let run = 0;
  for (let y = 0; y < H + (k >> 1); y++) {
    if (y < H) run += rows[y];
    if (y - k >= 0) run -= rows[y - k];
    const c = y - (k >> 1);
    if (c >= 0 && c < H) sm[c] = run / k;
  }
  return sm;
}

// The spacing of the lines: the strongest autocorrelation between H/40 and H/5
function period(sm, top, bot, H) {
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
  return P;
}

/** The cuts of a page (where they cross its middle) and its slant: { cuts, skew } */
export function detectLines(canvas) {
  const W = canvas.width;
  const H = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const x0 = Math.floor(W * 0.05);
  const x1 = Math.ceil(W * 0.95);

  // Ink threshold: well below the paper's brightness (photos are rarely white)
  const hist = new Uint32Array(256);
  const lum = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    const v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0;
    lum[p] = v;
    hist[v]++;
  }
  let acc = 0;
  let paper = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > W * H * 0.5) { paper = v; break; } }
  const thr = paper * 0.62;

  // Ink per row in each vertical band of the page
  const bw = (x1 - x0) / BANDS;
  const band = Array.from({ length: BANDS }, () => new Float32Array(H));
  for (let y = 0; y < H; y++) {
    for (let x = x0, p = y * W + x0; x < x1; x++, p++) {
      if (lum[p] < thr) band[Math.min(BANDS - 1, ((x - x0) / bw) | 0)][y]++;
    }
  }
  const xc = Array.from({ length: BANDS }, (_, b) => x0 + (b + 0.5) * bw - W / 2);   // from the middle
  // The rows taken along a slant: row y is the line through the middle of
  // the page at y; slantOf gives the slant for each y
  const rowsAlong = (slantOf) => {
    const rows = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      const s = slantOf(y);
      let n = 0;
      for (let b = 0; b < BANDS; b++) {
        const yy = Math.round(y + s * xc[b]);
        if (yy >= 0 && yy < H) n += band[b][yy];
      }
      rows[y] = n;
    }
    return rows;
  };

  const k = Math.max(3, Math.round(H / 150)) | 1;
  const empty = { cuts: [0, H], skew: [] };

  // Each slant's rows, and how sharp they are (ink squared, summed up the page)
  const slants = Array.from({ length: SLANTS }, (_, i) => -MAX_SLANT + i * (2 * MAX_SLANT / (SLANTS - 1)));
  const level = (SLANTS - 1) / 2;
  const sharp = slants.map((s) => {
    const rows = smooth(rowsAlong(() => s), 3);
    const cum = new Float64Array(H + 1);
    for (let y = 0; y < H; y++) cum[y + 1] = cum[y] + rows[y] * rows[y];
    return cum;
  });
  if (sharp[level][H] <= 0) return empty;
  let whole = level;
  for (let i = 0; i < SLANTS; i++) if (sharp[i][H] > sharp[whole][H] * (i === level ? 1 : 1.02)) whole = i;

  // Line spacing, from the rows along the slant that suits the whole page
  const P0 = period(smooth(rowsAlong(() => slants[whole]), k), 0, H, H);

  // The slant by height: for each stretch of about three lines, the slant
  // with the sharpest rows there. Level wins unless another is clearly
  // sharper, so a straight page stays straight
  const field = [];
  const step = Math.max(8, Math.round(P0 / 2));
  const half = Math.round(P0 * 1.5);
  // A stretch with next to no ink (margins, specks) has no slant of its own
  const faint = sharp[whole][H] / H * 2 * half * 0.05;
  for (let yc = step; yc < H; yc += step) {
    const a = Math.max(0, yc - half);
    const b = Math.min(H, yc + half);
    const at = (i) => sharp[i][b] - sharp[i][a];
    if (at(level) <= faint && at(whole) <= faint) { field.push([yc, null]); continue; }
    let best = level;
    for (let i = 0; i < SLANTS; i++) if (at(i) > at(best) * (best === level && i !== level ? 1.04 : 1)) best = i;
    field.push([yc, slants[best]]);
  }
  // Blank stretches take their neighbours' slant; then a median of three
  for (let i = 0; i < field.length; i++) {
    if (field[i][1] !== null) continue;
    let j = i - 1;
    while (j >= 0 && field[j][1] === null) j--;
    let n = i + 1;
    while (n < field.length && field[n][1] === null) n++;
    field[i] = [field[i][0], j >= 0 ? field[j][1] : n < field.length ? field[n][1] : 0];
  }
  const med = field.map((f, i) => {
    const v = [field[Math.max(0, i - 1)][1], f[1], field[Math.min(field.length - 1, i + 1)][1]].sort((p, q) => p - q);
    return [f[0], Math.round(v[1] * 1000) / 1000];
  });
  const skew = med.some(f => Math.abs(f[1]) >= 0.004) ? med : [];
  const slantOf = (y) => skewAt({ skew }, y);

  const sm = smooth(rowsAlong(slantOf), k);
  let peak = 0;
  for (const v of sm) peak = Math.max(peak, v);
  if (peak <= 0) return empty;

  let top = 0;
  while (top < H - 1 && sm[top] <= peak * 0.02) top++;
  let bot = H - 1;
  while (bot > top && sm[bot] <= peak * 0.02) bot--;
  top = Math.max(0, top - k);
  bot = Math.min(H, bot + k);

  const P = period(sm, top, bot, H);

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
  if (cost[n - 1] === Infinity) return { cuts: [top, bot], skew };
  const cuts = [];
  for (let j = n - 1; j >= 0; j = prev[j]) cuts.unshift(cand[j]);
  return { cuts, skew };
}

/** A page's lines found afresh from its picture: { cuts, skew, musicTop }, or null without it */
async function findAgain(page) {
  const url = page.url || pageUrl(page.id);
  if (!url) return null;
  const img = await new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = url;
  });
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = page.w;
  c.height = page.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const { cuts, skew } = detectLines(c);
  return { cuts, skew, musicTop: musicTop(c, cuts, skew) };
}

/**
 * Where the music starts on a page: the top of the first band whose ink
 * spreads across most of the width. A heading (title, tone) is centred
 * and narrower, so its bands come before it.
 */
export function musicTop(canvas, cuts, skew = []) {
  const W = canvas.width;
  const data = canvas.getContext('2d').getImageData(0, 0, W, canvas.height).data;
  const x0 = Math.floor(W * 0.05);
  const x1 = Math.ceil(W * 0.95);
  const lumAt = (x, y) => { const i = (y * W + x) * 4; return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000; };
  for (let b = 0; b + 1 < cuts.length; b++) {
    const ya = Math.round(cuts[b]);
    const yb = Math.round(cuts[b + 1]);
    const s = skewAt({ skew }, (ya + yb) / 2);
    let first = -1;
    let last = -1;
    for (let x = x0; x < x1; x += 2) {
      const dy = Math.round(s * (x - W / 2));
      for (let y = ya; y < yb; y += 2) {
        const yy = y + dy;
        if (yy >= 0 && yy < canvas.height && lumAt(x, yy) < 110) { if (first < 0) first = x; last = x; break; }
      }
    }
    if (first >= 0 && (last - first) / (x1 - x0) > 0.7) return ya;
  }
  return 0;
}

/** Cuts -> lines: [{ page, y0, y1, skew? }] */
export function linesFromPages(pages) {
  const lines = [];
  for (const p of pages) {
    const cuts = [...p.cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      if (cuts[i + 1] - cuts[i] <= 8) continue;
      const line = { page: p.id, y0: Math.round(cuts[i]), y1: Math.round(cuts[i + 1]) };
      const skew = Math.round(skewAt(p, (line.y0 + line.y1) / 2) * 1000) / 1000;
      if (skew) line.skew = skew;
      lines.push(line);
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
// A line of the scan as a JPEG (base64), to send to be read (lib/read.js),
// at the sharpness the page was kept at.
// ---------------------------------------------------------------------------

const pictures = new Map();     // page id -> loaded <img>
async function pagePicture(id) {
  if (pictures.has(id)) return pictures.get(id);
  const url = pageUrl(id);
  if (!url) return null;
  const img = await new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = url;
  });
  if (img) pictures.set(id, img);
  return img;
}

export async function lineJpeg(scan, k) {
  const line = scan?.lines?.[k];
  const page = line && scan.pages.find(p => p.id === line.page);
  if (!page) return null;
  await loadPages(scan);
  const img = await pagePicture(page.id);
  if (!img) return null;
  const h = Math.max(1, line.y1 - line.y0);
  const out = Math.min(1, MAX_READ_W / Math.max(page.w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(page.w * out);
  c.height = Math.max(1, Math.round(h * out));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  // The page drawn so that the line lies level along the top of the canvas:
  // sheared by the line's slant about the middle of the page
  const sk = line.skew || 0;
  ctx.setTransform(out, -sk * out, 0, out, 0, (sk * page.w / 2 - line.y0) * out);
  ctx.drawImage(img, 0, 0, page.w, page.h);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

// ---------------------------------------------------------------------------
// One line of the scan, as drawn above its notes
// ---------------------------------------------------------------------------

export function stripHtml(scan, k, { zoomed = false, read = '', off = '' } = {}) {
  const line = scan?.lines?.[k];
  if (!line) return '';
  const page = scan.pages.find(p => p.id === line.page);
  if (!page) return '';
  const h = Math.max(1, line.y1 - line.y0);
  const url = pageUrl(page.id);
  const top = (-line.y0 / h * 100).toFixed(3);
  // A line written on a slant is drawn level: the page sheared about its middle
  const level = line.skew ? `;transform:skewY(${(-Math.atan(line.skew) * 180 / Math.PI).toFixed(3)}deg)` : '';
  const pic = url
    ? `<img src="${esc(url)}" alt="" draggable="false" style="top:${top}%${level}">`
    : `<span class="scan-missing">This picture is on the device that added the scan. Open the score there once, signed in, to bring it here.</span>`;
  return `<div class="scan-strip${zoomed ? ' zoomed' : ''}" data-scan-line="${k}">
    <div class="scan-view"><div class="scan-frame" style="aspect-ratio:${page.w} / ${h}">${pic}</div></div>
    <div class="scan-tools">
      <span class="scan-n">Line ${k + 1}${off ? ` <span class="scan-off">${esc(off)}</span>` : ''}</span>
      ${read === 'offer' ? `<button type="button" class="scan-read" data-scan-read title="Have Claude write this line's notes, for you to check">Read</button>` : ''}
      ${read === 'busy' ? '<span class="scan-reading">Reading…</span>' : ''}
      ${read === 'check' ? `<button type="button" class="scan-read" data-scan-checked title="This line is right now: clear its tints, and have Claude follow it on the lines it reads next">Checked</button>` : ''}
      <button type="button" class="scan-more" data-scan-options title="The scan: read all, adjust the lines, add pages" aria-label="Scan options">⋯</button>
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
      <p class="cutter-hint">Each band is one line of the score: its neumes and its words. Drag an orange line to move it, tap its handle to remove it, tap the page to add one.${pages.some(p => p.url) ? ' <button type="button" class="cutter-again" data-again>Find the lines again</button>' : ''}</p>
      <div class="cutter-pages"></div>`;
    const wrap = sheet.querySelector('.cutter-pages');

    function draw() {
      sheet.querySelector('.cutter-title').textContent = `${count()} line${count() === 1 ? '' : 's'}`;
      let n = 0;
      wrap.innerHTML = state.map((p, pi) => {
        const bands = [];
        const tilt = (y) => { const s = skewAt(p, y); return s ? `;transform:skewY(${(Math.atan(s) * 180 / Math.PI).toFixed(3)}deg)` : ''; };
        for (let i = 0; i + 1 < p.cuts.length; i++) {
          const a = p.cuts[i] / p.h * 100;
          const b = p.cuts[i + 1] / p.h * 100;
          bands.push(`<div class="cut-band${n % 2 ? ' odd' : ''}" style="top:${a}%;height:${b - a}%${tilt((p.cuts[i] + p.cuts[i + 1]) / 2)}"><span>${++n}</span></div>`);
        }
        const lines = p.cuts.map((y, ci) => `<div class="cut" data-page="${pi}" data-cut="${ci}" style="top:${y / p.h * 100}%${tilt(y)}">
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
      // A cut is kept as where it crosses the middle of the page: a touch
      // off to one side of a slanted cut is that much above or below it
      const xOff = (cx) => (cx - rect.left) / rect.width * state[pi].w - state[pi].w / 2;
      if (handle) {
        e.preventDefault();
        const cutEl = handle.closest('.cut');
        const ci = +cutEl.dataset.cut;
        drag = { pi, ci, el: cutEl, y0: e.clientY, moved: false, yOf, grab: state[pi].cuts[ci] - yOf(e.clientY) };
        handle.setPointerCapture?.(e.pointerId);
      } else {
        drag = { pi, add: true, y0: e.clientY, x0: e.clientX, yOf, xOff };
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
      const y = Math.max(0, Math.min(state[drag.pi].h, drag.yOf(e.clientY) + drag.grab));
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
        const y = d.yOf(e.clientY);
        p.cuts.push(Math.round(Math.max(0, Math.min(p.h, y - skewAt(p, y) * d.xOff(e.clientX)))));
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
    // Find the lines again from the pictures (the cuts made by hand go)
    sheet.querySelector('[data-again]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      for (const p of state) {
        const found = await findAgain(p);
        if (found) Object.assign(p, found);
      }
      e.target.disabled = false;
      draw();
    });
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
