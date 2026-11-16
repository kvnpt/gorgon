// Gorgon — Byzantine Notation Writer (v2)
// GPL-3.0

import { createScore, createNote, createMartyria, createModeKey,
         createBarline, createSectionBreak, createSpacer,
         SBMUFL_TO_NEUME, NEUME_TO_SBMUFL } from './models.js';
import { analyzeScore, computeMartyria } from './analysis.js';
import { attachPad } from './gestures.js';
import { initAccount, currentIsSaved, newDocId } from './account.js';
import { parseLyricText, buildLyricText, slotAtCaret } from './lyrics.js';
import { importFiles, openCutter, linesFromPages, cutsFromLines, headingLines,
  stripHtml, loadPages, deletePage, pickFiles, lineJpeg } from './scan.js';

// ============================================================================
// SBMUFL DATA + THEORY DATA
// ============================================================================

let glyphnames = {};
let ranges = {};
let classes = {};
let theory = {};

const categoryMap = {
  quantity: 'charactersOfQuantity',
  quality: 'charactersOfQuality',
  temporal: ['charactersOfTemporalAugmentation', 'charactersOfTemporalDivision', 'charactersOfTempo'],
  martyria: [],   // rendered as whole martyriae by renderMartyriaPalette()
  fthores: 'fthores',
  other: ['signsOfAlteration', 'charactersOfRhythm', 'noteIndicators', 'isonIndicators', 'letters'],
};

async function loadData() {
  const [gRes, rRes, cRes, nvRes, scRes, frRes, mkRes, mrRes] = await Promise.all([
    fetch('/api/glyphs'), fetch('/api/ranges'), fetch('/api/classes'),
    fetch('/api/theory/neume-values'), fetch('/api/theory/scales'),
    fetch('/api/theory/fthora-rules'), fetch('/api/theory/mode-keys'),
    fetch('/api/theory/martyria-rules'),
  ]);
  glyphnames = await gRes.json();
  ranges = await rRes.json();
  classes = await cRes.json();
  theory.neumeValues = await nvRes.json();
  theory.scales = await scRes.json();
  theory.fthoraRules = await frRes.json();
  theory.modeKeys = await mkRes.json();
  theory.martyriaRules = await mrRes.json();
}

function codepointToChar(cp) {
  return String.fromCodePoint(parseInt(cp.replace('U+', ''), 16));
}

// ============================================================================
// STATE
// ============================================================================

// A shared link (/s/<token>) opens the score read only: no pad, no saving
// over this browser's own score (see VIEW MODE at the end)
const SHARED_TOKEN = (location.pathname.match(/^\/s\/([A-Za-z0-9]+)\/?$/) || [])[1] || null;
const viewOnly = location.pathname.startsWith('/s/');

let score = createScore();
let cursorPos = 0;
let selectedIdx = -1;
let analysisResult = [];
let history = [];
const MAX_HISTORY = 200;

// The pending symbol sitting in a blank spot (see COMPOSE PAD). It is part
// of score.elements so it renders and analyses like any symbol, but it is
// left out of history snapshots and saves until it is committed or changed.
let placeholderEl = null;

function placeholderIndex() {
  return placeholderEl ? score.elements.indexOf(placeholderEl) : -1;
}

// The score as it should be stored: without an untouched placeholder
function storableScore() {
  const p = placeholderIndex();
  if (p < 0) return score;
  return { ...score, elements: score.elements.filter((_, i) => i !== p) };
}

// Each snapshot keeps the focus too, so Undo puts you back where you were
function pushHistory() {
  const p = placeholderIndex();
  let sel = selectedIdx;
  let pos = cursorPos;
  if (p >= 0) {
    if (sel === p) { sel = -1; pos = p; }
    else {
      if (sel > p) sel--;
      if (pos > p) pos--;
    }
  }
  history.push(JSON.stringify({ score: storableScore(), selectedIdx: sel, cursorPos: pos }));
  if (history.length > MAX_HISTORY) history.shift();
}

function undo() {
  if (history.length === 0) return;
  const snap = JSON.parse(history.pop());
  score = snap.score;
  placeholderEl = null;
  cursorPos = Math.min(snap.cursorPos, score.elements.length);
  selectedIdx = snap.selectedIdx < score.elements.length ? snap.selectedIdx : -1;
  if (selectedIdx < 0) enterBlank(cursorPos);
  reanalyze();
  render();
}

function reanalyze() {
  flowLyricTail();
  analysisResult = analyzeScore(score.elements, score.modeKey, theory);
}

// ============================================================================
// MODE LABELS
// ============================================================================

const modeLabels = {
  1: 'Mode 1 — Protos',
  2: 'Mode 2 — Devteros',
  3: 'Mode 3 — Tritos',
  4: 'Mode 4 — Tetartos',
  5: 'Plagal Mode 1 — Plagios Protos',
  6: 'Plagal Mode 2 — Plagios Devteros',
  7: 'Grave — Varys',
  8: 'Plagal Mode 4 — Plagios Tetartos',
};

// The mode picker: each authentic mode beside its plagal (its "brother"),
// 1 with 5, 2 with 6, 3 with 7 (Grave), 4 with 8. A menu out of the mode
// line on the page, as agora's are.
const modeNames = {
  1: ['Mode 1', 'Protos'],
  2: ['Mode 2', 'Devteros'],
  3: ['Mode 3', 'Tritos'],
  4: ['Mode 4', 'Tetartos'],
  5: ['Plagal 1', 'Plagios Protos'],
  6: ['Plagal 2', 'Plagios Devteros'],
  7: ['Grave', 'Varys'],
  8: ['Plagal 4', 'Plagios Tetartos'],
};

const currentMode = () => score.modeKey?.mode || score.mode || 1;

function renderScoreHead() {
  const title = document.getElementById('score-title');
  const want = score.metadata?.title || '';
  if (document.activeElement !== title && title.value !== want) {
    title.value = want;
    fitTitle();
  }
  const sub = document.getElementById('score-subtitle');
  const wantSub = score.metadata?.subtitle || '';
  if (document.activeElement !== sub && sub.value !== wantSub) {
    sub.value = wantSub;
  }
  fitSubtitle();
  const btn = document.getElementById('score-mode');
  const text = modeLabels[currentMode()] || modeLabels[1];
  if (btn.dataset.text !== text) {
    btn.dataset.text = text;
    btn.innerHTML = `<span>${esc(text)}</span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5 8 10.5 12 6.5"/></svg>`;
  }
}

// The title wraps like the printed one: the field grows to fit its lines
function fitTitle() {
  const t = document.getElementById('score-title');
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight}px`;
}

// The subtitle field is as wide as its text (or its placeholder)
function fitSubtitle() {
  const sub = document.getElementById('score-subtitle');
  sub.parentElement.dataset.value = sub.value || sub.placeholder;
  sub.parentElement.classList.toggle('empty', !sub.value);
}

let modeMenu = null;

function setMode(mode) {
  if (mode === currentMode()) return;
  pushHistory();
  score.modeKey = score.modeKey || {};
  score.modeKey.mode = mode;
  // The mode's default template sets its scale and base note
  const template = theory.modeKeys?.templates?.find(t => t.mode === mode);
  if (template) {
    score.modeKey.scale = template.scale;
    score.modeKey.scaleNote = template.scaleNote;
    score.modeKey.templateId = template.id;
  }
  reanalyze();
  render();
}

function openModeMenu(btn) {
  closeModeMenu();
  const cur = currentMode();
  const cell = (m) => {
    const [name, sub] = modeNames[m];
    const on = m === cur;
    return `<button type="button" class="mm-cell${on ? ' on' : ''}" role="menuitemradio" aria-checked="${on}" data-mode="${m}">`
      + `<b>${esc(name)}</b><small>${esc(sub)}</small></button>`;
  };
  let html = '<div class="mm-head">Authentic</div><div class="mm-head">Plagal</div>';
  for (let m = 1; m <= 4; m++) html += cell(m) + cell(m + 4);
  const el = document.createElement('div');
  el.className = 'popmenu mode-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Mode');
  el.innerHTML = html;
  document.body.appendChild(el);

  // Under the mode line, centred on it and kept on the screen; above it if
  // there is more room there.
  const r = btn.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(10, Math.min(window.innerWidth - w - 10, r.left + r.width / 2 - w / 2));
  const below = window.innerHeight - r.bottom;
  const up = below < h + 16 && r.top > below;
  el.style.left = `${left}px`;
  if (up) el.style.bottom = `${window.innerHeight - r.top + 8}px`;
  else el.style.top = `${r.bottom + 8}px`;
  // It grows out of the button
  el.style.transformOrigin = `${Math.round(r.left + r.width / 2 - left)}px ${up ? '100%' : '0'}`;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('.mm-cell');
    if (!b) return;
    setMode(parseInt(b.dataset.mode, 10));
    closeModeMenu();
  });
  btn.setAttribute('aria-expanded', 'true');
  modeMenu = el;
  el.querySelector('.mm-cell.on')?.focus({ preventScroll: true });
}

function closeModeMenu() {
  if (!modeMenu) return;
  const el = modeMenu;
  modeMenu = null;
  document.getElementById('score-mode').setAttribute('aria-expanded', 'false');
  el.classList.add('out');
  setTimeout(() => el.remove(), 130);
}

document.addEventListener('pointerdown', (e) => {
  if (modeMenu && !modeMenu.contains(e.target) && !e.target.closest('#score-mode')) closeModeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modeMenu) { closeModeMenu(); document.getElementById('score-mode').focus(); }
});
document.addEventListener('scroll', (e) => { if (modeMenu && !modeMenu.contains(e.target)) closeModeMenu(); }, { capture: true, passive: true });
window.addEventListener('resize', () => closeModeMenu());

// ----------------------------------------------------------------------------
// Martyria: a note letter with its root sign underneath, both red.
// The letter comes from the pitch (noteValue -9..11 maps in order onto
// martyriaNoteZoLow..martyriaNoteKeHigh); the root sign from the scale rules
// in martyria-rules.json, computed by the analysis engine.
// ----------------------------------------------------------------------------

const NOTE_ORDER = ['ZoLow', 'NiLow', 'PaLow', 'VouLow', 'GaLow', 'ThiLow', 'KeLow',
  'Zo', 'Ni', 'Pa', 'Vou', 'Ga', 'Thi', 'Ke',
  'ZoHigh', 'NiHigh', 'PaHigh', 'VouHigh', 'GaHigh', 'ThiHigh', 'KeHigh'];
const MIN_NOTE = -9;
const MAX_NOTE = 11;

function noteNameOf(value) {
  return NOTE_ORDER[value - MIN_NOTE] || '';
}

function noteValueOf(name) {
  const i = NOTE_ORDER.indexOf(name);
  return i < 0 ? null : i + MIN_NOTE;
}

// SBMuFL spells Thi as "Di"
function martyriaNoteGlyph(value) {
  const name = noteNameOf(value);
  return name ? 'martyriaNote' + name.replace('Thi', 'Di') : null;
}

const ROOT_SIGN_GLYPHS = {
  Delta: 'martyriaDeltaBelow',
  Alpha: 'martyriaAlphaBelow',
  Legetos: 'martyriaLegetosBelow',
  Nana: 'martyriaNanaBelow',
  DeltaDotted: 'martyriaDeltaDottedBelow',
  AlphaDotted: 'martyriaAlphaDottedBelow',
  Varys: 'martyriaZoBelow',
  Zygos: 'martyriaZygosBelow',
  Squiggle: 'martyriaHardChromaticPaBelow',
  Tilt: 'martyriaHardChromaticDiBelow',
  SoftChromaticPaRootSign: 'martyriaSoftChromaticKeBelow',
  SoftChromaticSquiggle: 'martyriaSoftChromaticDiBelow',
};

function rootSignGlyph(rootSign) {
  if (!rootSign) return null;
  return ROOT_SIGN_GLYPHS[rootSign] || ROOT_SIGN_GLYPHS[rootSign.replace(/Low$/, '')] || null;
}

function glyphChar(name) {
  return name && glyphnames[name] ? codepointToChar(glyphnames[name].codepoint) : '';
}

// The two characters of a martyria, from its analysis entry
function martyriaChars(analysis) {
  if (!analysis || typeof analysis.noteValue !== 'number') return null;
  return {
    note: glyphChar(martyriaNoteGlyph(analysis.noteValue)),
    root: glyphChar(rootSignGlyph(analysis.autoMartyria?.rootSign)),
  };
}

function createMartyriaOn(noteValue) {
  return { type: 'martyria', auto: false, noteValue };
}

// A leimma is an empty beat (a rest) of its own, not a sign on a note.
// Swipes step it through one to four beats.
const LEIMMATA = ['leimma1', 'leimma2', 'leimma3', 'leimma4'];
const isLeimma = (name) => /^leimma[1-4]$/.test(name || '');

function createRest(glyph = 'leimma1') {
  return { type: 'rest', glyph };
}

function restBeats(el) {
  return LEIMMATA.indexOf(el.glyph) + 1 || 1;
}

function restLabel(el) {
  const n = restBeats(el);
  return `${n} beat${n > 1 ? 's' : ''}`;
}


// ============================================================================
// SUPPORT SYMBOL PLACEMENT
// ============================================================================

function isBottomSupport(glyphName) {
  if (glyphName.includes('Below') || glyphName.includes('Bottom')) return true;
  if (['apli', 'dipli', 'tripli', 'tetrapli', 'koronis'].includes(glyphName)) return true;
  if (glyphName.startsWith('leimma')) return true;
  return false;
}

// ============================================================================
// PALETTE
// ============================================================================

let currentCategory = 'quantity';

function getGlyphsForCategory(cat) {
  const rangeKeys = categoryMap[cat];
  if (!rangeKeys) return [];
  const keys = Array.isArray(rangeKeys) ? rangeKeys : [rangeKeys];
  const result = [];
  for (const key of keys) {
    const range = ranges[key];
    if (!range || !range.glyphs) continue;
    for (const name of range.glyphs) {
      const g = glyphnames[name];
      if (g) result.push({ name, codepoint: g.codepoint });
    }
  }
  return result;
}

// Zero-width glyphs are marks the font attaches to the neume before them.
// Measured once the font is in; until then nothing counts as a mark.
const markGlyphs = new Map();
let measureCtx = null;
function isMarkGlyph(char) {
  if (!document.fonts?.check('32px Neanes')) return false;
  if (!markGlyphs.has(char)) {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = '32px Neanes';
    markGlyphs.set(char, measureCtx.measureText(char).width < 1);
  }
  return markGlyphs.get(char);
}
document.fonts?.load('32px Neanes')
  .then(() => { if (Object.keys(glyphnames).length) render(); }).catch(() => {});

function renderPalette() {
  const grid = document.getElementById('palette-grid');
  if (currentCategory === 'martyria') {
    renderMartyriaPalette(grid);
    return;
  }
  const glyphs = getGlyphsForCategory(currentCategory);

  // Get analysis state at cursor for theory-aware filtering
  const cursorAnalysis = selectedIdx >= 0
    ? analysisResult[selectedIdx]
    : (cursorPos > 0 ? analysisResult[cursorPos - 1] : null);

  grid.innerHTML = glyphs.map(g => {
    // A sign the font hangs on a neume (zero width) is shown on an Ison:
    // on its own Safari draws nothing and Chrome draws it off the tile
    const onBase = isMarkGlyph(codepointToChar(g.codepoint));
    const char = (onBase ? glyphChar('ison') : '') + codepointToChar(g.codepoint);
    const label = glyphLabel(g.name);

    // Check if this neume is valid in current context (for fthores category)
    let invalid = false;
    if (currentCategory === 'fthores' && cursorAnalysis) {
      const noteValue = cursorAnalysis.noteValue;
      // Simple validation: check fthora rules
      const fthoraType = getFthoraType(g.name);
      if (fthoraType && theory.fthoraRules?.fthoraValidation) {
        const rule = theory.fthoraRules.fthoraValidation[fthoraType];
        if (rule && rule.validNotes !== 'any' && rule.validNoteValues) {
          invalid = !rule.validNoteValues.includes(noteValue);
        }
      }
    }

    const cls = `palette-btn${invalid ? ' invalid' : ''}`;
    return `<button class="${cls}" data-glyph="${g.name}" data-cp="${g.codepoint}" title="${label}"${invalid ? ' disabled' : ''}>
      <span class="glyph${onBase ? ' on-base' : ''}">${char}</span>
      <span class="glyph-name">${label}</span>
    </button>`;
  }).join('');
}

// The Martyria tab offers whole martyriae (note letter + root sign), in the
// same order as the compose pad: the reached pitch, the mode's bases, the rest.
function renderMartyriaPalette(grid) {
  const pos = selectedIdx >= 0 ? selectedIdx : cursorPos;
  grid.innerHTML = martyriaOptions(pos).map(opt => {
    const name = noteNameOf(opt.value);
    const label = opt.auto ? `${name} (auto)` : name;
    return `<button class="palette-btn" data-mvalue="${opt.value}" data-mauto="${opt.auto ? 1 : 0}" title="Martyria ${label}">
      <span class="glyph martyria">${optionChars(opt, pos)}</span>
      <span class="glyph-name">${label}</span>
    </button>`;
  }).join('');
}

// Readable palette label: split camelCase into words, e.g.
// 'oligonKentimaYpsiliRight' -> 'Oligon kentima ypsili right'.
function glyphLabel(name) {
  const words = name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Map SBMuFL fthora glyph names to theory fthora types
function getFthoraType(glyphName) {
  const n = glyphName.toLowerCase();
  if (n.includes('zygos')) return 'Zygos';
  if (n.includes('kliton')) return 'Kliton';
  if (n.includes('spathi')) return 'Spathi';
  if (n.includes('enharmonic')) return 'Enharmonic';
  if (n.includes('hardchromatic') || n.includes('hardChromatic')) return 'HardChromatic';
  if (n.includes('softchromatic') || n.includes('softChromatic')) return 'SoftChromatic';
  if (n.includes('diatonic')) return 'Diatonic';
  if (n.includes('generalsharp') || n.includes('generalSharp')) return 'GeneralSharp';
  if (n.includes('generalflat') || n.includes('generalFlat')) return 'GeneralFlat';
  return null;
}

// Show fade edges on the tab row when there are more tabs off-screen.
function updateTabScrollCue() {
  const row = document.getElementById('palette-tabs');
  const wrap = row.parentElement;
  const max = row.scrollWidth - row.clientWidth;
  wrap.classList.toggle('more-left', row.scrollLeft > 2);
  wrap.classList.toggle('more-right', row.scrollLeft < max - 2);
}

function initPaletteTabs() {
  const tabs = document.querySelectorAll('.palette-tab');
  const row = document.getElementById('palette-tabs');
  row.addEventListener('scroll', updateTabScrollCue, { passive: true });
  window.addEventListener('resize', updateTabScrollCue);
  updateTabScrollCue();
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      currentCategory = tab.dataset.category;
      renderPalette();
    });
  });
}

function initPaletteGrid() {
  document.getElementById('palette-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.palette-btn');
    if (!btn || btn.disabled) return;

    // Martyria tab: replace the focused martyria, or insert one at the cursor
    if (btn.dataset.mvalue !== undefined) {
      const opt = { value: Number(btn.dataset.mvalue), auto: btn.dataset.mauto === '1' };
      if (selectedIdx >= 0 && score.elements[selectedIdx]?.type === 'martyria') {
        pushHistory();
        score.elements[selectedIdx] = martyriaFromOption(opt);
        placeholderEl = null;
        refresh();
      } else {
        insertElement(martyriaFromOption(opt));
      }
      return;
    }

    const glyphName = btn.dataset.glyph;
    const cp = btn.dataset.cp;

    // A leimma (empty beat) stands on its own, after the focused note or in
    // place of a blank spot's pending Ison
    if (isLeimma(glyphName)) {
      if (selectedIdx >= 0 && score.elements[selectedIdx]?.type === 'rest') {
        pushHistory();
        score.elements[selectedIdx].glyph = glyphName;
        refresh();
      } else {
        insertElement(createRest(glyphName));
      }
      return;
    }

    // If a neume is selected and this is a support category, add as modifier
    if (selectedIdx >= 0 && score.elements[selectedIdx]?.type === 'note'
        && ['temporal', 'quality', 'fthores'].includes(currentCategory)) {
      const el = score.elements[selectedIdx];
      if (el === placeholderEl) keepPlaceholder();
      if (currentCategory === 'temporal') {
        pushHistory();
        // Map to timeNeume or gorgonNeume
        const neumeType = glyphName.toLowerCase();
        if (neumeType.includes('gorgon') || neumeType.includes('argon')) {
          el.gorgonNeume = glyphName;
        } else {
          el.timeNeume = glyphName;
        }
        reanalyze();
        render();
        return;
      }
      if (currentCategory === 'quality') {
        pushHistory();
        el.vocalExpression = glyphName;
        reanalyze();
        render();
        return;
      }
      if (currentCategory === 'fthores') {
        pushHistory();
        el.fthora = glyphName;
        reanalyze();
        render();
        return;
      }
    }

    // Insert new element at cursor
    // Map SBMuFL glyph name to Neanes quantitative neume name
    const neume = SBMUFL_TO_NEUME[glyphName] || glyphName;
    const el = createNote(neume);
    // Store the SBMuFL glyph name + codepoint for rendering
    el._glyph = glyphName;
    el._codepoint = cp;
    insertElement(el);
  });
}

// ============================================================================
// GLYPH RESOLUTION
// ============================================================================

// Resolve the font character for a note element
function getNeumeChar(el) {
  // If we have a cached SBMuFL codepoint, use it
  if (el._codepoint) return codepointToChar(el._codepoint);
  // Try reverse mapping from Neanes name to SBMuFL
  const sbmufl = NEUME_TO_SBMUFL[el.quantitativeNeume];
  if (sbmufl && glyphnames[sbmufl]) {
    return codepointToChar(glyphnames[sbmufl].codepoint);
  }
  // Fallback: try the quantitative neume name directly as a glyph name
  if (glyphnames[el.quantitativeNeume]) {
    return codepointToChar(glyphnames[el.quantitativeNeume].codepoint);
  }
  return '?';
}

// Get support glyph characters for a note's modifiers
function getSupportGlyphs(el) {
  const above = [];
  const below = [];

  const addGlyph = (name) => {
    if (!name) return;
    // Try to find glyph in SBMuFL data
    const g = glyphnames[name];
    if (g) {
      const char = codepointToChar(g.codepoint);
      if (isBottomSupport(name)) below.push(char);
      else above.push(char);
    }
  };

  // Time signs and vocalExpression are drawn inline with the neume (neumeRun)
  addGlyph(el.fthora);
  addGlyph(el.accidental);

  return { above: above.join(''), below: below.join('') };
}

// ============================================================================
// SCORE RENDERER (Reflowable)
// ============================================================================

function render() {
  const scoreEl = document.getElementById('score-body');
  renderScoreHead();

  // Reflowable score content — neumes flow like text
  let html = '<div class="score-content">';

  // Insert point at start
  if (!viewOnly) html += insertPointHtml(0);

  // Martyriae read from a scan that the notes before them do not reach
  martyriaOff = viewOnly ? { at: new Set(), lines: new Map() } : scanChecks();

  // Pairs of notes one neume can write, unless their mark was dismissed
  const pairs = viewOnly ? [] : focusPairs();
  const pairAt = new Map(pairs.map(p => [p.idx, p]));

  for (let i = 0; i < score.elements.length; i++) {
    const el = score.elements[i];
    const analysis = analysisResult[i] || null;

    if (el.type === 'note') {
      html += noteColHtml(el, i, analysis, pairAt.get(i));
    } else if (el.type === 'martyria') {
      html += martyriaColHtml(el, i, analysis);
    } else if (el.type === 'rest') {
      html += restColHtml(el, i);
    } else if (el.type === 'barline') {
      html += `<div class="barline" data-idx="${i}"></div>`;
    } else if (el.type === 'sectionBreak') {
      html += `<div class="section-break" data-idx="${i}"></div>`;
    } else if (el.type === 'spacer') {
      html += `<div class="spacer" data-idx="${i}"></div>`;
    } else if (el.type === 'modeKey') {
      html += `<div class="mode-key-marker" data-idx="${i}" title="Mode key change"></div>`;
    } else if (isScanLine(el)) {
      // Transcription mode: the line of the scan, above the notes written for it
      if (showScan()) html += stripHtml(score.scan, el.line, { zoomed: zoomedLines.has(el.line), read: readOffer(el.line), off: martyriaOff.lines.get(el.line) || '' });
      else continue;      // hidden: no second insert point beside the last one
    }

    if (!viewOnly) html += insertPointHtml(i + 1);
  }

  // Words still waiting for notes, after the last one
  if (!viewOnly) {
    for (const l of lyricTail()) {
      html += `<div class="note-col lyric-only" aria-hidden="true"><span class="neume">&nbsp;</span>${lyricSpanHtml(l)}</div>`;
    }
  }

  html += '</div>'; // .score-content

  // Analysis info bar (shows current position)
  if (selectedIdx >= 0 && analysisResult[selectedIdx]) {
    const a = analysisResult[selectedIdx];
    html += `<div class="analysis-bar">`;
    html += `<span class="analysis-note">${a.noteName || '—'}</span>`;
    html += `<span class="analysis-scale">${a.currentScale || '—'}</span>`;
    html += `<span class="analysis-beat">m${a.beat?.measure || 1} b${a.beat?.beat || 1}</span>`;
    if (a.warnings?.length > 0) {
      html += `<span class="analysis-warn" title="${esc(a.warnings.join('; '))}">\u26A0</span>`;
    }
    html += `</div>`;
  }

  scoreEl.innerHTML = html;
  if (viewOnly) return;
  bindScoreEvents();
  // The scan's pictures come from this browser's store, after the first draw
  if (showScan()) loadPages(score.scan).then(got => { if (got) render(); });
  // Whether Claude can read lines here (for each empty line's Read button)
  if (showScan() && !readState && !readAsked) { readAsked = true; readStatus().then(st => { if (st.ready) render(); }); }

  // Update palette validity indicators
  renderPalette();
  renderPad();
}

// The neume with its quality sign in one run of text. Vareia has its own
// width and stands before the note; the other quality signs are zero-width
// marks the font hangs under the glyph before them.
function neumeRun(el) {
  const mark = (name) => (name && glyphnames[name] ? codepointToChar(glyphnames[name].codepoint) : '');
  // Time signs are zero-width marks the font attaches to the neume
  // (mark-to-base), so they go straight after it in the same text run
  const base = getNeumeChar(el) + mark(el.timeNeume) + mark(el.gorgonNeume);
  const q = el.vocalExpression;
  if (!q || !glyphnames[q]) return base;
  const qc = mark(q);
  return q === 'vareia' ? qc + base : base + qc;
}

// Room for the signs drawn with the neume: above (klasma, gorgon) and below
// (apli, dipli, quality marks)
function neumeClasses(el) {
  const time = [el.timeNeume, el.gorgonNeume].filter(n => n && glyphnames[n]);
  const above = time.some(n => !isBottomSupport(n));
  const below = time.some(n => isBottomSupport(n))
    || (el.vocalExpression && el.vocalExpression !== 'vareia');
  return `${above ? ' has-above' : ''}${below ? ' has-quality' : ''}`;
}

// Neume with all its signs, for the pad (above / run / below)
function noteGlyphHtml(el) {
  const { above, below } = getSupportGlyphs(el);
  return `<span class="neume-support">${above}</span>`
    + `<span class="pad-neume${neumeClasses(el)}">${neumeRun(el)}</span>`
    + `<span class="neume-support-below">${below}</span>`;
}

// The mark over a combinable pair: the combined neume, small and orange,
// standing over the join of the two notes. Shown only for the note in focus
function combineMarkHtml(pair) {
  const char = getNeumeChar(pair.merged);
  const label = esc(`Combine into ${pair.rule.name.toLowerCase()}`);
  return `<span class="combine-mark">`
    + `<button type="button" class="combine-go" data-combine="${pair.idx}" title="${label}" aria-label="${label}">`
    + `<span class="combine-glyph">${char}</span></button>`
    + `</span>`;
}

// Signs hung on a neume (antikenoma, heteron…) take no width of their own
// and can reach past it. Room on either side for the ink, in em.
const inkCache = new Map();
function inkSidesStyle(run) {
  if (!document.fonts?.check('32px Neanes')) return '';
  if (!inkCache.has(run)) {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = '32px Neanes';
    const m = measureCtx.measureText(run);
    const left = Math.max(0, m.actualBoundingBoxLeft) / 32;
    const right = Math.max(0, m.actualBoundingBoxRight - m.width) / 32;
    const em = (v) => (v > 0.02 ? `${(v + 0.05).toFixed(2)}em` : '0');
    inkCache.set(run, left > 0.02 || right > 0.02
      ? ` style="padding-left:${em(left)};padding-right:${em(right)}"` : '');
  }
  return inkCache.get(run);
}

function noteColHtml(el, idx, analysis, pair) {
  const char = neumeRun(el);
  const isSelected = idx === selectedIdx;
  const hasWarning = analysis?.warnings?.length > 0;
  const pending = el === placeholderEl ? ' placeholder' : '';
  const combine = pair ? ' combine-first' : '';
  // In Qual. the note being given a quality sign shows in purple
  const qual = isSelected && padMode === 'quality' ? ' qual-preview' : '';
  // A note Claude was unsure of, until it is checked (committed with Next)
  const unsure = el.unsure && !viewOnly ? ' unsure' : '';
  const cls = `note-col${isSelected ? ' selected' : ''}${hasWarning ? ' has-warning' : ''}${pending}${combine}${qual}${unsure}`;

  const { above, below } = getSupportGlyphs(el);

  let aboveHtml = above ? `<span class="neume-support">${above}</span>` : '';
  let belowHtml = below ? `<span class="neume-support-below">${below}</span>` : '';

  const lyricHtml = lyricSpanHtml(el.lyric);

  return `<div class="${cls}" data-idx="${idx}">
    ${pair ? combineMarkHtml(pair) : ''}
    ${aboveHtml}
    <span class="neume${neumeClasses(el)}"${inkSidesStyle(char)}>${char}</span>
    ${belowHtml}
    ${lyricHtml}
  </div>`;
}

// A held note shows the syllable going on: '-' inside a word, an extender
// line after the end of one (see lyrics.js)
function lyricSpanHtml(lyric) {
  if (lyric === '_') return '<span class="lyric lyric-extender"><span></span></span>';
  if (lyric === '-') return '<span class="lyric lyric-held">-</span>';
  return `<span class="lyric">${esc(lyric) || '&nbsp;'}</span>`;
}

function martyriaColHtml(el, idx, analysis) {
  const isSelected = idx === selectedIdx;
  const pending = el === placeholderEl ? ' placeholder' : '';
  // Tinted while Claude was unsure of it, or while the notes before it do
  // not reach the note the scan gives it
  const check = !viewOnly && (el.unsure || martyriaOff.at.has(idx)) ? ' unsure' : '';
  const cls = `note-col martyria-col${isSelected ? ' selected' : ''}${pending}${check}`;
  const chars = martyriaChars(analysis);
  const title = esc(`Martyria ${analysis?.noteName || ''}${el.scan ? ' (from the scan)' : el.auto === false ? '' : ' (auto)'}`);
  return `<div class="${cls}" data-idx="${idx}" title="${title}">
    <span class="martyria">${chars ? chars.note + chars.root : '?'}</span>
    <span class="lyric">&nbsp;</span>
  </div>`;
}

function restColHtml(el, idx) {
  const isSelected = idx === selectedIdx;
  const cls = `note-col rest-col${isSelected ? ' selected' : ''}${el.unsure && !viewOnly ? ' unsure' : ''}`;
  const title = esc(`Leimma · ${restLabel(el)}`);
  return `<div class="${cls}" data-idx="${idx}" title="${title}">
    <span class="neume">${glyphChar(el.glyph)}</span>
    <span class="lyric">&nbsp;</span>
  </div>`;
}

function insertPointHtml(idx) {
  const isActive = idx === cursorPos && selectedIdx < 0;
  return `<div class="insert-point${isActive ? ' active' : ''}" data-insert="${idx}"></div>`;
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================================
// EVENT HANDLING
// ============================================================================

function bindScoreEvents() {
  const scoreEl = document.getElementById('score');

  // The mark over a pair of notes combines them into one neume
  scoreEl.querySelectorAll('.combine-go').forEach(btn => {
    // In lyric mode the text field keeps focus, so the keyboard stays up
    const keepFocus = (e) => { if (lyricMode) e.preventDefault(); };
    btn.addEventListener('pointerdown', keepFocus);
    btn.addEventListener('mousedown', keepFocus);
  });
  scoreEl.querySelectorAll('.combine-go').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.combine);
      if (!combinePair(idx)) return;
      haptic();
      if (lyricMode) showLyricCaret(undefined, true);
      else refresh();
    });
  });

  // Transcription mode: a tap on a line of the scan enlarges it (and back);
  // its arrows move where the line starts, a note at a time
  scoreEl.querySelectorAll('.scan-strip').forEach(strip => {
    const k = parseInt(strip.dataset.scanLine);
    strip.querySelector('.scan-frame')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (zoomedLines.has(k)) zoomedLines.delete(k); else zoomedLines.add(k);
      strip.classList.toggle('zoomed', zoomedLines.has(k));
    });
    strip.querySelectorAll('.scan-shift').forEach(btn => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (shiftScanLine(k, parseInt(btn.dataset.scanShift))) { haptic(); refresh(); }
    }));
    strip.querySelector('[data-scan-read]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      readLines([k]);
    });
    strip.querySelector('[data-scan-checked]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      markChecked(k);
    });
    strip.querySelector('.scan-tools')?.addEventListener('click', (e) => e.stopPropagation());
  });

  scoreEl.querySelectorAll('.note-col[data-idx]').forEach(col => {
    col.addEventListener('click', (e) => {
      e.stopPropagation();
      tapNote(parseInt(col.dataset.idx));
    });
  });

  scoreEl.querySelectorAll('.insert-point').forEach(ip => {
    ip.addEventListener('click', (e) => {
      e.stopPropagation();
      let pos = parseInt(ip.dataset.insert);
      if (lyricMode) { document.getElementById('lyric-input').focus(); return; }
      const p = placeholderIndex();
      dropPlaceholder();
      if (p >= 0 && pos > p) pos--;
      enterBlank(pos);
      refresh();
    });
  });

  // Tapping empty space in the score (e.g. after the last line) puts the
  // cursor at the end, so you never have to hit the thin insert point.
  const content = scoreEl.querySelector('.score-content');
  content.addEventListener('click', (e) => {
    if (e.target !== content) return;
    if (lyricMode) { document.getElementById('lyric-input').focus(); return; }
    dropPlaceholder();
    enterBlank(score.elements.length);
    refresh();
  });
}

// A tap on a symbol in the score. The first tap only selects it (for the
// pad); a tap on the symbol already selected opens its words.
function tapNote(idx) {
  // In lyric mode a tap on a note starts the text from that note
  if (lyricMode) {
    if (score.elements[idx]?.type === 'note') startLyricsAt(idx);
    lyricInput().focus();
    return;
  }
  // Leaving a blank spot drops its untouched placeholder
  let dropped = false;
  if (score.elements[idx] !== placeholderEl) {
    const target = score.elements[idx];
    dropped = placeholderIndex() >= 0;
    dropPlaceholder();
    idx = score.elements.indexOf(target);
  }
  if (selectedIdx === idx) {
    if (score.elements[idx]?.type === 'note') enterLyricMode(idx);
  } else {
    selectedIdx = idx;
    cursorPos = idx + 1;
    if (dropped) reanalyze();     // the symbols moved up one: pitches follow
    render();
  }
}

// A quick second tap on the same symbol is the lyric tap. iOS would take it
// as a double-tap zoom (touch-action alone does not always stop it inside
// the scrolling score), so cancel it and handle the tap here; focusing the
// lyric field inside this touchend still brings the keyboard up.
function initDoubleTap() {
  const area = document.getElementById('score-area');
  let last = null;
  area.addEventListener('touchend', (e) => {
    if (e.touches.length || e.changedTouches.length !== 1) { last = null; return; }
    const t = e.changedTouches[0];
    const col = e.target.closest?.('.note-col[data-idx]');
    const idx = col ? parseInt(col.dataset.idx) : -1;
    // The first tap may re-render and renumber, so compare the symbol itself
    const el = idx >= 0 ? score.elements[idx] : null;
    const now = e.timeStamp;
    const again = last && el && last.el === el && now - last.time < 400
      && Math.hypot(t.clientX - last.x, t.clientY - last.y) < 30;
    if (again) {
      e.preventDefault();       // no zoom, and no click after it
      last = null;
      tapNote(idx);
      return;
    }
    last = el ? { el, time: now, x: t.clientX, y: t.clientY } : null;
  }, { passive: false });
}

// Insert a symbol from the Signs drawer at the focus. On a blank spot's
// pending symbol, the new one takes its place.
function insertElement(el) {
  dropPlaceholder();
  pushHistory();
  score.elements.splice(cursorPos, 0, el);
  focusSymbol(cursorPos);
  refresh();
}

// Cursor movement shared by the arrow keys and the Prev/Next buttons
function moveLeft() {
  const dropped = placeholderIndex() >= 0;
  dropPlaceholder();
  stepLeft();
  // The start of a line of the scan is not a symbol: step over it
  while (selectedIdx >= 0 && isScanLine(score.elements[selectedIdx])) stepLeft();
  if (dropped) reanalyze();       // the symbols after it moved up one
  render();
  scrollSelectionIntoView();
}

function stepLeft() {
  if (selectedIdx > 0) {
    selectedIdx--;
    cursorPos = selectedIdx + 1;
  } else if (selectedIdx < 0 && cursorPos > 0) {
    cursorPos--;
    selectedIdx = cursorPos;
  } else if (selectedIdx === 0) {
    // From the first element, step to the insert point before it
    selectedIdx = -1;
    cursorPos = 0;
  }
}

function moveRight() {
  if (selectedIdx >= 0 && score.elements[selectedIdx] === placeholderEl) placeholderEl = null;
  stepRight();
  while (selectedIdx >= 0 && isScanLine(score.elements[selectedIdx])) stepRight();
  render();
  scrollSelectionIntoView();
}

function stepRight() {
  if (selectedIdx >= 0 && selectedIdx < score.elements.length - 1) {
    selectedIdx++;
    cursorPos = selectedIdx + 1;
  } else if (selectedIdx >= 0) {
    // From the last element, step to the insert point at the end
    selectedIdx = -1;
    cursorPos = score.elements.length;
  } else if (cursorPos < score.elements.length) {
    selectedIdx = cursorPos;
    cursorPos++;
  }
}

function scrollSelectionIntoView() {
  const target = document.querySelector('.note-col.selected, .insert-point.active');
  target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ============================================================================
// TOOLBAR
// ============================================================================

function initToolbar() {
  const title = document.getElementById('score-title');
  title.addEventListener('input', () => {
    // One line in the score: a pasted newline becomes a space
    if (title.value.includes('\n')) title.value = title.value.replace(/\s*\n\s*/g, ' ');
    score.metadata.title = title.value;
    fitTitle();
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); title.blur(); }
  });
  title.addEventListener('blur', () => {
    title.value = title.value.trim();
    score.metadata.title = title.value;
  });

  const sub = document.getElementById('score-subtitle');
  sub.addEventListener('input', () => {
    score.metadata.subtitle = sub.value;
    fitSubtitle();
  });
  sub.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); sub.blur(); }
  });
  sub.addEventListener('blur', () => {
    sub.value = sub.value.trim();
    score.metadata.subtitle = sub.value;
    fitSubtitle();
  });

  const modeBtn = document.getElementById('score-mode');
  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modeMenu) closeModeMenu();
    else openModeMenu(modeBtn);
  });

  document.getElementById('btn-new').addEventListener('click', async () => {
    // Signed in, the open score is safe on the account, so no need to ask.
    if (storableScore().elements.length > 0 && !(await currentIsSaved())
        && !confirm('Start a new score? Current work will be lost.')) return;
    newScore();
  });

  document.getElementById('btn-export').addEventListener('click', () => window.print());

  initScan();

  document.getElementById('btn-lyric').addEventListener('click', () => enterLyricMode());

  document.getElementById('btn-palette').addEventListener('click', (e) => {
    const palette = document.getElementById('palette');
    palette.hidden = !palette.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!palette.hidden));
    e.currentTarget.classList.toggle('active', !palette.hidden);
    if (!palette.hidden) updateTabScrollCue();
  });

  document.getElementById('btn-space').addEventListener('click', () => {
    insertElement(createSpacer());
  });

  document.getElementById('btn-newline').addEventListener('click', () => {
    insertElement(createSectionBreak());
  });

  document.getElementById('btn-delete').addEventListener('click', () => {
    // On a blank spot's placeholder, Del works like backspace: it removes
    // the symbol before it and keeps the placeholder where it is.
    const p = placeholderIndex();
    if (p >= 0 && selectedIdx === p) {
      // With the scan hidden, the start of one of its lines is invisible:
      // backspace goes past it to the symbol before
      let t = p - 1;
      while (!showScan() && t >= 0 && isScanLine(score.elements[t])) t--;
      if (t < 0) return;
      if (!deleteKeepingWords(t)) return;
      focusSymbol(p - 1);     // the pending symbol moves back one
      refresh();
      return;
    }
    if (selectedIdx >= 0) {
      if (!deleteKeepingWords(selectedIdx)) return;
      enterBlank(Math.min(selectedIdx, score.elements.length));
      refresh();
    } else if (cursorPos > 0) {
      if (!deleteKeepingWords(cursorPos - 1)) return;
      cursorPos--;
      reanalyze();
      render();
    }
  });

  document.getElementById('btn-undo').addEventListener('click', undo);

  document.getElementById('btn-barline').addEventListener('click', () => {
    insertElement(createBarline());
  });

  document.getElementById('btn-martyria').addEventListener('click', () => {
    insertElement(createMartyria());
  });
}

// ============================================================================
// COMPOSE PAD (one-handed swipe editing)
// ============================================================================
//
// Focus is either a symbol (selectedIdx >= 0) or an empty slot at cursorPos
// (selectedIdx < 0). Symbols are only ever inserted on an empty slot.
// One vertical swipe is always exactly one increment.
//   Empty slot: swipe up/down inserts Ison (or, in martyria mode, the first
//               martyria option); tap inserts a repeat of the previous note
//               (or the first martyria option).
//   Note:       swipe up/down steps its interval one rung.
//   Martyria:   swipe up/down moves through the martyria options.
//   Swipe right / left changes the note's time: right lengthens it by a beat
//   (klasma, apli, dipli…), left shortens it (gorgon, digorgon…). Where the
//   note makes a combinable pair, the first swipe left combines it instead.
//   On a rest it steps the beats; on a martyria or a blank spot it moves.
//   Tap on a symbol (or the Next arrow) commits it and moves focus on (to
//   the next symbol, or to an empty slot after the last one); the small
//   left arrow goes back. A long press switches to Qual. for the next note
//   (the Qual. button keeps it on until it is tapped off).

const MIN_VALUE = -12;
const MAX_VALUE = 14;

// What a vertical swipe edits, chosen with the pad's corner toggles:
//   'quantity' (the default, no toggle on): the note's interval
//   'time'     (top-left, labelled Quant.): the note's time sign (klasma, gorgon...)
//   'quality'  (top-right): the note's quality sign (vareia, psifiston...)
//   'martyria' (bottom-left): blank spots hold martyriae; switches itself
//              off once one is committed
let padMode = 'quantity';
// Qual. from a long press is for one note; from its button it stays on
let qualOnce = false;
const PAD_MODE_BUTTONS = { time: 'pad-quant', quality: 'pad-qual', martyria: 'pad-mode' };

// Quality signs in the order a swipe up offers them (none first)
const QUALITY_SIGNS = ['psifiston', 'vareia', 'omalon', 'antikenoma', 'heteron', 'endofonon'];
const QUALITY_NAMES = {
  psifiston: 'Psifiston', vareia: 'Vareia', omalon: 'Omalon',
  antikenoma: 'Antikenoma', heteron: 'Heteron', endofonon: 'Endofonon',
};

// Which quality signs a neume can carry (vocalExpressionReplacements in
// neume-combinations.json, from Neanes)
function qualityAllowed(sign, neume) {
  const v = theory.neumeValues?.neumeValues?.[neume] ?? 0;
  const kentemata = /Kentemata/.test(neume);
  const descending = v < 0 && !/^(Petasti|Oligon)/.test(neume);
  const oligonPlusDescending = /^Oligon/.test(neume) && v <= 0;
  const running = ['Hyporoe', 'RunningElaphron', 'PetastiPlusRunningElaphron'].includes(neume);
  switch (sign) {
    case 'psifiston':
      return !kentemata && !descending && !running;
    case 'vareia':
      return !(kentemata && neume !== 'OligonPlusKentemata') && !running && !oligonPlusDescending;
    case 'omalon':
      return !/^Petasti/.test(neume) && !kentemata && !descending && !oligonPlusDescending;
    case 'antikenoma':
      return !kentemata && !['IsonPlusApostrophos', 'DoubleApostrophos', 'PetastiPlusRunningElaphron',
        'OligonPlusIson', 'OligonPlusApostrophos', 'OligonPlusElaphron', 'OligonPlusHyporoe',
        'OligonPlusElaphronPlusApostrophos', 'OligonPlusHamili'].includes(neume);
    case 'heteron':
      return ['Ison', 'Oligon', 'OligonPlusApostrophos', 'OligonPlusDoubleHypsili',
        'OligonPlusHypsiliLeft', 'OligonPlusHypsiliPlusKentimaHorizontal',
        'OligonPlusHypsiliPlusKentimaVertical', 'OligonPlusHypsiliRight', 'OligonPlusKentima',
        'OligonPlusKentimaAbove', 'OligonPlusKentimaBelow'].includes(neume);
    default:
      return true;
  }
}

// The Qual. ladder: none, then petasti (an ascending oligon-family note
// written as its petasti, the petasti's own expression), then the quality
// signs the plain neume can carry
function qualityOptions(el) {
  const plain = oligonFormOf(el.quantitativeNeume);
  const petasti = petastiFormOf(plain) ? ['petasti'] : [];
  return [null, ...petasti, ...QUALITY_SIGNS.filter(q => qualityAllowed(q, plain))];
}

function qualityOptionOf(el) {
  if (el.vocalExpression) return el.vocalExpression;
  return /^Petasti/.test(el.quantitativeNeume) && petastiFormOf(oligonFormOf(el.quantitativeNeume))
    ? 'petasti' : null;
}

function qualityLabel(q) {
  if (!q) return 'none';
  return q === 'petasti' ? 'Petasti' : QUALITY_NAMES[q] || q;
}

// Same interval, other family: Oligon <-> Petasti, OligonPlusKentimaBelow
// <-> PetastiPlusOligon, and so on (ascending neumes only)
function petastiFormOf(neume) {
  const v = theory.neumeValues?.neumeValues?.[neume];
  if (!/^Oligon/.test(neume) || !(v > 0) || isKentemata(neume)) return null;
  return Object.entries(theory.neumeValues.neumeValues)
    .find(([n, val]) => val === v && /^Petasti/.test(n) && NEUME_TO_SBMUFL[n])?.[0] || null;
}

function oligonFormOf(neume) {
  const v = theory.neumeValues?.neumeValues?.[neume];
  if (!/^Petasti/.test(neume) || !(v > 0)) return neume;
  return Object.entries(theory.neumeValues.neumeValues)
    .find(([n, val]) => val === v && /^Oligon/.test(n) && !isKentemata(n) && NEUME_TO_SBMUFL[n])?.[0] || neume;
}

// Put a rung of the Qual. ladder on a note
function setQuality(el, q) {
  const plain = oligonFormOf(el.quantitativeNeume);
  const neume = q === 'petasti' ? petastiFormOf(plain) : plain;
  if (neume !== el.quantitativeNeume) {
    el.quantitativeNeume = neume;
    delete el._glyph;
    delete el._codepoint;
    fitTimeSign(el);
  }
  el.vocalExpression = q === 'petasti' ? null : q;
}

// ----------------------------------------------------------------------------
// Time signs, on one ladder from shortest to longest: a swipe up lengthens
// the note by a beat (klasma, dipli, tripli, tetrapli), a swipe down shortens
// it (gorgon, digorgon, trigorgon). Validity follows timeReplacements and
// gorgonReplacements in neume-combinations.json (from Neanes).
// ----------------------------------------------------------------------------
const TIME_NAMES = {
  trigorgon: 'Trigorgon', digorgon: 'Digorgon', gorgonAbove: 'Gorgon', gorgonBelow: 'Gorgon',
  klasmaAbove: 'Klasma', klasmaBelow: 'Klasma', apli: 'Apli',
  dipli: 'Dipli', tripli: 'Tripli', tetrapli: 'Tetrapli',
};
// Rank on the ladder: beats added (>0) or notes sharing the beat (<0)
const TIME_RANK = {
  trigorgon: -3, digorgon: -2, gorgonAbove: -1, gorgonBelow: -1,
  gorgonDottedLeft: -1, gorgonDottedRight: -1,
  klasmaAbove: 1, klasmaBelow: 1, apli: 1, dipli: 2, tripli: 3, tetrapli: 4,
};
const TIME_BEATS = { '-3': '¼ beat', '-2': '⅓ beat', '-1': '½ beat', 0: '1 beat',
  1: '2 beats', 2: '3 beats', 3: '4 beats', 4: '5 beats' };

const OLIGON_DESCENDING = ['OligonPlusIson', 'OligonPlusApostrophos', 'OligonPlusElaphron',
  'OligonPlusHyporoe', 'OligonPlusElaphronPlusApostrophos', 'OligonPlusHamili'];
// Kentemata neumes end in kentemata; KentemataPlusOligon is an oligon
const isKentemata = (n) => /Kentemata|MiddleKentimata/.test(n) && n !== 'KentemataPlusOligon';

// The klasma a neume takes: above, or below when its top is crowded
function klasmaFor(neume) {
  if (isKentemata(neume)) return null;
  if (['Hyporoe', 'OligonPlusHyporoe', 'IsonPlusApostrophos', 'DoubleApostrophos'].includes(neume)) return null;
  if (/^Petasti/.test(neume) || /(Double|Triple)(Hypsili|Ypsili)/.test(neume)
      || OLIGON_DESCENDING.includes(neume)) return 'klasmaBelow';
  return 'klasmaAbove';
}

function apliAllowed(neume) {
  return !isKentemata(neume) && neume !== 'PetastiPlusRunningElaphron'
    && !OLIGON_DESCENDING.includes(neume);
}

function longTimeAllowed(neume) {     // dipli, tripli, tetrapli
  return !isKentemata(neume) && !/^Petasti/.test(neume) && neume !== 'KentemataPlusOligon'
    && neume !== 'OligonPlusKentimaBelow' && !OLIGON_DESCENDING.includes(neume);
}

function gorgonAllowed(neume) {
  return !/^Petasti/.test(neume) || neume === 'PetastiPlusHyporoe';
}

// The ladder for a note: [{ rank, time, gorgon }], shortest first
function timeOptions(el) {
  const n = el.quantitativeNeume;
  const options = [];
  if (gorgonAllowed(n)) {
    options.push({ rank: -3, time: null, gorgon: 'trigorgon' },
      { rank: -2, time: null, gorgon: 'digorgon' },
      { rank: -1, time: null, gorgon: 'gorgonAbove' });
  }
  options.push({ rank: 0, time: null, gorgon: null });
  // A beat more: the klasma, then the dot under the note (apli)
  const klasma = klasmaFor(n);
  if (klasma) options.push({ rank: 1, time: klasma, gorgon: null });
  if (apliAllowed(n)) options.push({ rank: 1, time: 'apli', gorgon: null });
  if (longTimeAllowed(n)) {
    options.push({ rank: 2, time: 'dipli', gorgon: null },
      { rank: 3, time: 'tripli', gorgon: null },
      { rank: 4, time: 'tetrapli', gorgon: null });
  }
  return options;
}

function timeRankOf(el) {
  if (el.gorgonNeume) return TIME_RANK[el.gorgonNeume] ?? 0;
  if (el.timeNeume) return TIME_RANK[el.timeNeume] ?? 0;
  return 0;
}

// The next rung up (dir 1) or down (dir -1) from the note's time sign.
// Klasma and apli share a rank, so the rung is found by its sign; a sign
// that is not on the ladder (one from the Signs drawer) steps by rank.
function timeStep(el, dir) {
  const rank = timeRankOf(el);
  const options = timeOptions(el);
  const sign = el.gorgonNeume || el.timeNeume || null;
  const i = options.findIndex(o => (o.gorgon || o.time) === sign);
  if (i >= 0) return options[i + dir] || null;
  return dir > 0
    ? options.find(o => o.rank > rank) || null
    : options.reverse().find(o => o.rank < rank) || null;
}

function timeLabel(opt) {
  const sign = opt.gorgon || opt.time;
  return sign ? TIME_NAMES[sign] || sign : 'none';
}

// After the neume changes, keep its time signs if the new neume can carry
// them (moving a klasma above or below as needed), otherwise drop them
function fitTimeSign(el) {
  const n = el.quantitativeNeume;
  if (TIME_RANK[el.gorgonNeume] < 0 && !gorgonAllowed(n)) el.gorgonNeume = null;
  const t = el.timeNeume;
  if (t === 'klasmaAbove' || t === 'klasmaBelow') {
    el.timeNeume = klasmaFor(n) || (apliAllowed(n) ? 'apli' : null);
  } else if (t === 'apli' && !apliAllowed(n)) {
    el.timeNeume = klasmaFor(n);
  } else if (['dipli', 'tripli', 'tetrapli'].includes(t) && !longTimeAllowed(n)) {
    el.timeNeume = null;
  }
}

// ----------------------------------------------------------------------------
// Combined neumes: two notes in a row that one neume writes more simply,
// usually so a syllable can sit over both.
//   Running elaphron: two apostrophoi in a row (two steps down). A gorgon
//     on the first is built into the running elaphron; the second note's
//     time sign is written on it
//   Kentemata on an oligon: two oligons in a row (two steps up); the
//     kentemata go on top, or underneath when a gorgon takes the top
//   A note on the oligon "table", then kentemata: ison, apostrophos,
//     elaphron, elaphron+apostrophos or hamili followed by an oligon
// The score marks each such pair and a tap (on the mark or the pad's
// Combine pill) swaps the two notes for the one neume.
// ----------------------------------------------------------------------------
const SIMPLE_GORGONS = ['gorgonAbove', 'gorgonBelow'];
const plainTime = (a) => !a.gorgonNeume && !a.timeNeume;
const isOligon = (b) => b.quantitativeNeume === 'Oligon';
const ON_OLIGON_TABLE = {
  Ison: ['OligonPlusIsonPlusKentemata', 'Ison and kentemata on an oligon'],
  Apostrophos: ['OligonPlusApostrophosPlusKentemata', 'Apostrophos and kentemata on an oligon'],
  Elaphron: ['OligonPlusElaphronPlusKentemata', 'Elaphron and kentemata on an oligon'],
  ElaphronPlusApostrophos: ['OligonPlusElaphronPlusApostrophosPlusKentemata',
    'Elaphron, apostrophos and kentemata on an oligon'],
  Hamili: ['OligonPlusHamiliPlusKentemata', 'Hamili and kentemata on an oligon'],
};
const COMBINE_RULES = [
  {
    result: 'RunningElaphron', name: 'Running elaphron',
    first: (a) => a.quantitativeNeume === 'Apostrophos'
      && (!a.gorgonNeume || SIMPLE_GORGONS.includes(a.gorgonNeume)) && !a.timeNeume,
    second: (b) => b.quantitativeNeume === 'Apostrophos',
  },
  {
    result: (a, b) => (b.gorgonNeume ? 'OligonPlusKentemata' : 'KentemataPlusOligon'),
    name: 'Kentemata on an oligon',
    first: (a) => a.quantitativeNeume === 'Oligon' && plainTime(a),
    second: isOligon,
  },
  ...Object.entries(ON_OLIGON_TABLE).map(([first, [result, name]]) => ({
    result, name,
    first: (a) => a.quantitativeNeume === first && plainTime(a),
    second: isOligon,
  })),
];

// The second note folds into the first, so it may only carry signs the
// combined neume keeps (its time sign). A syllable of its own moves on to
// the next note, pushing the words after it along to the first note
// without a syllable of its own (blank or a hold), which takes up the shift.
const HELD_LYRICS = ['', '_', '-'];
const ownSyllable = (el) => !HELD_LYRICS.includes(el.lyric || '');

// Words past the last note (score.lyricTail) wait there, shown without
// symbols, and flow onto the notes written after them: any notes at the
// end of the score that have no words take the next waiting syllables.
function lyricTail() {
  if (!Array.isArray(score.lyricTail)) score.lyricTail = [];
  return score.lyricTail;
}

function flowLyricTail() {
  const tail = lyricTail();
  if (!tail.length) return;
  const free = [];
  for (let j = score.elements.length - 1; j >= 0; j--) {
    const el = score.elements[j];
    if (el.type !== 'note' || el === placeholderEl) continue;
    if (el.lyric) break;
    free.unshift(el);
  }
  for (const el of free) {
    if (!tail.length) break;
    el.lyric = tail.shift();
  }
}

// Push the words on by one note from fromIdx, starting with `carry`, up to
// the first note without a syllable of its own; past the last note they
// join the waiting words
function pushWordsOn(fromIdx, carry) {
  const end = lyricShiftEnd(fromIdx);
  const stop = end < 0 ? score.elements.length - 1 : end;
  for (let j = fromIdx; j <= stop; j++) {
    const n = score.elements[j];
    if (n.type !== 'note' || n === placeholderEl) continue;
    [n.lyric, carry] = [carry, n.lyric];
  }
  if (end < 0 && ownSyllable({ lyric: carry })) lyricTail().unshift(carry);
}

function lyricShiftEnd(fromIdx) {
  for (let j = fromIdx; j < score.elements.length; j++) {
    const el = score.elements[j];
    // The pending note is not kept, so it cannot take words
    if (el.type === 'note' && el !== placeholderEl && !ownSyllable(el)) return j;
  }
  return -1;
}

// Delete a symbol but not the words: a note's own syllable moves on to the
// next note, pushing the words after it along to the first note without a
// syllable of its own (as when combining), or past the last note.
function deleteKeepingWords(idx) {
  const el = score.elements[idx];
  if (isScanLine(el)) {
    // The start of a line of the scan stays; its arrows move it
    toast(`This is where line ${el.line + 1} of the scan starts.`);
    return false;
  }
  pushHistory();
  if (el?.type === 'note' && ownSyllable(el)) pushWordsOn(idx + 1, el.lyric);
  score.elements.splice(idx, 1);
  return true;
}

function combinedNote(idx) {
  const a = score.elements[idx];
  const b = score.elements[idx + 1];
  if (a?.type !== 'note' || b?.type !== 'note') return null;
  if (a === placeholderEl || b === placeholderEl) return null;
  const found = COMBINE_RULES.find(r => r.first(a) && r.second(b));
  if (!found) return null;
  const rule = typeof found.result === 'function' ? { ...found, result: found.result(a, b) } : found;
  if (!NEUME_TO_SBMUFL[rule.result]) return null;
  if (b.fthora || b.accidental || b.vocalExpression || b.ison || b.measureBar) return null;
  if (a.vocalExpression && !qualityAllowed(a.vocalExpression, rule.result)) return null;
  const merged = { ...a, quantitativeNeume: rule.result,
    timeNeume: b.timeNeume || null, gorgonNeume: b.gorgonNeume || null };
  delete merged._glyph;
  delete merged._codepoint;
  fitTimeSign(merged);
  // A time sign the combined neume cannot carry would change the rhythm
  if (merged.timeNeume !== (b.timeNeume || null) || merged.gorgonNeume !== (b.gorgonNeume || null)) return null;
  return { rule, merged };
}

// Combinations offered for the note in focus, not across the whole score:
// with the note before it and with the note after it. On a blank spot (or
// its pending note) it is the pair just finished before it.
function focusPairs() {
  const focusEl = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
  const pending = !focusEl || focusEl === placeholderEl;
  const starts = pending
    ? [(selectedIdx >= 0 ? selectedIdx : cursorPos) - 2]
    : [selectedIdx - 1, selectedIdx];
  return starts.filter(i => i >= 0)
    .map(i => { const c = combinedNote(i); return c && { idx: i, ...c }; })
    .filter(Boolean);
}

// The pad's pill takes one: the pair that ends on the focused note (the one
// just written), else the one it starts
function pairAtFocus() {
  const pairs = focusPairs();
  return pairs[0] || null;
}

function combinePair(idx) {
  const c = combinedNote(idx);
  if (!c) return false;
  pushHistory();
  const b = score.elements[idx + 1];
  if (ownSyllable(b)) pushWordsOn(idx + 2, b.lyric);
  score.elements.splice(idx, 2, c.merged);
  if (selectedIdx > idx) selectedIdx--;
  if (cursorPos > idx + 1) cursorPos--;
  if (lyricMode) {
    if (lyricMode.start > idx) lyricMode.start--;
    restartLyricsAfterCombine(idx);
  }
  return true;
}

function intervalOf(el) {
  return theory.neumeValues?.neumeValues?.[el.quantitativeNeume] ?? 0;
}

// The default neume for an interval, preferring the current family
// (e.g. stepping a Petasti stays in the Petasti family when it can).
function neumeForValue(value, family) {
  const table = theory.neumeValues?.neumeValues || {};
  let first = null;
  for (const [name, v] of Object.entries(table)) {
    if (v !== value || !NEUME_TO_SBMUFL[name]) continue;
    if (family && value > 0 && name.startsWith(family)) return name;
    if (!first) first = name;
  }
  return first || 'Ison';
}

function familyOf(el) {
  return el?.quantitativeNeume?.startsWith('Petasti') ? 'Petasti' : null;
}

function setNoteValue(el, value, family) {
  el.quantitativeNeume = neumeForValue(value, family);
  delete el._glyph;       // render from the Neanes name, not a cached glyph
  delete el._codepoint;
}

function previousNote(beforeIdx) {
  for (let i = beforeIdx - 1; i >= 0; i--) {
    if (score.elements[i].type === 'note') return score.elements[i];
  }
  return null;
}

// ----------------------------------------------------------------------------
// Martyria options at a position, most likely first:
//   1. the pitch the melody has reached (an auto martyria), if any notes precede
//   2. the base notes of the current mode's styles (mode-keys.json templates),
//      the selected template's first
//   3. every other note, nearest to the first option first
// ----------------------------------------------------------------------------
function martyriaOptions(pos) {
  const options = [];
  const seen = new Set();
  const add = (value, auto) => {
    if (value === null || value < MIN_NOTE || value > MAX_NOTE || seen.has(value)) return;
    seen.add(value);
    options.push({ value, auto });
  };

  if (previousNote(pos)) {
    let before = null;
    for (let i = pos - 1; i >= 0 && before === null; i--) {
      if (typeof analysisResult[i]?.noteValue === 'number') before = analysisResult[i].noteValue;
    }
    add(before, true);
  }

  const mode = score.modeKey?.mode || 1;
  const templates = theory.modeKeys?.templates || [];
  const current = templates.find(t => t.id === score.modeKey?.templateId);
  if (current) add(noteValueOf(current.scaleNote), false);
  else add(noteValueOf(score.modeKey?.scaleNote), false);
  for (const t of templates) {
    if (t.mode === mode) add(noteValueOf(t.scaleNote), false);
  }

  const anchor = options.length ? options[0].value : 0;
  const rest = [];
  for (let v = MIN_NOTE; v <= MAX_NOTE; v++) rest.push(v);
  rest.sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor) || b - a);
  for (const v of rest) add(v, false);
  return options;
}

function martyriaFromOption(opt) {
  return opt.auto ? createMartyria() : createMartyriaOn(opt.value);
}

function scaleAt(pos) {
  for (let i = pos - 1; i >= 0; i--) {
    if (analysisResult[i]?.currentScale) return analysisResult[i].currentScale;
  }
  return score.modeKey?.scale || 'Diatonic';
}

// Preview characters for an option (before it is in the score)
function optionChars(opt, pos) {
  const m = computeMartyria(opt.value, scaleAt(pos), theory.martyriaRules);
  return glyphChar(martyriaNoteGlyph(opt.value)) + glyphChar(rootSignGlyph(m?.rootSign));
}

function optionIndexOf(el, idx, options) {
  const value = analysisResult[idx]?.noteValue;
  if (el.auto !== false) {
    const i = options.findIndex(o => o.auto);
    if (i >= 0) return i;
  }
  return options.findIndex(o => o.value === value);
}

function focusSymbol(idx) {
  selectedIdx = idx;
  cursorPos = idx + 1;
}

function focusEmptySlot(pos) {
  selectedIdx = -1;
  cursorPos = pos;
}

// The symbol a blank spot starts with: Ison, or in martyria mode the
// most likely martyria
function blankSymbol(pos) {
  return padMode === 'martyria' ? martyriaFromOption(martyriaOptions(pos)[0]) : createNote('Ison');
}

// Moving into a blank spot puts a pending symbol there and focuses it.
// It stays pending (dimmed, not saved) until it is changed or committed;
// leaving it any other way removes it again.
function enterBlank(pos) {
  dropPlaceholder();
  const el = blankSymbol(pos);
  score.elements.splice(pos, 0, el);
  placeholderEl = el;
  focusSymbol(pos);
}

// Remove an untouched placeholder, leaving focus on the empty slot it held
function dropPlaceholder() {
  const p = placeholderIndex();
  placeholderEl = null;
  if (p < 0) return;
  score.elements.splice(p, 1);
  if (selectedIdx === p) focusEmptySlot(p);
  else {
    if (selectedIdx > p) selectedIdx--;
    if (cursorPos > p) cursorPos--;
  }
}

// The placeholder becomes a real symbol once it is changed or committed
function keepPlaceholder() {
  placeholderEl = null;
}

function haptic() {
  try { navigator.vibrate?.(8); } catch (e) { /* unsupported */ }
}

function refresh() {
  reanalyze();
  render();
  scrollSelectionIntoView();
}

// Insert on the empty slot: a note (Ison or a repeat) or a martyria
function insertOnEmptySlot(kind) {
  pushHistory();
  let el;
  if (padMode === 'martyria') {
    el = martyriaFromOption(martyriaOptions(cursorPos)[0]);
  } else if (kind === 'repeat') {
    const prev = previousNote(cursorPos);
    el = createNote(prev ? prev.quantitativeNeume : 'Ison');
  } else {
    el = createNote('Ison');
  }
  score.elements.splice(cursorPos, 0, el);
  focusSymbol(cursorPos);
}

// Commit the focused symbol and move on: to the next symbol, or into a
// new blank spot (with its Ison) after the last one
function commitAndAdvance() {
  if (selectedIdx < 0) {
    // Empty slot: nothing to commit, but step onto the next symbol if any
    if (cursorPos < score.elements.length && !isScanLine(score.elements[cursorPos])) focusSymbol(cursorPos);
    else return false;
  } else {
    const committed = score.elements[selectedIdx];
    if (committed.unsure) { pushHistory(); delete committed.unsure; }   // checked
    if (committed.scan && martyriaOff.at.has(selectedIdx)) {
      // A martyria the notes do not reach, passed with Next: it stands as
      // the scan has it and sets the pitch, with no more said about it
      pushHistory();
      committed.auto = false;
      committed.noteValue = analysisResult[selectedIdx].noteValue;
      delete committed.scan;
    }
    if (committed === placeholderEl) {
      pushHistory();          // committing the pending symbol is an edit
      keepPlaceholder();
    }
    // Martyria mode is for one martyria: committing it goes back to notes.
    // Qual. from a long press is for one note too; from its button it stays
    if (padMode === 'martyria' && committed.type === 'martyria') setPadMode('quantity');
    if (padMode === 'quality' && qualOnce) setPadMode('quantity');
    // The end of a line of the scan is like the end of the score: a new
    // blank spot there, so the line can be written to its end
    if (selectedIdx < score.elements.length - 1 && !isScanLine(score.elements[selectedIdx + 1])) focusSymbol(selectedIdx + 1);
    else enterBlank(selectedIdx + 1);
  }
  return true;
}

function setPadMode(mode, once = false) {
  const wasMartyria = padMode === 'martyria';
  qualOnce = mode === 'quality' && once;
  padMode = mode;
  for (const id of new Set(Object.values(PAD_MODE_BUTTONS))) {
    const btn = document.getElementById(id);
    const on = PAD_MODE_BUTTONS[mode] === id;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  // A pending symbol switches with the mode (Ison <-> martyria)
  const p = placeholderIndex();
  if (p >= 0 && wasMartyria !== (mode === 'martyria')) {
    placeholderEl = null;
    score.elements.splice(p, 1);
    const el = blankSymbol(p);
    score.elements.splice(p, 0, el);
    placeholderEl = el;
    if (selectedIdx === p) focusSymbol(p);
    refresh();
  } else {
    renderPad();
  }
}

function initComposePad() {
  const pad = document.getElementById('pad');

  // Corner toggles; they must not start a pad gesture. Tapping the mode
  // that is on turns it off again (back to intervals, the default).
  const nextMode = {
    'pad-quant': () => (padMode === 'time' ? 'quantity' : 'time'),
    'pad-qual': () => (padMode === 'quality' ? 'quantity' : 'quality'),
    'pad-mode': () => (padMode === 'martyria' ? 'quantity' : 'martyria'),
  };
  for (const [id, next] of Object.entries(nextMode)) {
    const btn = document.getElementById(id);
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', () => {
      setPadMode(next());
      haptic();
    });
  }
  setPadMode('quantity');

  const combineBtn = document.getElementById('pad-combine');
  combineBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  combineBtn.addEventListener('click', () => {
    if (!combinePair(parseInt(combineBtn.dataset.combine))) return;
    haptic();
    refresh();
  });

  // Small arrows on the pad's sides: back (unlabelled) and Next
  const back = () => {
    dropPlaceholder();
    if (selectedIdx > 0) focusSymbol(selectedIdx - 1);
    else if (selectedIdx < 0 && cursorPos > 0) focusSymbol(cursorPos - 1);
    else { refresh(); return false; }
    return true;
  };
  for (const [id, go] of [['pad-prev', back], ['pad-next', commitAndAdvance]]) {
    const btn = document.getElementById(id);
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', () => {
      if (!go()) return;
      haptic();
      refresh();
    });
  }

  attachPad(pad, {
    onTap() {
      if (selectedIdx >= 0) {
        if (!commitAndAdvance()) return;
      } else {
        insertOnEmptySlot('repeat');
      }
      haptic();
      refresh();
    },

    onVertical(dir) {
      const el = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
      if (!el) {
        insertOnEmptySlot('ison');     // first swipe up or down gives Ison
      } else if (el.type === 'note' && padMode === 'quality') {
        const options = qualityOptions(el);
        const i = Math.max(0, options.indexOf(qualityOptionOf(el)));
        const next = Math.max(0, Math.min(options.length - 1, i + dir));
        if (next === i) return;
        pushHistory();
        if (el === placeholderEl) keepPlaceholder();
        setQuality(el, options[next]);
      } else if (el.type === 'note' && padMode === 'time') {
        const step = timeStep(el, dir);
        if (!step) return;
        pushHistory();
        if (el === placeholderEl) keepPlaceholder();
        el.timeNeume = step.time;
        el.gorgonNeume = step.gorgon;
      } else if (el.type === 'note') {
        pushHistory();
        if (el === placeholderEl) keepPlaceholder();
        const value = Math.max(MIN_VALUE, Math.min(MAX_VALUE, intervalOf(el) + dir));
        setNoteValue(el, value, familyOf(el));
        // Drop a quality sign the new neume cannot carry
        if (el.vocalExpression && QUALITY_SIGNS.includes(el.vocalExpression)
            && !qualityAllowed(el.vocalExpression, el.quantitativeNeume)) {
          el.vocalExpression = null;
        }
        fitTimeSign(el);
      } else if (el.type === 'rest') {
        const i = restBeats(el) - 1;
        const next = Math.max(0, Math.min(LEIMMATA.length - 1, i + dir));
        if (next === i) return;
        pushHistory();
        el.glyph = LEIMMATA[next];
      } else if (el.type === 'martyria' && (padMode === 'quantity' || padMode === 'martyria')) {
        const options = martyriaOptions(selectedIdx);
        const i = optionIndexOf(el, selectedIdx, options);
        const next = Math.max(0, Math.min(options.length - 1, (i < 0 ? 0 : i) + dir));
        if (next === i) return;
        pushHistory();
        if (el === placeholderEl) keepPlaceholder();
        score.elements[selectedIdx] = martyriaFromOption(options[next]);
      } else {
        return;
      }
      haptic();
      refresh();
    },

    // Sideways: the note's time. Right lengthens, left shortens; a pair
    // that can be combined is combined by the first swipe left.
    onSwipe(side) {
      const dir = side === 'right' ? 1 : -1;
      const el = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
      const pair = dir < 0 && !lyricMode ? pairAtFocus() : null;
      if (pair) {
        if (!combinePair(pair.idx)) return;
      } else if (el?.type === 'note') {
        const step = timeStep(el, dir);
        if (!step) return;
        pushHistory();
        if (el === placeholderEl) keepPlaceholder();
        el.timeNeume = step.time;
        el.gorgonNeume = step.gorgon;
      } else if (el?.type === 'rest') {
        const i = restBeats(el) - 1;
        const next = Math.max(0, Math.min(LEIMMATA.length - 1, i + dir));
        if (next === i) return;
        pushHistory();
        el.glyph = LEIMMATA[next];
      } else if (!(dir > 0 ? commitAndAdvance() : back())) {
        // A martyria or a blank spot has no time: the swipe moves instead
        return;
      }
      haptic();
      refresh();
    },

    // A long press switches to Qual. (quality signs) for this note; the
    // next commit switches back. A second long press leaves it at once.
    onLongPress() {
      setPadMode(padMode === 'quality' ? 'quantity' : 'quality', true);
      haptic();
      render();
    },
  });
}

function renderPad() {
  const glyphEl = document.getElementById('pad-glyph');
  const valueEl = document.getElementById('pad-value');
  const noteEl = document.getElementById('pad-note');
  const hintEl = document.getElementById('pad-hint');
  const pad = document.getElementById('pad');
  const el = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
  pad.classList.toggle('martyria-mode', padMode === 'martyria');
  pad.classList.toggle('quality-mode', padMode === 'quality');
  pad.classList.toggle('time-mode', padMode === 'time');
  glyphEl.classList.remove('martyria');
  renderPadCombine();

  if (el && el.type === 'note' && padMode === 'quality') {
    const a = analysisResult[selectedIdx];
    const options = qualityOptions(el);
    const current = qualityOptionOf(el);
    const i = Math.max(0, options.indexOf(current));
    const label = qualityLabel;
    pad.classList.remove('empty');
    glyphEl.innerHTML = noteGlyphHtml(el);
    valueEl.textContent = current ? qualityLabel(current) : 'No quality sign';
    noteEl.textContent = a?.noteName || '';
    noteEl.classList.toggle('warn', a?.warnings?.length > 0);
    const up = i < options.length - 1 ? `↑ ${label(options[i + 1])}` : '';
    const down = i > 0 ? `↓ ${label(options[i - 1])}` : '';
    hintEl.textContent = [up, down, 'Tap to commit'].filter(Boolean).join(' · ');
  } else if (el && el.type === 'note' && padMode === 'time') {
    const a = analysisResult[selectedIdx];
    const sign = el.gorgonNeume || el.timeNeume;
    const upStep = timeStep(el, 1);
    const downStep = timeStep(el, -1);
    pad.classList.remove('empty');
    glyphEl.innerHTML = noteGlyphHtml(el);
    valueEl.textContent = sign ? `${TIME_NAMES[sign] || sign} · ${TIME_BEATS[timeRankOf(el)]}` : '1 beat';
    noteEl.textContent = a?.noteName || '';
    noteEl.classList.toggle('warn', a?.warnings?.length > 0);
    const up = upStep ? `↑ ${timeLabel(upStep)}` : '';
    const down = downStep ? `↓ ${timeLabel(downStep)}` : '';
    hintEl.textContent = [up, down, 'Tap to commit'].filter(Boolean).join(' · ');
  } else if (el && el.type === 'note') {
    const v = intervalOf(el);
    const a = analysisResult[selectedIdx];
    pad.classList.remove('empty');
    glyphEl.innerHTML = noteGlyphHtml(el);
    const sign = el.gorgonNeume || el.timeNeume;
    valueEl.textContent = (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0')
      + (sign ? ` · ${TIME_NAMES[sign] || sign}` : '');
    noteEl.textContent = a?.noteName || '';
    noteEl.classList.toggle('warn', a?.warnings?.length > 0);
    const side = pairAtFocus() ? '← combine · → longer' : '← shorter · → longer';
    hintEl.textContent = el === placeholderEl
      ? `New note · ↕ interval · ${side}`
      : `↕ interval · ${side}`;
  } else if (el && el.type === 'martyria') {
    const a = analysisResult[selectedIdx];
    const chars = martyriaChars(a);
    const options = martyriaOptions(selectedIdx);
    const i = optionIndexOf(el, selectedIdx, options);
    pad.classList.remove('empty');
    glyphEl.classList.add('martyria');
    glyphEl.textContent = chars ? chars.note + chars.root : '';
    valueEl.textContent = el.auto === false ? 'Martyria' : 'Martyria (auto)';
    noteEl.textContent = a?.noteName || '';
    noteEl.classList.toggle('warn', a?.warnings?.length > 0);
    const up = options[i + 1] ? `↑ ${noteNameOf(options[i + 1].value)}` : '';
    const down = i > 0 ? `↓ ${noteNameOf(options[i - 1].value)}` : '';
    hintEl.textContent = padMode === 'quality' || padMode === 'time'
      ? `${padMode === 'time' ? 'Quant.' : 'Quality'} signs go on notes · Tap to commit`
      : [up, down, 'Tap to commit'].filter(Boolean).join(' · ');
  } else if (el && el.type === 'rest') {
    const i = restBeats(el) - 1;
    pad.classList.remove('empty');
    glyphEl.innerHTML = `<span class="pad-neume">${glyphChar(el.glyph)}</span>`;
    valueEl.textContent = `Leimma · ${restLabel(el)}`;
    noteEl.textContent = '';
    const up = i < LEIMMATA.length - 1 ? `↑ ${i + 2} beats` : '';
    const down = i > 0 ? `↓ ${i} beat${i > 1 ? 's' : ''}` : '';
    hintEl.textContent = [up, down, 'Tap to commit'].filter(Boolean).join(' · ');
  } else if (el) {
    pad.classList.remove('empty');
    glyphEl.textContent = '';
    valueEl.textContent = el.type;
    noteEl.textContent = '';
    hintEl.textContent = 'Tap or → next · ← back';
  } else {
    pad.classList.add('empty');
    glyphEl.textContent = '';
    valueEl.textContent = '';
    noteEl.textContent = '';
    if (padMode === 'martyria') {
      const first = martyriaOptions(cursorPos)[0];
      hintEl.textContent = `Swipe or tap for a martyria (${noteNameOf(first.value)} first)`;
    } else {
      hintEl.textContent = previousNote(cursorPos)
        ? 'Swipe ↕ for a new note · Tap to repeat'
        : 'Swipe up or down to start with Ison';
    }
  }
}

// The pad's Combine pill (bottom-right): offered while the pair being
// composed can be written as one neume, so it is under the thumb
function renderPadCombine() {
  const btn = document.getElementById('pad-combine');
  const pair = lyricMode ? null : pairAtFocus();
  btn.hidden = !pair;
  if (!pair) { delete btn.dataset.combine; return; }
  btn.dataset.combine = pair.idx;
  btn.querySelector('.combine-glyph').textContent = getNeumeChar(pair.merged);
  btn.title = `Combine into ${pair.rule.name.toLowerCase()}`;
  btn.setAttribute('aria-label', btn.title);
}

// ============================================================================
// LYRIC MODE
// ============================================================================

// One text field holds the words from a starting note on; every change lays
// its syllables under the notes again (lyrics.js). The field sits outside
// the score, which re-renders, so it keeps focus and the phone keyboard
// stays up: space simply moves the next letters to the next note.

let lyricMode = null;        // { start, edited } while open

let lyricAuto = true;
try { lyricAuto = localStorage.getItem('gorgon-lyric-auto') !== 'off'; } catch (e) { /* no storage */ }

const lyricInput = () => document.getElementById('lyric-input');

// Indices of the notes from `start` on: the ones the text is laid under
function lyricNotes(start) {
  const out = [];
  for (let i = start; i < score.elements.length; i++) {
    if (score.elements[i].type === 'note') out.push(i);
  }
  return out;
}

// Where Lyric starts: the note in focus, else the first note after the
// last one that has words, so pressing Lyric again carries on
function lyricStartNote() {
  const el = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
  if (el?.type === 'note') return selectedIdx;
  const notes = lyricNotes(0);
  if (!notes.length) return -1;
  let last = -1;
  notes.forEach((i, k) => { if (score.elements[i].lyric) last = k; });
  return notes[last + 1] ?? notes[0];
}

function enterLyricMode(idx) {
  const target = idx === undefined ? null : score.elements[idx];
  // Words for the pending note make it a real one; otherwise it goes
  if (target && target === placeholderEl) keepPlaceholder();
  dropPlaceholder();
  idx = target ? score.elements.indexOf(target) : lyricStartNote();
  if (idx < 0 || score.elements[idx]?.type !== 'note') {
    toast('Write the notes first, then their words.');
    return;
  }
  lyricMode = { start: idx, edited: false };
  document.body.classList.add('lyric-mode');
  document.getElementById('lyric-bar').hidden = false;
  document.getElementById('palette').hidden = true;
  const signs = document.getElementById('btn-palette');
  signs.classList.remove('active');
  signs.setAttribute('aria-expanded', 'false');
  renderLyricAuto();
  // Focus inside the tap that opened lyric mode, or iOS keeps the keyboard down
  lyricInput().focus();
  startLyricsAt(idx, target !== null);
}

// (Re)start the text at a note: what is already under the notes from there.
// Opened on a particular note, its syllable is selected so typing replaces
// it; otherwise the caret goes to the end to carry on.
function startLyricsAt(idx, selectFirst = true) {
  lyricMode.start = idx;
  const input = lyricInput();
  input.value = buildLyricText([...lyricNotes(idx).map(i => score.elements[i].lyric), ...lyricTail()]);
  const first = selectFirst ? lyricSlots()[0] : null;
  if (first) input.setSelectionRange(first.start, first.end);
  else input.setSelectionRange(input.value.length, input.value.length);
  input.scrollLeft = first ? 0 : input.scrollWidth;
  showLyricCaret(undefined, true);
}

// After a combine the words under the notes moved: rebuild the text and
// put the caret after the combined note's syllable
function restartLyricsAfterCombine(idx) {
  const input = lyricInput();
  input.value = buildLyricText([...lyricNotes(lyricMode.start).map(i => score.elements[i].lyric), ...lyricTail()]);
  const k = lyricNotes(lyricMode.start).indexOf(idx);
  const slot = k >= 0 ? lyricSlots()[k] : null;
  const at = slot ? slot.end : input.value.length;
  input.setSelectionRange(at, at);
  reanalyze();
}

function exitLyricMode() {
  if (!lyricMode) return;
  lyricMode = null;
  document.body.classList.remove('lyric-mode');
  document.getElementById('lyric-bar').hidden = true;
  lyricInput().blur();
  render();
}

function lyricSlots() {
  return parseLyricText(lyricInput().value, { auto: lyricAuto });
}

// Lay the text under the notes
function applyLyrics() {
  if (!lyricMode.edited) { pushHistory(); lyricMode.edited = true; }
  const slots = lyricSlots();
  const notes = lyricNotes(lyricMode.start).filter(i => score.elements[i] !== placeholderEl);
  notes.forEach((i, k) => {
    score.elements[i].lyric = slots[k]?.text || '';
  });
  // Words past the last note are kept, waiting for their notes
  score.lyricTail = slots.slice(notes.length).map(s => s.text);
  showLyricCaret(slots, true);
}

// Focus the note the caret is on, and say where the text stands
function showLyricCaret(slots = lyricSlots(), force = false) {
  const input = lyricInput();
  const notes = lyricNotes(lyricMode.start);
  const k = slotAtCaret(slots, input.value, input.selectionStart ?? input.value.length);
  const target = notes[Math.min(k, notes.length - 1)];
  const status = document.getElementById('lyric-status');
  const over = slots.length - notes.length;
  if (over > 0) status.textContent = `${over} without notes`;
  else if (k >= notes.length) status.textContent = 'No more notes';
  else status.textContent = `Note ${k + 1} / ${notes.length}`;
  status.title = over > 0 ? `${over} syllable${over > 1 ? 's' : ''} past the last note, kept until notes are written for them` : '';
  status.classList.toggle('warn', over > 0 || k >= notes.length);
  if (!force && target === selectedIdx) return;
  selectedIdx = target;
  cursorPos = target + 1;
  render();
  scrollNoteIntoArea(target);
}

// scrollIntoView would also scroll the pinned page under the iOS keyboard,
// so scroll only the score area
function scrollNoteIntoArea(idx) {
  const area = document.getElementById('score-area');
  const col = area.querySelector(`.note-col[data-idx="${idx}"]`);
  if (!col) return;
  const a = area.getBoundingClientRect();
  const c = col.getBoundingClientRect();
  const margin = 12;
  if (c.top < a.top + margin) area.scrollTop -= a.top + margin - c.top;
  else if (c.bottom > a.bottom - margin) area.scrollTop += c.bottom - (a.bottom - margin);
}

function insertIntoLyrics(str) {
  const input = lyricInput();
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(str, start, end, 'end');
  applyLyrics();
}

function renderLyricAuto() {
  const b = document.getElementById('lyric-auto');
  b.setAttribute('aria-pressed', String(lyricAuto));
  b.classList.toggle('active', lyricAuto);
}

function initLyricMode() {
  const input = lyricInput();
  input.addEventListener('input', applyLyrics);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      exitLyricMode();
    }
  });
  // Caret moved (arrows, tap in the field): follow it in the score
  document.addEventListener('selectionchange', () => {
    if (lyricMode && document.activeElement === input) showLyricCaret();
  });

  // The bar's buttons must not take focus from the field, or the phone
  // keyboard drops between keystrokes
  const bar = document.getElementById('lyric-bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });
  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });

  document.getElementById('lyric-hyphen').addEventListener('click', () => {
    input.focus();
    insertIntoLyrics('-');
  });
  document.getElementById('lyric-hold').addEventListener('click', () => {
    input.focus();
    // A hold goes in after a selected syllable, holding it over the next
    // note and pushing the rest of the words on, rather than replacing it
    const at = input.selectionEnd ?? input.value.length;
    input.setSelectionRange(at, at);
    insertIntoLyrics('_');
  });
  document.getElementById('lyric-auto').addEventListener('click', () => {
    lyricAuto = !lyricAuto;
    try { localStorage.setItem('gorgon-lyric-auto', lyricAuto ? 'on' : 'off'); } catch (e) { /* no storage */ }
    renderLyricAuto();
    input.focus();
    applyLyrics();
  });
  document.getElementById('lyric-done').addEventListener('click', exitLyricMode);
}

// ============================================================================
// KEYBOARD
// ============================================================================

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveLeft();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveRight();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      document.getElementById('btn-delete').click();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      enterLyricMode();
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      undo();
    }
  });
}

// ============================================================================
// TRANSCRIPTION MODE (scan.js): a scan of a score, line by line, above the
// notes written for each line. A { type: 'scanline', line: k } element marks
// where line k starts; it draws nothing when the scan is hidden or printed.
// ============================================================================

const SCAN_VIEW_KEY = 'gorgon-scan-view';
let scanHidden = (() => { try { return localStorage.getItem(SCAN_VIEW_KEY) === 'hidden'; } catch { return false; } })();
const zoomedLines = new Set();

const isScanLine = (el) => el?.type === 'scanline';
const hasScan = () => !!score.scan?.lines?.length;
const showScan = () => !viewOnly && !scanHidden && hasScan();

function setScanHidden(hidden) {
  scanHidden = hidden;
  try { localStorage.setItem(SCAN_VIEW_KEY, hidden ? 'hidden' : 'shown'); } catch { /* storage refused */ }
  refresh();
}

// Lay new cuts over the score. Lines already placed keep their places (only
// their part of the page changes); lines added go after the last notes and
// lines taken away go. On a score without a scan the lines are spread over
// its notes evenly (the heading gets none), to be set right with the arrows.
function applyScan(pages) {
  dropPlaceholder();
  pushHistory();
  const lines = linesFromPages(pages);
  const oldPages = score.scan?.pages || [];
  const oldLines = score.scan?.lines || [];
  lines.forEach((l, k) => { if (oldLines[k]?.by) l.by = oldLines[k].by; });
  score.scan = { pages: pages.map(({ id, w, h, musicTop }) => ({ id, w, h, ...(musicTop ? { musicTop } : {}) })), lines };
  // The lines above the music (title, tone): no notes, nothing to read
  const head = headingLines(lines, pages);
  lines.forEach((l, k) => { if (k < head) l.heading = true; });
  for (const p of oldPages) if (!pages.some(q => q.id === p.id)) deletePage(p.id);
  zoomedLines.clear();

  const placed = score.elements.filter(isScanLine).length;
  if (placed) {
    let k = 0;
    score.elements = score.elements.filter(el => {
      if (!isScanLine(el)) return true;
      if (k >= lines.length) return false;
      el.line = k++;
      return true;
    });
    while (k < lines.length) score.elements.push({ type: 'scanline', line: k++ });
  } else {
    const els = score.elements;
    const n = els.length;
    const body = Math.max(1, lines.length - head);
    const startOf = (k) => (k < head ? 0 : Math.round((k - head) * n / body));
    const out = [];
    let k = 0;
    for (let i = 0; i <= n; i++) {
      while (k < lines.length && startOf(k) === i) out.push({ type: 'scanline', line: k++ });
      if (i < n) out.push(els[i]);
    }
    score.elements = out;
    // A new score starts under the first line of music
    if (!n) { enterBlank(Math.min(head + 1, out.length)); scanHidden = false; refresh(); return; }
  }
  scanHidden = false;
  enterBlank(score.elements.length);
  refresh();
}

// Move where line k starts by one symbol: back takes the last symbol of the
// line before into it, on gives its first symbol to the line before
function shiftScanLine(k, dir) {
  const focus = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
  const keepFocus = focus && focus !== placeholderEl ? focus : null;
  dropPlaceholder();
  const els = score.elements;
  const m = els.findIndex(el => isScanLine(el) && el.line === k);
  const j = m + dir;
  if (m < 0 || j < 0 || j >= els.length || isScanLine(els[j])) return false;
  pushHistory();
  [els[m], els[j]] = [els[j], els[m]];
  if (keepFocus) focusSymbol(els.indexOf(keepFocus));
  else focusEmptySlot(Math.min(cursorPos, els.length));
  return true;
}

// ----------------------------------------------------------------------------
// Reading lines with Claude (lib/read.js): a line of the scan goes to the
// Worker, which asks Claude for its notes. Signed in only, a monthly number
// of lines per account. The notes land under the line, the ones Claude was
// unsure of tinted until checked (Next). Lines written by hand on this score
// go along as examples of how this scribe writes.
// ----------------------------------------------------------------------------

const READ_API = '/api/admin/read-line';
let readState = null;          // { signedIn, ready, used, cap } once asked
let readAsked = false;
const readingLines = new Set();
let readingScore = null;       // the score a read is filling (stops if another opens)

async function readStatus(force = false) {
  if (readState && !force) return readState;
  const res = await fetch(READ_API, { cache: 'no-store', redirect: 'manual', credentials: 'same-origin' }).catch(() => null);
  if (!res || res.type === 'opaqueredirect' || res.status === 401 || res.status === 0) readState = { signedIn: false };
  else if (!res.ok) readState = { signedIn: false, off: true };
  else {
    const j = await res.json().catch(() => ({}));
    readState = { signedIn: true, ready: !!j.ready, used: j.used || 0, cap: j.cap || 0 };
  }
  return readState;
}

function lineRange(k) {
  const els = score.elements;
  const m = els.findIndex(el => isScanLine(el) && el.line === k);
  if (m < 0) return null;
  let e = m + 1;
  while (e < els.length && !isScanLine(els[e])) e++;
  return [m + 1, e];
}

function lineEmpty(k) {
  const r = lineRange(k);
  return !!r && score.elements.slice(r[0], r[1]).every(el => el === placeholderEl);
}

const readable = (k) => !score.scan?.lines?.[k]?.heading && lineEmpty(k);

// The per-line button: Read on an empty line of music once reading is on;
// Checked on a line Claude wrote, until it is tapped
function readOffer(k) {
  if (readingLines.has(k)) return 'busy';
  if (score.scan?.lines?.[k]?.by === 'claude' && !lineEmpty(k)) return 'check';
  return readState?.ready && readable(k) ? 'offer' : '';
}

// A martyria is the scribe's own check of the melody: the notes before it
// must arrive on the note it names. One read from a scan keeps that note
// (el.scan), and the analysis says when the notes reach another (off). Here:
// which martyriae to tint, and what to say on their line of the scan. Not
// said across a line still empty, where the notes have not been written.
let martyriaOff = { at: new Set(), lines: new Map() };
const NOTE_SAID = ['Pa', 'Vou', 'Ga', 'Di', 'Ke', 'Zo', 'Ni'];
const noteSaid = (v) => NOTE_SAID[((v % 7) + 7) % 7];

function scanChecks() {
  const at = new Set();
  const lines = new Map();
  let line = -1;
  let written = 0;
  let gap = false;
  score.elements.forEach((el, i) => {
    if (isScanLine(el)) {
      if (line >= 0 && !written && !score.scan?.lines?.[line]?.heading) gap = true;
      line = el.line;
      written = 0;
      return;
    }
    if (el === placeholderEl) return;
    written++;
    if (el.type !== 'martyria') return;
    const a = analysisResult[i];
    if (el.scan && a?.off && !gap) {
      at.add(i);
      if (!lines.has(line)) lines.set(line, `Notes reach ${noteSaid(a.reached)}, martyria says ${noteSaid(a.noteValue)}`);
    }
    if (el.scan || el.auto === false) gap = false;
  });
  return { at, lines };
}

// The line is right now: its tints go, and it becomes an example of this
// scribe's hand for the lines read after it
function markChecked(k) {
  const r = lineRange(k);
  const line = score.scan?.lines?.[k];
  if (!r || !line) return;
  pushHistory();
  for (const el of score.elements.slice(r[0], r[1])) delete el.unsure;
  line.by = 'checked';
  haptic();
  refresh();
  const more = score.scan.lines.some((_, j) => readable(j));
  toast(more ? `Line ${k + 1} checked. Claude follows it on the lines it reads next.` : `Line ${k + 1} checked.`);
}

// A written element as the reader's symbols (examples), and back
function symbolOf(el) {
  if (el.type === 'martyria') {
    const v = analysisResult[score.elements.indexOf(el)]?.noteValue;
    const note = typeof v === 'number' ? noteSaid(v).toLowerCase() : '';
    return { kind: 'martyria', neume: '', note, time: '', gorgon: '', quality: '', lyric: '', unsure: false };
  }
  if (el.type === 'rest') return { kind: 'rest', neume: '', note: '', time: '', gorgon: '', quality: '', lyric: '', unsure: false };
  return {
    kind: 'note', neume: el.quantitativeNeume, note: '', time: el.timeNeume || '', gorgon: el.gorgonNeume || '',
    quality: el.vocalExpression || '', lyric: el.lyric || '', unsure: false,
  };
}

const READ_TIMES = ['klasmaAbove', 'klasmaBelow', 'apli', 'dipli', 'tripli', 'tetrapli'];
const READ_GORGONS = ['gorgonAbove', 'gorgonBelow', 'digorgon', 'trigorgon'];
const READ_NOTES = ['ni', 'pa', 'vou', 'ga', 'di', 'ke', 'zo'];
function elementOf(sym) {
  if (sym.kind === 'martyria' || sym.kind === 'rest') {
    const el = sym.kind === 'rest' ? createRest('leimma1') : createMartyria();
    // The note the scan's martyria names: kept, to check the notes by
    if (sym.kind === 'martyria' && READ_NOTES.includes(sym.note)) el.scan = sym.note;
    if (sym.unsure) el.unsure = true;
    return el;
  }
  if (theory.neumeValues?.neumeValues?.[sym.neume] === undefined) return null;
  const el = createNote(sym.neume, String(sym.lyric || '').slice(0, 40));
  if (READ_TIMES.includes(sym.time)) el.timeNeume = sym.time;
  if (READ_GORGONS.includes(sym.gorgon)) el.gorgonNeume = sym.gorgon;
  if (sym.quality && glyphnames[sym.quality]) el.vocalExpression = sym.quality;
  fitTimeSign(el);
  if (sym.unsure) el.unsure = true;
  return el;
}

// Up to two lines of this score written by hand, or read by Claude and
// then checked, nearest first
async function readExamples(k) {
  const lines = score.scan.lines;
  const order = lines.map((_, j) => j).filter(j => j !== k).sort((a, b) => Math.abs(a - k) - Math.abs(b - k));
  const out = [];
  for (const j of order) {
    if (out.length >= 2) break;
    if (!exampleLine(j)) continue;
    const r = lineRange(j);
    const els = score.elements.slice(r[0], r[1]).filter(el => el !== placeholderEl && ['note', 'martyria', 'rest'].includes(el.type));
    const image = await lineJpeg(score.scan, j);
    if (image) out.push({ image, symbols: els.map(symbolOf) });
  }
  return out;
}

function insertRead(k, els) {
  const r = lineRange(k);
  if (!r) return;
  pushHistory();
  const focus = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
  const pos = cursorPos;
  score.elements.splice(r[0], 0, ...els);
  if (focus) focusSymbol(score.elements.indexOf(focus));
  else if (pos >= r[0]) cursorPos = pos + els.length;
  score.scan.lines[k].by = 'claude';
}

// Whether a line could serve as an example (as readExamples chooses them)
function exampleLine(j) {
  const line = score.scan.lines[j];
  if (line.heading || line.by === 'claude') return false;
  const r = lineRange(j);
  return !!r && score.elements.slice(r[0], r[1]).filter(el => el !== placeholderEl && ['note', 'martyria', 'rest'].includes(el.type)).length >= 3;
}

async function readLines(ks) {
  if (readingScore) return toast('Already reading. One moment.');
  const st = await readStatus(true);
  if (!st.signedIn) return toast(st.off ? 'Reading by Claude is not available here.' : 'Sign in to have Claude read the lines.');
  if (!st.ready) return toast('Reading by Claude is not switched on for this site yet.');
  let todo = ks.filter(readable);
  if (!todo.length) return toast('No empty lines to read.');
  // The first line of a score nobody has written a line of yet is read on
  // its own: checked, it shows Claude this scribe's hand for all the rest,
  // rather than the same slip being made on every line
  const lines = score.scan.lines;
  const first = todo.length > 1 && !lines.some(l => l.by === 'claude') && !lines.some((_, j) => exampleLine(j));
  if (first) todo = todo.slice(0, 1);
  readingScore = score;
  let done = 0;
  try {
    for (const k of todo) {
      if (score !== readingScore) break;
      if (!readable(k)) continue;
      readingLines.add(k);
      render();
      toast(todo.length > 1 ? `Reading line ${k + 1} (${done + 1} of ${todo.length})…` : `Reading line ${k + 1}…`);
      const image = await lineJpeg(score.scan, k);
      if (!image) { toast('The scan is not on this device, so its lines cannot be read here.'); break; }
      const body = { image, mode: currentMode(), examples: await readExamples(k) };
      const res = await fetch(READ_API, {
        method: 'POST', credentials: 'same-origin', redirect: 'manual',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }).catch(() => null);
      const got = res && res.status !== 0 ? await res.json().catch(() => null) : null;
      readingLines.delete(k);
      if (!res || !res.ok || !got) {
        toast(got?.error || 'Could not read the line just now. Try again in a moment.');
        break;
      }
      if (score !== readingScore) break;
      readState.used = got.used ?? readState.used;
      const els = (got.symbols || []).map(elementOf).filter(Boolean);
      if (els.length && readable(k)) insertRead(k, els);
      done++;
      reanalyze();
      render();
    }
  } finally {
    readingScore = null;
    readingLines.clear();
    if (score.scan) { reanalyze(); render(); }
  }
  if (done && first) {
    toast(`Read line ${todo[0] + 1} first. Set it right and tap Checked: Claude then follows your corrections on the other lines.`, 9000);
  } else if (done) {
    const unsure = score.elements.filter(el => el.unsure).length;
    toast(`Read ${done} line${done === 1 ? '' : 's'}.${unsure ? ` ${unsure} to check (tinted); Next on a note marks it checked.` : ''}`);
  }
}

function removeScan() {
  dropPlaceholder();
  pushHistory();
  for (const p of score.scan?.pages || []) deletePage(p.id);
  delete score.scan;
  score.elements = score.elements.filter(el => !isScanLine(el));
  zoomedLines.clear();
  enterBlank(score.elements.length);
  refresh();
}

async function importScan(add = false) {
  const files = await pickFiles();
  if (!files.length) return;
  toast('Reading the scan…');
  let pages;
  try { pages = await importFiles(files); } catch (e) {
    console.warn('scan import', e);
    toast('Could not read that file. Try a photo (JPEG, PNG) or a PDF.');
    return;
  }
  document.getElementById('toast').hidden = true;
  const before = add && hasScan() ? cutsFromLines(score.scan) : [];
  const done = await openCutter([...before, ...pages]);
  if (!done) { for (const p of pages) deletePage(p.id); return; }
  applyScan(done);
}

async function adjustScan() {
  await loadPages(score.scan);
  const done = await openCutter(cutsFromLines(score.scan));
  if (done) applyScan(done);
}

function renderScanSheet() {
  const sheet = document.getElementById('scan-sheet');
  const body = sheet.querySelector('.sheet-body');
  if (!hasScan()) {
    body.innerHTML = `
      <p class="share-note">Add a photo or PDF of a printed or handwritten score. Gorgon cuts it into its lines and shows each one above the notes you write for it, so you can check them line by line.</p>
      <div class="sheet-actions"><button type="button" class="header-btn accent" data-scan-add>Choose photo or PDF</button></div>`;
    return;
  }
  const n = score.scan.lines.length;
  const pages = score.scan.pages.length;
  body.innerHTML = `
    <div class="sheet-label">This score's scan</div>
    <p class="share-note">${pages} page${pages === 1 ? '' : 's'}, ${n} line${n === 1 ? '' : 's'}. Each line shows above its notes; tap it to enlarge it, and use its arrows if a line starts a note too early or late.</p>
    ${readSheetHtml()}
    <div class="scan-sheet-row">
      <span>Show the scan</span>
      <button type="button" class="header-btn${scanHidden ? '' : ' accent'}" data-scan-toggle aria-pressed="${!scanHidden}">${scanHidden ? 'Off' : 'On'}</button>
    </div>
    <div class="sheet-actions scan-actions">
      <button type="button" class="header-btn" data-scan-remove>Remove</button>
      <button type="button" class="header-btn" data-scan-more>Add pages</button>
      <button type="button" class="header-btn" data-scan-adjust>Adjust lines</button>
    </div>`;
}

function readSheetHtml() {
  const st = readState;
  if (!st) return '<div class="sheet-label">Read with Claude</div><p class="share-note">Checking…</p>';
  if (!st.signedIn) return `<div class="sheet-label">Read with Claude</div><p class="share-note">${st.off ? 'Not available here.' : 'Sign in, and Claude can write the notes of each line for you to check.'}</p>`;
  if (!st.ready) return '<div class="sheet-label">Read with Claude</div><p class="share-note">Not switched on for this site yet.</p>';
  const n = score.scan.lines.filter((_, k) => readable(k)).length;
  return `<div class="sheet-label">Read with Claude</div>
    <p class="share-note">Claude writes the notes of each empty line; the ones it is unsure of are tinted until you check them. Tap Checked on a line once it is right, and Claude follows it on the lines it reads next. ${st.used} of ${st.cap} lines read this month.</p>
    <div class="sheet-actions"><button type="button" class="header-btn accent" data-scan-readall ${n ? '' : 'disabled'}>${n ? `Read ${n} empty line${n === 1 ? '' : 's'}` : 'No empty lines'}</button></div>`;
}

function initScan() {
  const btn = document.getElementById('btn-scan');
  const sheet = document.getElementById('scan-sheet');
  if (!btn || !sheet) return;
  const close = () => { sheet.hidden = true; };
  btn.addEventListener('click', () => {
    if (!hasScan()) return importScan();
    renderScanSheet();
    sheet.hidden = false;
    readStatus(true).then(() => { if (!sheet.hidden) renderScanSheet(); render(); });
  });
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) return close();
    if (e.target.closest('[data-scan-add]')) { close(); importScan(); }
    else if (e.target.closest('[data-scan-more]')) { close(); importScan(true); }
    else if (e.target.closest('[data-scan-adjust]')) { close(); adjustScan(); }
    else if (e.target.closest('[data-scan-readall]')) { close(); readLines(score.scan.lines.map((_, k) => k)); }
    else if (e.target.closest('[data-scan-toggle]')) { setScanHidden(!scanHidden); renderScanSheet(); }
    else if (e.target.closest('[data-scan-remove]')) {
      if (!confirm('Remove the scan from this score? The notes stay.')) return;
      close();
      removeScan();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
}

// ============================================================================
// LOCAL STORAGE
// ============================================================================

// Replace the open score (a new one, or one opened from the account)
function openScore(next) {
  // One step of insurance: the score being put away stays in this browser
  // until the next switch, whatever the account did with it.
  try {
    const prev = localStorage.getItem('gorgon-score-v2');
    if (prev) localStorage.setItem('gorgon-score-v2-previous', prev);
  } catch (e) { /* storage refused */ }
  exitLyricMode();
  score = next;
  score.metadata = score.metadata || {};
  if (!score.metadata.id) score.metadata.id = newDocId();
  placeholderEl = null;
  history = [];
  analysisResult = [];
  zoomedLines.clear();
  enterBlank(score.elements.length);
  refresh();
  saveToLocal();
}

function newScore() {
  openScore(createScore());
}

let toastTimer = 0;
function toast(msg, ms = 5000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function saveToLocal() {
  if (viewOnly) return;   // a shared score never lands on this browser's own
  try {
    localStorage.setItem('gorgon-score-v2', JSON.stringify(storableScore()));
  } catch (e) { /* storage full */ }
}

function loadFromLocal() {
  try {
    const saved = localStorage.getItem('gorgon-score-v2');
    if (saved) {
      score = JSON.parse(saved);
      // Scores saved before accounts have no id: give this one its own, kept
      // with it from now on, so it joins the account as itself on sign-in.
      score.metadata = score.metadata || {};
      if (!score.metadata.id) {
        score.metadata.id = newDocId();
        localStorage.setItem('gorgon-score-v2', JSON.stringify(score));
      }
    }
  } catch (e) { /* corrupt */ }
}

if (!viewOnly) setInterval(saveToLocal, 5000);

// ============================================================================
// INIT
// ============================================================================

// Keep the app shell inside the visible area on mobile browsers.
// dvh handles Safari's collapsing toolbars, but iOS does not shrink the layout
// viewport for the on-screen keyboard; it overlays it and scrolls the page.
// visualViewport tells us the real visible box, so size (and when the keyboard
// is up, pin) the body to it.
function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let raf = 0;

  const update = () => {
    raf = 0;
    // Pinch-zoomed: visualViewport is the zoomed box, leave layout alone.
    if (vv.scale > 1.01) return;
    const layoutH = root.clientHeight;
    const keyboardOpen = layoutH - vv.height > 100;
    root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
    document.body.classList.toggle('keyboard-open', keyboardOpen);
    document.body.classList.toggle('vv-pinned', keyboardOpen);
    if (!keyboardOpen && window.scrollY !== 0) window.scrollTo(0, 0);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  update();
}

async function init() {
  if (viewOnly) return initView();
  initViewport();
  await loadData();
  loadFromLocal();
  initPaletteTabs();
  renderPalette();
  initPaletteGrid();
  initToolbar();
  initKeyboard();
  initComposePad();
  initLyricMode();
  initDoubleTap();
  // Open on a blank spot at the end of the score
  enterBlank(score.elements.length);
  reanalyze();
  render();
  const accountReady = initAccount({ getScore: storableScore, openScore, newScore, toast, saveLocal: saveToLocal, previewImage, previewKey });
  const copyOf = new URLSearchParams(location.search).get('copy');
  if (copyOf) accountReady.then(() => openCopyOf(copyOf));
}

// ============================================================================
// LINK PREVIEW: the picture a chat app shows for a shared link (1200 × 630):
// the title, the subtitle and mode, then the first notes with their words.
// Drawn here, where the font and the analysis are at hand, and kept on the
// account beside the share (account.js, lib/documents.js).
// ============================================================================

const PREVIEW_W = 1200;
const PREVIEW_H = 630;

async function previewImage() {
  try { await document.fonts.load('96px Neanes'); } catch (e) { /* drawn with what loaded */ }
  const c = document.createElement('canvas');
  c.width = PREVIEW_W;
  c.height = PREVIEW_H;
  const ctx = c.getContext('2d');
  const M = 72;                           // margin
  const ink = '#0b0b0d';
  const muted = '#6b6b70';
  const red = '#cc0000';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);

  // Title, shrunk to one line
  const title = String(score.metadata?.title || '').trim() || 'Untitled';
  let size = 64;
  ctx.fillStyle = ink;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const titleFont = (px) => `700 ${px}px Georgia, 'Times New Roman', serif`;
  ctx.font = titleFont(size);
  while (size > 38 && ctx.measureText(title).width > PREVIEW_W - 2 * M) ctx.font = titleFont(--size);
  ctx.fillText(fitText(ctx, title, PREVIEW_W - 2 * M), M, M + size * 0.8);
  let y = M + size * 0.8;

  // Subtitle · mode
  const sub = [String(score.metadata?.subtitle || '').trim(), modeLabels[currentMode()] || '']
    .filter(Boolean).join('  ·  ');
  ctx.font = `30px Georgia, 'Times New Roman', serif`;
  ctx.fillStyle = muted;
  y += 52;
  ctx.fillText(fitText(ctx, sub, PREVIEW_W - 2 * M), M, y);

  // The notes, line by line, each with its syllable
  const NEUME = 84;
  const LYRIC = 32;
  const LINE = 150;
  const lyricFont = `${LYRIC}px Georgia, 'Times New Roman', serif`;
  const neumeFont = `${NEUME}px Neanes`;
  const footY = PREVIEW_H - 16;      // the music runs to the bottom
  let base = y + 30 + NEUME;     // neume baseline of the first line
  let x = M;
  const cols = [];
  const els = score.elements;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (el === placeholderEl) continue;
    let col = null;
    if (el.type === 'note') {
      col = { run: neumeRun(el), lyric: el.lyric || '', supports: getSupportGlyphs(el) };
    } else if (el.type === 'martyria') {
      const chars = martyriaChars(analysisResult[i]);
      if (chars) col = { run: chars.note + chars.root, lyric: '', color: red, lift: NEUME * 0.28 };
    } else if (el.type === 'rest') {
      col = { run: glyphChar(el.glyph), lyric: '' };
    } else if (el.type === 'spacer') {
      x += 28;
    } else if (el.type === 'barline') {
      col = { bar: true };
    } else if (el.type === 'sectionBreak') {
      cols.push({ newline: true });
    }
    if (col) cols.push(col);
  }

  for (const col of cols) {
    if (col.newline) {
      if (x === M) continue;
      x = M;
      base += LINE;
      if (base + LYRIC + 30 > footY) break;
      continue;
    }
    let w;
    let inkLeft = 0;
    let inkW = 0;
    if (col.bar) {
      w = 24;
    } else {
      ctx.font = neumeFont;
      ctx.textAlign = 'left';
      const m = ctx.measureText(col.run);
      // The ink runs from x - left to x + right (left < 0: it starts after x)
      inkLeft = m.actualBoundingBoxLeft;
      inkW = Math.max(1, inkLeft + m.actualBoundingBoxRight);
      ctx.font = lyricFont;
      const lw = col.lyric && col.lyric !== '_' && col.lyric !== '-' ? ctx.measureText(col.lyric).width : 0;
      w = Math.max(inkW, lw, NEUME * 0.3) + 22;
    }
    if (x + w > PREVIEW_W - M && x > M) {
      x = M;
      base += LINE;
    }
    if (base + LYRIC + 30 > footY) break;
    const cx = x + w / 2;
    if (col.bar) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, base - NEUME * 0.75);
      ctx.lineTo(cx, base + 6);
      ctx.stroke();
    } else {
      ctx.font = neumeFont;
      ctx.textAlign = 'left';
      ctx.fillStyle = col.color || ink;
      ctx.fillText(col.run, cx - inkW / 2 + inkLeft, base - (col.lift || 0));
      if (col.supports?.above) {
        ctx.font = `${NEUME * 0.66}px Neanes`;
        ctx.fillStyle = red;
        ctx.textAlign = 'center';
        ctx.fillText(col.supports.above, cx, base - NEUME * 0.7);
      }
      // Syllable, a held one's dash, or the extender line after a word
      const ly = base + NEUME * 0.2 + LYRIC;
      if (col.lyric === '_') {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, ly);
        ctx.lineTo(x + w, ly);
        ctx.stroke();
      } else if (col.lyric) {
        ctx.font = lyricFont;
        ctx.textAlign = 'center';
        ctx.fillStyle = col.lyric === '-' ? muted : ink;
        ctx.fillText(col.lyric, cx, ly);
      }
    }
    x += w;
  }

  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

// Cut text to a width with an ellipsis
function fitText(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > width) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

// What the preview shows, to tell when it needs drawing again
function previewKey() {
  const s = storableScore();
  return JSON.stringify([s.metadata?.title, s.metadata?.subtitle, currentMode(), s.elements.slice(0, 40)]);
}

// ============================================================================
// VIEW MODE (a shared link, read only) and copying it into the editor
// ============================================================================

async function fetchShared(token) {
  const res = await fetch('/api/shared/' + encodeURIComponent(token), { cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return null;
  const got = await res.json().catch(() => null);
  return got && got.score && Array.isArray(got.score.elements) ? got : null;
}

const VIEW_ZOOMS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
const VIEW_ZOOM_KEY = 'gorgon-view-zoom';

async function initView() {
  document.body.classList.add('view-mode');
  const title = document.getElementById('score-title');
  title.readOnly = true;
  title.tabIndex = -1;
  const sub = document.getElementById('score-subtitle');
  sub.readOnly = true;
  sub.tabIndex = -1;
  document.getElementById('score-mode').disabled = true;
  const body = document.getElementById('score-body');

  for (const a of document.querySelectorAll('#btn-copy, #btn-copy-foot')) {
    a.href = SHARED_TOKEN ? '/?copy=' + SHARED_TOKEN : '/';
  }

  // Text size, kept for the next shared score this browser opens
  let zi = VIEW_ZOOMS.indexOf(1);
  try {
    const saved = parseFloat(localStorage.getItem(VIEW_ZOOM_KEY));
    if (VIEW_ZOOMS.includes(saved)) zi = VIEW_ZOOMS.indexOf(saved);
  } catch (e) { /* storage refused */ }
  const applyZoom = () => {
    document.documentElement.style.setProperty('--view-zoom', VIEW_ZOOMS[zi]);
    document.getElementById('btn-smaller').disabled = zi === 0;
    document.getElementById('btn-larger').disabled = zi === VIEW_ZOOMS.length - 1;
    try { localStorage.setItem(VIEW_ZOOM_KEY, String(VIEW_ZOOMS[zi])); } catch (e) { /* storage refused */ }
  };
  document.getElementById('btn-smaller').addEventListener('click', () => { zi = Math.max(0, zi - 1); applyZoom(); });
  document.getElementById('btn-larger').addEventListener('click', () => { zi = Math.min(VIEW_ZOOMS.length - 1, zi + 1); applyZoom(); });
  applyZoom();

  const [got] = await Promise.all([SHARED_TOKEN ? fetchShared(SHARED_TOKEN) : null, loadData()]);
  if (!got) {
    document.body.classList.add('view-missing');
    title.value = 'Link not found';
    fitTitle();
    document.getElementById('score-mode').hidden = true;
    for (const a of document.querySelectorAll('#btn-copy, #btn-copy-foot')) { a.href = '/'; a.textContent = 'Open Gorgon'; }
    for (const b of document.querySelectorAll('.size-btn')) b.hidden = true;
    body.innerHTML = '<p class="view-missing-note">This score isn\'t shared any more, or the link is mistyped. Ask whoever sent it for a new link.</p>';
    document.title = 'Gorgon — Byzantine chant';
    return;
  }
  score = got.score;
  score.metadata = score.metadata || {};
  selectedIdx = -1;
  cursorPos = -1;
  reanalyze();
  render();
  fitTitle();
  if (document.fonts?.ready) document.fonts.ready.then(() => { inkCache.clear(); render(); });
  keepAwake();
}

// The phone stays awake while someone chants from the page
let wakeLock = null;
function keepAwake() {
  if (!navigator.wakeLock) return;
  const ask = () => {
    if (wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then((l) => {
      wakeLock = l;
      l.addEventListener('release', () => { wakeLock = null; });
    }).catch(() => { /* not allowed until the page is touched */ });
  };
  ask();
  document.addEventListener('visibilitychange', ask);
  document.addEventListener('pointerdown', ask, { passive: true });
}

// /?copy=<token>: "Edit a copy" from a shared page. The copy is the reader's
// own score from here on, with an id of its own.
async function openCopyOf(token) {
  const clean = () => window.history.replaceState(null, '', '/');   // (`history` here is undo)
  const got = await fetchShared(token);
  if (!got) { clean(); toast('That score isn\'t shared any more, so there is nothing to copy.'); return; }
  const mine = storableScore();
  if (mine.elements.length > 0 && !(await currentIsSaved())) {
    const t = String(mine.metadata?.title || '').trim();
    const ok = confirm(`Open your copy? The score open here${t ? ` ("${t}")` : ''} is only in this browser, so it will be replaced. Sign in first to keep both.`);
    if (!ok) { clean(); return; }
  }
  const copy = got.score;
  const now = new Date().toISOString();
  copy.metadata = { ...copy.metadata, id: newDocId(), created: now, modified: now };
  openScore(copy);
  clean();
  toast('This copy is yours to change. The original stays as it was.');
}

init();
