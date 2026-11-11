// Gorgon — Byzantine Notation Writer (v2)
// GPL-3.0

import { createScore, createNote, createMartyria, createModeKey,
         createBarline, createSectionBreak, createSpacer,
         SBMUFL_TO_NEUME, NEUME_TO_SBMUFL } from './models.js';
import { analyzeScore, computeMartyria } from './analysis.js';
import { attachPad } from './gestures.js';
import { initAccount, currentIsSaved, newDocId } from './account.js';

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
let editingLyricIdx = -1;
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
  editingLyricIdx = -1;
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

  addGlyph(el.timeNeume);
  addGlyph(el.gorgonNeume);
  addGlyph(el.vocalExpression);
  addGlyph(el.fthora);
  addGlyph(el.accidental);

  return { above: above.join(''), below: below.join('') };
}

// ============================================================================
// SCORE RENDERER (Reflowable)
// ============================================================================

function render() {
  const scoreEl = document.getElementById('score');
  const titleText = score.metadata?.title || score.title || 'Untitled';
  const modeText = modeLabels[score.modeKey?.mode || score.mode] || 'Mode 1';

  let html = `<div class="score-title">${esc(titleText)}</div>`;
  html += `<div class="score-mode-label">${esc(modeText)}</div>`;

  // Reflowable score content — neumes flow like text
  html += '<div class="score-content">';

  // Insert point at start
  html += insertPointHtml(0);

  for (let i = 0; i < score.elements.length; i++) {
    const el = score.elements[i];
    const analysis = analysisResult[i] || null;

    if (el.type === 'note') {
      html += noteColHtml(el, i, analysis);
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

  // Focus lyric input if editing
  if (editingLyricIdx >= 0) {
    const input = scoreEl.querySelector(`.lyric-input[data-idx="${editingLyricIdx}"]`);
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // Update palette validity indicators
  renderPalette();
  renderPad();
}

function noteColHtml(el, idx, analysis) {
  const char = getNeumeChar(el);
  const isSelected = idx === selectedIdx;
  const hasWarning = analysis?.warnings?.length > 0;
  const pending = el === placeholderEl ? ' placeholder' : '';
  const cls = `note-col${isSelected ? ' selected' : ''}${hasWarning ? ' has-warning' : ''}${pending}`;

  const { above, below } = getSupportGlyphs(el);

  let aboveHtml = above ? `<span class="neume-support">${above}</span>` : '';
  let belowHtml = below ? `<span class="neume-support-below">${below}</span>` : '';

  let lyricHtml;
  if (editingLyricIdx === idx) {
    const width = Math.max(3, (el.lyric || '').length + 1);
    lyricHtml = `<input class="lyric-input" data-idx="${idx}" value="${esc(el.lyric)}" style="width:${width}ch" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next">`;
  } else {
    lyricHtml = `<span class="lyric">${esc(el.lyric) || '&nbsp;'}</span>`;
  }

  return `<div class="${cls}" data-idx="${idx}">
    ${aboveHtml}
    <span class="neume">${char}</span>
    ${belowHtml}
    ${lyricHtml}
  </div>`;
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

  scoreEl.querySelectorAll('.note-col').forEach(col => {
    col.addEventListener('click', (e) => {
      if (e.target.classList.contains('lyric-input')) return;
      e.stopPropagation();
      let idx = parseInt(col.dataset.idx);
      // Leaving a blank spot drops its untouched placeholder
      if (score.elements[idx] !== placeholderEl) {
        const target = score.elements[idx];
        dropPlaceholder();
        idx = score.elements.indexOf(target);
      }
      // Tapping the syllable line of a note goes straight to lyric editing
      const tappedLyric = e.target.classList.contains('lyric');
      if (tappedLyric && score.elements[idx]?.type === 'note') {
        startLyricEdit(idx);
        return;
      }
      if (selectedIdx === idx) {
        if (score.elements[idx]?.type === 'note') {
          editingLyricIdx = idx;
          render();
        }
      } else {
        selectedIdx = idx;
        cursorPos = idx + 1;
        editingLyricIdx = -1;
        render();
      }
    });
  });

  scoreEl.querySelectorAll('.insert-point').forEach(ip => {
    ip.addEventListener('click', (e) => {
      e.stopPropagation();
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
    dropPlaceholder();
    enterBlank(score.elements.length);
    refresh();
  });

  scoreEl.querySelectorAll('.lyric-input').forEach(input => {
    const idx = parseInt(input.dataset.idx);
    let edited = false;

    input.addEventListener('input', () => {
      // Snapshot once per edit, before the change, so Undo restores the old lyric
      if (!edited) { pushHistory(); edited = true; }
      if (score.elements[idx] === placeholderEl) keepPlaceholder();
      score.elements[idx].lyric = input.value;
      input.style.width = Math.max(3, input.value.length + 1) + 'ch';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        let nextIdx = idx + 1;
        while (nextIdx < score.elements.length && score.elements[nextIdx].type !== 'note') {
          nextIdx++;
        }
        if (nextIdx < score.elements.length) {
          editingLyricIdx = nextIdx;
          selectedIdx = nextIdx;
          cursorPos = nextIdx + 1;
        } else {
          editingLyricIdx = -1;
        }
        render();
      } else if (e.key === 'Escape') {
        editingLyricIdx = -1;
        render();
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (editingLyricIdx === idx) {
          editingLyricIdx = -1;
          render();
        }
      }, 150);
    });
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

function startLyricEdit(idx) {
  if (score.elements[idx] === placeholderEl) placeholderEl = null;
  selectedIdx = idx;
  cursorPos = idx + 1;
  editingLyricIdx = idx;
  render();
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
  editingLyricIdx = -1;
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
  editingLyricIdx = -1;
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
  document.getElementById('score-title').addEventListener('input', (e) => {
    score.metadata.title = e.target.value;
    render();
  });

  document.getElementById('score-mode').addEventListener('change', (e) => {
    const mode = parseInt(e.target.value);
    score.modeKey.mode = mode;
    // Look up default template for this mode
    const template = theory.modeKeys?.templates?.find(t => t.mode === mode);
    if (template) {
      score.modeKey.scale = template.scale;
      score.modeKey.scaleNote = template.scaleNote;
      score.modeKey.templateId = template.id;
    }
    reanalyze();
    render();
  });

  document.getElementById('btn-new').addEventListener('click', async () => {
    // Signed in, the open score is safe on the account, so no need to ask.
    if (storableScore().elements.length > 0 && !(await currentIsSaved())
        && !confirm('Start a new score? Current work will be lost.')) return;
    newScore();
  });

  document.getElementById('btn-export').addEventListener('click', () => window.print());

  document.getElementById('btn-lyric').addEventListener('click', () => {
    if (selectedIdx >= 0 && score.elements[selectedIdx]?.type === 'note') {
      startLyricEdit(selectedIdx);
    } else if (cursorPos > 0 && score.elements[cursorPos - 1]?.type === 'note') {
      startLyricEdit(cursorPos - 1);
    }
  });

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

// Martyria mode: toggled from the pad's bottom-left button
let martyriaMode = false;

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
  editingLyricIdx = -1;
}

function focusEmptySlot(pos) {
  selectedIdx = -1;
  cursorPos = pos;
  editingLyricIdx = -1;
}

// The symbol a blank spot starts with: Ison, or in martyria mode the
// most likely martyria
function blankSymbol(pos) {
  return martyriaMode ? martyriaFromOption(martyriaOptions(pos)[0]) : createNote('Ison');
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
  if (martyriaMode) {
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
    if (score.elements[selectedIdx] === placeholderEl) {
      pushHistory();          // committing the pending symbol is an edit
      keepPlaceholder();
    }
    if (selectedIdx < score.elements.length - 1) focusSymbol(selectedIdx + 1);
    else enterBlank(score.elements.length);
  }
  return true;
}

function setMartyriaMode(on) {
  martyriaMode = on;
  const btn = document.getElementById('pad-mode');
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
  // A pending symbol switches with the mode (Ison <-> martyria)
  const p = placeholderIndex();
  if (p >= 0) {
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

  // Bottom-left toggle on the pad; it must not start a pad gesture
  const modeBtn = document.getElementById('pad-mode');
  modeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  modeBtn.addEventListener('click', () => { setMartyriaMode(!martyriaMode); haptic(); });

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
      } else if (el.type === 'note') {
        pushHistory();
        if (el === placeholderEl) keepPlaceholder();
        const value = Math.max(MIN_VALUE, Math.min(MAX_VALUE, intervalOf(el) + dir));
        setNoteValue(el, value, familyOf(el));
      } else if (el.type === 'martyria') {
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
  pad.classList.toggle('martyria-mode', martyriaMode);
  glyphEl.classList.remove('martyria');

  if (el && el.type === 'note') {
    const v = intervalOf(el);
    const a = analysisResult[selectedIdx];
    pad.classList.remove('empty');
    glyphEl.textContent = getNeumeChar(el);
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
    if (martyriaMode) {
      const first = martyriaOptions(cursorPos)[0];
      hintEl.textContent = `Swipe or tap for a martyria (${noteNameOf(first.value)} first)`;
    } else {
      hintEl.textContent = previousNote(cursorPos)
        ? 'Swipe ↕ for a new note · Tap to repeat'
        : 'Swipe up or down to start with Ison';
    }
  }
}

// ============================================================================
// KEYBOARD
// ============================================================================

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

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
      if (selectedIdx >= 0 && score.elements[selectedIdx]?.type === 'note') {
        editingLyricIdx = selectedIdx;
        render();
      }
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
  score = next;
  score.metadata = score.metadata || {};
  if (!score.metadata.id) score.metadata.id = newDocId();
  placeholderEl = null;
  history = [];
  analysisResult = [];
  document.getElementById('score-title').value = score.metadata.title || '';
  document.getElementById('score-mode').value = score.modeKey?.mode || 1;
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
      document.getElementById('score-title').value = score.metadata?.title || '';
      document.getElementById('score-mode').value = score.modeKey?.mode || 1;
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
  // Open on a blank spot at the end of the score
  enterBlank(score.elements.length);
  reanalyze();
  render();
  initAccount({ getScore: storableScore, openScore, newScore, toast, saveLocal: saveToLocal });
}

init();
