/**
 * PDF export without the print dialog.
 *
 * iOS ignores window.print() in a web app opened from the Home Screen, so
 * there the PDF is made here: the score is laid out as it prints (the
 * @media print rules, light colours, A4 width) in a hidden frame, cut into
 * pages between lines of neumes, each page drawn to a canvas through an SVG
 * <foreignObject> (the browser's own text rendering, so the Neanes marks sit
 * where they do on screen), and the pages written into a PDF as images.
 * The file then goes to the share sheet (Save to Files, Print, Mail…).
 */

// A4 at CSS 96 px/in: 210 x 297 mm
const PAGE_W = 794;
const PAGE_H = 1123;
const PT_W = 595.28;
const PT_H = 841.89;
const MARGIN_Y = 48;     // top and bottom of every page, in CSS px
const MARGIN_X = 38;     // each side (~10 mm), as the print dialog leaves
const SCALE = 2.5;       // canvas pixels per CSS px (~240 dpi)

/** True when running as a Home Screen / installed web app. */
export function isStandalone() {
  return window.navigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: fullscreen)').matches;
}

let cssCache = null;
async function printCss() {
  if (cssCache) return cssCache;
  const [cssText, fontBuf] = await Promise.all([
    fetch('app.css').then(r => r.text()),
    fetch('fonts/Neanes.woff2').then(r => r.arrayBuffer()),
  ]);
  const fontUrl = 'data:font/woff2;base64,' + base64(new Uint8Array(fontBuf));
  cssCache = cssText
    // The font has to travel inside the SVG image
    .replace(/url\(['"]?fonts\/Neanes\.woff2['"]?\)/g, `url("${fontUrl}")`)
    // Always light, and always the print layout
    .replace(/@media\s*\(prefers-color-scheme:\s*dark\)/g, '@media not all')
    .replace(/color-scheme:\s*light dark/g, 'color-scheme: light')
    .replace(/@media\s+print/g, '@media all');
  return cssCache + `
    html, body { margin: 0; padding: 0; width: ${PAGE_W}px; background: #fff; }
    #score-area { display: block; padding: 0; }
    .score { width: ${PAGE_W - 2 * MARGIN_X}px; margin-left: ${MARGIN_X}px; box-sizing: border-box; padding-top: 0; padding-bottom: 0; }
    .pdf-title { white-space: pre-wrap; }
  `;
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** A copy of the score as it prints: no cursor, selection or pending Ison. */
function cloneScore(scoreEl) {
  const clone = scoreEl.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('.selected, .cursor, .active').forEach(el => {
    el.classList.remove('selected', 'cursor', 'active');
  });
  clone.querySelectorAll('.note-col.placeholder, .combine-mark').forEach(el => el.remove());
  // The title is a textarea; its text is a property, not markup
  const live = scoreEl.querySelector('textarea');
  const ta = clone.querySelector('textarea');
  if (ta) {
    const div = document.createElement('div');
    div.className = ta.className + ' pdf-title';
    div.textContent = live ? live.value : '';
    if (!div.textContent) div.style.display = 'none';
    ta.replaceWith(div);
  }
  clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  return clone;
}

/** Lay the copy out at A4 width in a hidden frame, so it can be measured. */
async function layoutFrame(css, clone) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: 'fixed', left: '-10000px', top: '0',
    width: PAGE_W + 'px', height: PAGE_H + 'px', border: '0', visibility: 'hidden',
  });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><main id="score-area"></main></body></html>');
  doc.close();
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.appendChild(style);
  doc.getElementById('score-area').appendChild(doc.importNode(clone, true));
  await doc.fonts.ready;
  // Make sure Neanes itself has loaded, not just been declared
  try { await doc.fonts.load('40px Neanes', ''); } catch { /* fall through */ }
  await new Promise(r => frame.contentWindow.requestAnimationFrame(() => r()));
  return frame;
}

/**
 * Where a page may end: between blocks (the heading, a line of neumes),
 * never through one.
 */
function pageCuts(doc) {
  const score = doc.querySelector('.score');
  const top0 = score.getBoundingClientRect().top;
  const boxes = [];
  const head = score.querySelector('.score-head');
  if (head) {
    const r = head.getBoundingClientRect();
    boxes.push([r.top - top0, r.bottom - top0]);
  }
  score.querySelectorAll('.score-content > *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.height > 0) boxes.push([r.top - top0, r.bottom - top0]);
  });
  boxes.sort((a, b) => a[0] - b[0]);
  // Merge overlapping boxes into rows; a page may break at a row's top
  const rows = [];
  for (const [t, b] of boxes) {
    const last = rows[rows.length - 1];
    if (last && t < last[1] - 1) last[1] = Math.max(last[1], b);
    else rows.push([t, b]);
  }
  // The score ends with its last line, not with the padding under it
  const total = Math.ceil(Math.max(1, ...rows.map(r => r[1]))) + 8;
  const room = PAGE_H - 2 * MARGIN_Y;
  const cuts = [];
  let start = 0;
  while (start < total - 1) {
    let end = start + room;
    if (end >= total) { cuts.push([start, total]); break; }
    const fit = rows.filter(([t]) => t > start + 1 && t <= end).pop();
    if (fit) end = Math.floor(fit[0]);
    cuts.push([start, end]);
    start = end;
  }
  if (!cuts.length) cuts.push([0, Math.max(total, 1)]);
  return cuts;
}

function pageSvg(css, markup, [start, end]) {
  const h = end - start;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}">`
    + `<foreignObject x="0" y="0" width="${PAGE_W}" height="${PAGE_H}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${PAGE_W}px;height:${PAGE_H}px;background:#fff;position:relative;overflow:hidden">`
    + `<style>${escapeXmlText(css)}</style>`
    + `<div style="position:absolute;left:0;top:${MARGIN_Y}px;width:${PAGE_W}px;height:${h}px;overflow:hidden">`
    + `<div id="score-area" style="margin-top:${-start}px">${markup}</div>`
    + `</div></div></foreignObject></svg>`;
}

function escapeXmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not draw the page'));
    img.src = src;
  });
}

async function renderPage(svg) {
  // A data: URL, not a blob: one, or the canvas counts as tainted
  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  {
    try { await img.decode?.(); } catch { /* drawn below anyway */ }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(PAGE_W * SCALE);
    canvas.height = Math.round(PAGE_H * SCALE);
    const ctx = canvas.getContext('2d');
    const draw = () => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    // Safari can paint an SVG image before its embedded font is ready:
    // draw, give it a moment, draw again.
    draw();
    await new Promise(r => setTimeout(r, 120));
    draw();
    const blob = await new Promise((resolve, reject) => canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('Could not encode the page'))), 'image/jpeg', 0.92));
    canvas.width = canvas.height = 0;   // free the memory on iOS
    return new Uint8Array(await blob.arrayBuffer());
  }
}

/** A plain PDF: one full-page JPEG per A4 page. */
function buildPdf(jpegs, title) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };

  const n = jpegs.length;
  // 1 catalog, 2 pages, 3 info, then per page: page, content, image
  const pageObj = i => 4 + i * 3;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${jpegs.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title ${pdfString(title)} /Creator (Gorgon) >>`));
  jpegs.forEach((jpeg, i) => {
    const p = pageObj(i);
    obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] `
      + `/Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`));
    const content = `q ${PT_W} 0 0 ${PT_H} 0 0 cm /Im0 Do Q`;
    obj(p + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(p + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${Math.round(PAGE_W * SCALE)} `
        + `/Height ${Math.round(PAGE_H * SCALE)} /ColorSpace /DeviceRGB /BitsPerComponent 8 `
        + `/Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      push(jpeg);
      push('\nendstream');
    });
  });
  const count = 4 + n * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/** A PDF text string, as UTF-16BE so Greek titles survive. */
function pdfString(s) {
  let hex = 'FEFF';
  for (const ch of String(s || 'Untitled')) {
    const c = ch.codePointAt(0);
    const units = c > 0xFFFF
      ? [0xD800 + ((c - 0x10000) >> 10), 0xDC00 + ((c - 0x10000) & 0x3FF)]
      : [c];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

/** Make the PDF of the score element. Returns a File. */
export async function makePdf(scoreEl, title) {
  const css = await printCss();
  const clone = cloneScore(scoreEl);
  const frame = await layoutFrame(css, clone);
  try {
    const doc = frame.contentDocument;
    const cuts = pageCuts(doc);
    const markup = new XMLSerializer().serializeToString(doc.querySelector('.score'));
    const jpegs = [];
    for (const cut of cuts) jpegs.push(await renderPage(pageSvg(css, markup, cut)));
    const name = (String(title || '').trim() || 'Untitled').replace(/[\\/:*?"<>|\n\r]+/g, ' ').slice(0, 80);
    return new File([buildPdf(jpegs, title)], `${name}.pdf`, { type: 'application/pdf' });
  } finally {
    frame.remove();
  }
}

/** Hand the file over: the share sheet where there is one, else a download. */
export async function deliverPdf(file) {
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: file.name.replace(/\.pdf$/, '') });
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
