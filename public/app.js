// Gorgon — Byzantine Notation Writer (v2)
// GPL-3.0

import { createScore, createNote, createMartyria, createModeKey,
         createBarline, createSectionBreak, createSpacer,
         SBMUFL_TO_NEUME, NEUME_TO_SBMUFL } from './models.js';
import { analyzeScore } from './analysis.js';
import { attachPad } from './gestures.js';

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
  martyria: ['martyriaOfTheNotes', 'martyriaOfTheTones'],
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

// Each snapshot keeps the focus too, so Undo puts you back where you were
function pushHistory() {
  history.push(JSON.stringify({ score, selectedIdx, cursorPos }));
  if (history.length > MAX_HISTORY) history.shift();
}

function undo() {
  if (history.length === 0) return;
  const snap = JSON.parse(history.pop());
  score = snap.score;
  cursorPos = Math.min(snap.cursorPos, score.elements.length);
  selectedIdx = snap.selectedIdx < score.elements.length ? snap.selectedIdx : -1;
  editingLyricIdx = -1;
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

// Martyria glyph pairs for rendering
const MARTYRIA_PAIRS = {
  1: { note: 'martyriaNotePa',    tone: 'modeFirst' },
  2: { note: 'martyriaNoteVou',   tone: 'modeSecond' },
  3: { note: 'martyriaNoteGa',    tone: 'modeThird' },
  4: { note: 'martyriaNoteDi',    tone: 'modeFourth' },
  5: { note: 'martyriaNoteKe',    tone: 'modePlagalFirst' },
  6: { note: 'martyriaNoteZo',    tone: 'modePlagalSecond' },
  7: { note: 'martyriaNoteNiLow', tone: 'modeVarys' },
  8: { note: 'martyriaNoteNi',    tone: 'modePlagalFourth' },
};

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

    const glyphName = btn.dataset.glyph;
    const cp = btn.dataset.cp;

    // If a neume is selected and this is a support category, add as modifier
    if (selectedIdx >= 0 && score.elements[selectedIdx]?.type === 'note') {
      const el = score.elements[selectedIdx];
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
    pushHistory();
    if (currentCategory === 'martyria') {
      // Insert a martyria element
      score.elements.splice(cursorPos, 0, createMartyria());
    } else {
      // Map SBMuFL glyph name to Neanes quantitative neume name
      const neume = SBMUFL_TO_NEUME[glyphName] || glyphName;
      const el = createNote(neume);
      // Store the SBMuFL glyph name + codepoint for rendering
      el._glyph = glyphName;
      el._codepoint = cp;
      score.elements.splice(cursorPos, 0, el);
    }
    cursorPos++;
    selectedIdx = cursorPos - 1;
    reanalyze();
    render();
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
  const cls = `note-col${isSelected ? ' selected' : ''}${hasWarning ? ' has-warning' : ''}`;

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
  const cls = `note-col martyria-col${isSelected ? ' selected' : ''}`;
  const mode = score.modeKey?.mode || 1;

  // Use auto-computed martyria from analysis if available
  const pair = MARTYRIA_PAIRS[mode];
  if (pair && glyphnames[pair.note] && glyphnames[pair.tone]) {
    const noteChar = codepointToChar(glyphnames[pair.note].codepoint);
    const toneChar = codepointToChar(glyphnames[pair.tone].codepoint);
    return `<div class="${cls}" data-idx="${idx}">
      <span class="martyria-note">${noteChar}</span>
      <span class="martyria-tone">${toneChar}</span>
      <span class="lyric">&nbsp;</span>
    </div>`;
  }

  return `<div class="${cls}" data-idx="${idx}">
    <span class="neume" style="font-size:1.2rem; color:#c00;">[M]</span>
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
      const idx = parseInt(col.dataset.idx);
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
      cursorPos = parseInt(ip.dataset.insert);
      selectedIdx = -1;
      editingLyricIdx = -1;
      render();
    });
  });

  // Tapping empty space in the score (e.g. after the last line) puts the
  // cursor at the end, so you never have to hit the thin insert point.
  const content = scoreEl.querySelector('.score-content');
  content.addEventListener('click', (e) => {
    if (e.target !== content) return;
    cursorPos = score.elements.length;
    selectedIdx = -1;
    editingLyricIdx = -1;
    render();
  });

  scoreEl.querySelectorAll('.lyric-input').forEach(input => {
    const idx = parseInt(input.dataset.idx);
    let edited = false;

    input.addEventListener('input', () => {
      // Snapshot once per edit, before the change, so Undo restores the old lyric
      if (!edited) { pushHistory(); edited = true; }
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

function startLyricEdit(idx) {
  selectedIdx = idx;
  cursorPos = idx + 1;
  editingLyricIdx = idx;
  render();
}

// Cursor movement shared by the arrow keys and the Prev/Next buttons
function moveLeft() {
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

  document.getElementById('btn-new').addEventListener('click', () => {
    if (score.elements.length > 0 && !confirm('Start a new score? Current work will be lost.')) return;
    score = createScore();
    cursorPos = 0;
    selectedIdx = -1;
    editingLyricIdx = -1;
    history = [];
    analysisResult = [];
    document.getElementById('score-title').value = '';
    document.getElementById('score-mode').value = '1';
    render();
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
    pushHistory();
    score.elements.splice(cursorPos, 0, createSpacer());
    cursorPos++;
    reanalyze();
    render();
  });

  document.getElementById('btn-newline').addEventListener('click', () => {
    pushHistory();
    score.elements.splice(cursorPos, 0, createSectionBreak());
    cursorPos++;
    reanalyze();
    render();
  });

  document.getElementById('btn-delete').addEventListener('click', () => {
    if (selectedIdx >= 0) {
      pushHistory();
      score.elements.splice(selectedIdx, 1);
      cursorPos = Math.min(selectedIdx, score.elements.length);
      selectedIdx = -1;
      reanalyze();
      render();
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
    pushHistory();
    score.elements.splice(cursorPos, 0, createBarline());
    cursorPos++;
    reanalyze();
    render();
  });

  document.getElementById('btn-martyria').addEventListener('click', () => {
    pushHistory();
    score.elements.splice(cursorPos, 0, createMartyria());
    cursorPos++;
    reanalyze();
    render();
  });
}

// ============================================================================
// COMPOSE PAD (one-handed swipe editing)
// ============================================================================
//
// Focus is either a symbol (selectedIdx >= 0) or an empty slot at cursorPos
// (selectedIdx < 0). Notes are only ever inserted on an empty slot.
//   Empty slot: swipe up/down inserts Ison, each further step climbs or
//               descends the ladder; tap inserts a repeat of the previous note.
//   Symbol:     swipe up/down steps its value one rung per detent.
//   Swipe right commits the symbol and moves focus on (to the next symbol,
//   or to an empty slot after the last one). Swipe left moves focus back.

const MIN_VALUE = -12;
const MAX_VALUE = 14;

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

function haptic() {
  try { navigator.vibrate?.(8); } catch (e) { /* unsupported */ }
}

function refresh() {
  reanalyze();
  render();
  scrollSelectionIntoView();
}

// State held for the duration of one vertical drag
let drag = null;

function initComposePad() {
  const pad = document.getElementById('pad');
  attachPad(pad, {
    onTap() {
      if (selectedIdx >= 0) return;            // already on a symbol
      const prev = previousNote(cursorPos);
      pushHistory();
      const el = createNote(prev ? prev.quantitativeNeume : 'Ison');
      score.elements.splice(cursorPos, 0, el);
      focusSymbol(cursorPos);
      haptic();
      refresh();
    },

    onDragStart() {
      const el = selectedIdx >= 0 ? score.elements[selectedIdx] : null;
      if (el && el.type !== 'note') { drag = null; return; }
      pushHistory();
      drag = el
        ? { mode: 'symbol', idx: selectedIdx, base: intervalOf(el), family: familyOf(el) }
        : { mode: 'empty', pos: cursorPos, idx: -1 };
    },

    onStep(steps) {
      if (!drag) return;
      if (drag.mode === 'symbol') {
        const value = Math.max(MIN_VALUE, Math.min(MAX_VALUE, drag.base + steps));
        setNoteValue(score.elements[drag.idx], value, drag.family);
      } else {
        // Empty slot: the first step gives Ison, then one rung per step
        if (steps === 0) {
          if (drag.idx >= 0) {
            score.elements.splice(drag.idx, 1);
            drag.idx = -1;
            focusEmptySlot(drag.pos);
          }
        } else {
          const value = Math.max(MIN_VALUE, Math.min(MAX_VALUE, Math.sign(steps) * (Math.abs(steps) - 1)));
          if (drag.idx < 0) {
            score.elements.splice(drag.pos, 0, createNote('Ison'));
            drag.idx = drag.pos;
            focusSymbol(drag.idx);
          }
          setNoteValue(score.elements[drag.idx], value, null);
        }
      }
      haptic();
      refresh();
    },

    onDragEnd(steps) {
      // A drag that came back to where it started changed nothing
      if (drag && steps === 0) history.pop();
      drag = null;
    },

    onSwipe(dir) {
      if (dir === 'right') {
        if (selectedIdx < 0) {
          // Empty slot: nothing to commit, but step onto the next symbol if any
          if (cursorPos < score.elements.length) focusSymbol(cursorPos);
          else return;
        } else if (selectedIdx < score.elements.length - 1) focusSymbol(selectedIdx + 1);
        else focusEmptySlot(score.elements.length);
      } else {
        if (selectedIdx > 0) focusSymbol(selectedIdx - 1);
        else if (selectedIdx < 0 && cursorPos > 0) focusSymbol(cursorPos - 1);
        else return;
      }
      haptic();
      render();
      scrollSelectionIntoView();
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

  if (el && el.type === 'note') {
    const v = intervalOf(el);
    const a = analysisResult[selectedIdx];
    pad.classList.remove('empty');
    glyphEl.textContent = getNeumeChar(el);
    valueEl.textContent = v > 0 ? `+${v}` : v < 0 ? `\u2212${-v}` : '0';
    noteEl.textContent = a?.noteName || '';
    noteEl.classList.toggle('warn', a?.warnings?.length > 0);
    hintEl.textContent = 'Swipe \u2195 to change \u00b7 \u2192 to commit';
  } else if (el) {
    pad.classList.remove('empty');
    glyphEl.textContent = '';
    valueEl.textContent = el.type;
    noteEl.textContent = '';
    hintEl.textContent = '\u2192 next \u00b7 \u2190 back';
  } else {
    pad.classList.add('empty');
    glyphEl.textContent = '';
    valueEl.textContent = '';
    noteEl.textContent = '';
    const prev = previousNote(cursorPos);
    hintEl.textContent = prev
      ? 'Swipe \u2195 for a new note \u00b7 Tap to repeat'
      : 'Swipe up or down to start with Ison';
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

function saveToLocal() {
  try {
    localStorage.setItem('gorgon-score-v2', JSON.stringify(score));
  } catch (e) { /* storage full */ }
}

function loadFromLocal() {
  try {
    const saved = localStorage.getItem('gorgon-score-v2');
    if (saved) {
      score = JSON.parse(saved);
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
  // Open on the empty slot at the end of the score
  focusEmptySlot(score.elements.length);
  reanalyze();
  render();
}

init();
