// Gorgon — Byzantine Notation Writer (v2)
// GPL-3.0

import { createScore, createNote, createMartyria, createModeKey,
         createBarline, createSectionBreak, createSpacer,
         SBMUFL_TO_NEUME, NEUME_TO_SBMUFL } from './models.js';
import { analyzeScore, computeMartyria } from './analysis.js';
import { attachPad } from './gestures.js';
import { initAccount, currentIsSaved, newDocId } from './account.js';
import { parseLyricText, buildLyricText, slotAtCaret } from './lyrics.js';

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
    const char = codepointToChar(g.codepoint);
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
      <span class="glyph">${char}</span>
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
  html += insertPointHtml(0);

  // Pairs of notes one neume can write
  const pairs = combinablePairs();
  const pairAt = new Map(pairs.map(p => [p.idx, p]));

  for (let i = 0; i < score.elements.length; i++) {
    const el = score.elements[i];
    const analysis = analysisResult[i] || null;

    if (el.type === 'note') {
      html += noteColHtml(el, i, analysis, pairAt.get(i));
    } else if (el.type === 'martyria') {
      html += martyriaColHtml(el, i, analysis);
    } else if (el.type === 'barline') {
      html += `<div class="barline" data-idx="${i}"></div>`;
    } else if (el.type === 'sectionBreak') {
      html += `<div class="section-break" data-idx="${i}"></div>`;
    } else if (el.type === 'spacer') {
      html += `<div class="spacer" data-idx="${i}"></div>`;
    } else if (el.type === 'modeKey') {
      html += `<div class="mode-key-marker" data-idx="${i}" title="Mode key change"></div>`;
    }

    html += insertPointHtml(i + 1);
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
  bindScoreEvents();

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
// standing over the join of the two notes
function combineMarkHtml(pair) {
  const char = getNeumeChar(pair.merged);
  const label = esc(`Combine into ${pair.rule.name.toLowerCase()}`);
  return `<button type="button" class="combine-mark" data-combine="${pair.idx}" title="${label}" aria-label="${label}">`
    + `<span class="combine-glyph">${char}</span></button>`;
}

function noteColHtml(el, idx, analysis, pair) {
  const char = neumeRun(el);
  const isSelected = idx === selectedIdx;
  const hasWarning = analysis?.warnings?.length > 0;
  const pending = el === placeholderEl ? ' placeholder' : '';
  const combine = pair ? ' combine-first' : '';
  const cls = `note-col${isSelected ? ' selected' : ''}${hasWarning ? ' has-warning' : ''}${pending}${combine}`;

  const { above, below } = getSupportGlyphs(el);

  let aboveHtml = above ? `<span class="neume-support">${above}</span>` : '';
  let belowHtml = below ? `<span class="neume-support-below">${below}</span>` : '';

  const lyricHtml = lyricSpanHtml(el.lyric);

  return `<div class="${cls}" data-idx="${idx}">
    ${pair ? combineMarkHtml(pair) : ''}
    ${aboveHtml}
    <span class="neume${neumeClasses(el)}">${char}</span>
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
  const cls = `note-col martyria-col${isSelected ? ' selected' : ''}${pending}`;
  const chars = martyriaChars(analysis);
  const title = esc(`Martyria ${analysis?.noteName || ''}${el.auto === false ? '' : ' (auto)'}`);
  return `<div class="${cls}" data-idx="${idx}" title="${title}">
    <span class="martyria">${chars ? chars.note + chars.root : '?'}</span>
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
  scoreEl.querySelectorAll('.combine-mark').forEach(btn => {
    // In lyric mode the text field keeps focus, so the keyboard stays up
    const keepFocus = (e) => { if (lyricMode) e.preventDefault(); };
    btn.addEventListener('pointerdown', keepFocus);
    btn.addEventListener('mousedown', keepFocus);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.combine);
      if (!combinePair(idx)) return;
      haptic();
      if (lyricMode) showLyricCaret(undefined, true);
      else refresh();
    });
  });

  scoreEl.querySelectorAll('.note-col').forEach(col => {
    col.addEventListener('click', (e) => {
      e.stopPropagation();
      let idx = parseInt(col.dataset.idx);
      // In lyric mode a tap on a note starts the text from that note
      if (lyricMode) {
        if (score.elements[idx]?.type === 'note') startLyricsAt(idx);
        document.getElementById('lyric-input').focus();
        return;
      }
      // Leaving a blank spot drops its untouched placeholder
      if (score.elements[idx] !== placeholderEl) {
        const target = score.elements[idx];
        dropPlaceholder();
        idx = score.elements.indexOf(target);
      }
      // Tapping the syllable line of a note goes straight to lyric editing
      const tappedLyric = e.target.classList.contains('lyric');
      if (tappedLyric && score.elements[idx]?.type === 'note') {
        enterLyricMode(idx);
        return;
      }
      if (selectedIdx === idx) {
        if (score.elements[idx]?.type === 'note') enterLyricMode(idx);
      } else {
        selectedIdx = idx;
        cursorPos = idx + 1;
        render();
      }
    });
  });

  scoreEl.querySelectorAll('.insert-point').forEach(ip => {
    ip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (lyricMode) { document.getElementById('lyric-input').focus(); return; }
      let pos = parseInt(ip.dataset.insert);
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
  dropPlaceholder();
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
  render();
  scrollSelectionIntoView();
}

function moveRight() {
  if (selectedIdx >= 0 && score.elements[selectedIdx] === placeholderEl) placeholderEl = null;
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
  render();
  scrollSelectionIntoView();
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
      if (p === 0) return;
      pushHistory();
      score.elements.splice(p - 1, 1);
      focusSymbol(p - 1);
      refresh();
      return;
    }
    if (selectedIdx >= 0) {
      pushHistory();
      score.elements.splice(selectedIdx, 1);
      enterBlank(Math.min(selectedIdx, score.elements.length));
      refresh();
    } else if (cursorPos > 0) {
      pushHistory();
      cursorPos--;
      score.elements.splice(cursorPos, 1);
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
//   Tap on a symbol, or swipe right, commits it and moves focus on (to the
//   next symbol, or to an empty slot after the last one). Swipe left goes back.

const MIN_VALUE = -12;
const MAX_VALUE = 14;

// What a vertical swipe edits, chosen with the pad's corner toggles:
//   'quantity' (top-left, the default): the note's interval
//   'time'     (top-left tapped again): the note's time sign (klasma, gorgon...)
//   'quality'  (top-right): the note's quality sign (vareia, psifiston...)
//   'martyria' (bottom-left): blank spots hold martyriae; switches itself
//              off once one is committed
let padMode = 'quantity';
const PAD_MODE_BUTTONS = { quantity: 'pad-quant', time: 'pad-quant', quality: 'pad-qual', martyria: 'pad-mode' };

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
  const beat = klasmaFor(n) || (apliAllowed(n) ? 'apli' : null);
  if (beat) options.push({ rank: 1, time: beat, gorgon: null });
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

// The next rung up (dir 1) or down (dir -1) from the note's time sign
function timeStep(el, dir) {
  const rank = timeRankOf(el);
  const options = timeOptions(el);
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
//   Running elaphron: an apostrophos with a gorgon, then another apostrophos
//     (two steps down; the running elaphron carries the first gorgon itself,
//     so only the second note's time sign is written on it)
//   Kentemata over an oligon: two oligons in a row (two steps up)
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
      && SIMPLE_GORGONS.includes(a.gorgonNeume) && !a.timeNeume,
    second: (b) => b.quantitativeNeume === 'Apostrophos',
  },
  {
    result: 'KentemataPlusOligon', name: 'Kentemata over an oligon',
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
// without words, which takes up the shift.
const HELD_LYRICS = ['', '_', '-'];
const ownSyllable = (el) => !HELD_LYRICS.includes(el.lyric || '');

function lyricShiftEnd(fromIdx) {
  for (let j = fromIdx; j < score.elements.length; j++) {
    const el = score.elements[j];
    if (el.type === 'note' && !(el.lyric || '')) return j;
  }
  return -1;
}

function combinedNote(idx) {
  const a = score.elements[idx];
  const b = score.elements[idx + 1];
  if (a?.type !== 'note' || b?.type !== 'note') return null;
  if (a === placeholderEl || b === placeholderEl) return null;
  const rule = COMBINE_RULES.find(r => r.first(a) && r.second(b));
  if (!rule || !NEUME_TO_SBMUFL[rule.result]) return null;
  if (b.fthora || b.accidental || b.vocalExpression || b.ison || b.measureBar) return null;
  if (ownSyllable(b) && lyricShiftEnd(idx + 2) < 0) return null;
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

// Every combinable pair, left to right; a note belongs to one pair at most
function combinablePairs() {
  const pairs = [];
  for (let i = 0; i < score.elements.length - 1; i++) {
    const c = combinedNote(i);
    if (c) { pairs.push({ idx: i, ...c }); i++; }
  }
  return pairs;
}

// The pair the composer is working on: the one the focused note belongs
// to, or the one just finished before a blank spot
function pairAtFocus(pairs = combinablePairs()) {
  const focusEl = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
  const pending = !focusEl || focusEl === placeholderEl;
  const at = pending ? (selectedIdx >= 0 ? selectedIdx : cursorPos) - 1 : selectedIdx;
  return pairs.find(p => p.idx === at || p.idx + 1 === at) || null;
}

function combinePair(idx) {
  const c = combinedNote(idx);
  if (!c) return false;
  pushHistory();
  const b = score.elements[idx + 1];
  if (ownSyllable(b)) {
    // Push the words on by one note, up to the first note without any
    let carry = b.lyric;
    const end = lyricShiftEnd(idx + 2);
    for (let j = idx + 2; j <= end; j++) {
      const el = score.elements[j];
      if (el.type !== 'note') continue;
      [el.lyric, carry] = [carry, el.lyric];
    }
  }
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
    if (cursorPos < score.elements.length) focusSymbol(cursorPos);
    else return false;
  } else {
    const committed = score.elements[selectedIdx];
    if (committed === placeholderEl) {
      pushHistory();          // committing the pending symbol is an edit
      keepPlaceholder();
    }
    // Martyria mode is for one martyria: committing it goes back to notes
    if (padMode === 'martyria' && committed.type === 'martyria') setPadMode('quantity');
    if (selectedIdx < score.elements.length - 1) focusSymbol(selectedIdx + 1);
    else enterBlank(score.elements.length);
  }
  return true;
}

function setPadMode(mode) {
  const wasMartyria = padMode === 'martyria';
  padMode = mode;
  for (const id of new Set(Object.values(PAD_MODE_BUTTONS))) {
    const btn = document.getElementById(id);
    const on = PAD_MODE_BUTTONS[mode] === id;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  // The top-left toggle is Quant. or, tapped again, Time
  const quant = document.getElementById('pad-quant');
  quant.textContent = mode === 'time' ? 'Time' : 'Quant.';
  quant.title = mode === 'time'
    ? 'Time: swipe up lengthens the note (klasma, dipli…), down shortens it (gorgon…). Tap for Quant.'
    : 'Quantity: swipes change the note\'s interval. Tap again for time signs';
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
  // that is on turns it off again (back to quantity); tapping Quant. while
  // it is on switches it to Time, and back.
  const nextMode = {
    'pad-quant': () => (padMode === 'quantity' ? 'time' : 'quantity'),
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

    onSwipe(dir) {
      if (dir === 'right') {
        if (!commitAndAdvance()) return;
      } else {
        dropPlaceholder();
        if (selectedIdx > 0) focusSymbol(selectedIdx - 1);
        else if (selectedIdx < 0 && cursorPos > 0) focusSymbol(cursorPos - 1);
        else { refresh(); return; }
      }
      haptic();
      refresh();
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
    valueEl.textContent = v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0';
    noteEl.textContent = a?.noteName || '';
    noteEl.classList.toggle('warn', a?.warnings?.length > 0);
    hintEl.textContent = el === placeholderEl
      ? 'New note · Swipe ↕ to change · Tap to keep Ison'
      : 'Swipe ↕ to change · Tap to commit';
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
      ? `${padMode === 'time' ? 'Time' : 'Quality'} signs go on notes · Tap to commit`
      : [up, down, 'Tap to commit'].filter(Boolean).join(' · ');
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
  input.value = buildLyricText(lyricNotes(idx).map(i => score.elements[i].lyric));
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
  input.value = buildLyricText(lyricNotes(lyricMode.start).map(i => score.elements[i].lyric));
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
  lyricNotes(lyricMode.start).forEach((i, k) => {
    score.elements[i].lyric = slots[k]?.text || '';
  });
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
  if (over > 0) status.textContent = `${over} left over`;
  else if (k >= notes.length) status.textContent = 'No more notes';
  else status.textContent = `Note ${k + 1} / ${notes.length}`;
  status.title = over > 0 ? `${over} syllable${over > 1 ? 's' : ''} past the last note (not kept)` : '';
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
    // A hold goes in before a selected syllable, pushing it (and the rest
    // of the words) on to the next note, rather than replacing it
    const at = input.selectionStart ?? input.value.length;
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
  enterBlank(score.elements.length);
  refresh();
  saveToLocal();
}

function newScore() {
  openScore(createScore());
}

let toastTimer = 0;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

function saveToLocal() {
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

setInterval(saveToLocal, 5000);

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
  // Open on a blank spot at the end of the score
  enterBlank(score.elements.length);
  reanalyze();
  render();
  initAccount({ getScore: storableScore, openScore, newScore, toast, saveLocal: saveToLocal });
}

init();
