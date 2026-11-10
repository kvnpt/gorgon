// Gorgon — Byzantine Notation Writer (v2)
// GPL-3.0

import { createScore, createNote, createMartyria, createModeKey,
         createBarline, createSectionBreak, createSpacer,
         SBMUFL_TO_NEUME, NEUME_TO_SBMUFL } from './models.js';
import { analyzeScore } from './analysis.js';

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
const MAX_HISTORY = 50;

function pushHistory() {
  history.push(JSON.stringify(score));
  if (history.length > MAX_HISTORY) history.shift();
}

function undo() {
  if (history.length === 0) return;
  const restored = JSON.parse(history.pop());
  score = restored;
  cursorPos = Math.min(cursorPos, score.elements.length);
  selectedIdx = -1;
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
    const label = g.name.replace(/([A-Z])/g, ' $1').trim();

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

function initPaletteTabs() {
  const tabs = document.querySelectorAll('.palette-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
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
    lyricHtml = `<input class="lyric-input" data-idx="${idx}" value="${esc(el.lyric)}" autocomplete="off" autocapitalize="off">`;
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
      const idx = parseInt(col.dataset.idx);
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
    ip.addEventListener('click', () => {
      cursorPos = parseInt(ip.dataset.insert);
      selectedIdx = -1;
      editingLyricIdx = -1;
      render();
    });
  });

  scoreEl.querySelectorAll('.lyric-input').forEach(input => {
    const idx = parseInt(input.dataset.idx);

    input.addEventListener('input', () => {
      score.elements[idx].lyric = input.value;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pushHistory();
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
      editingLyricIdx = selectedIdx;
      render();
    }
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
// KEYBOARD
// ============================================================================

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (selectedIdx > 0) {
        selectedIdx--;
        cursorPos = selectedIdx + 1;
      } else if (selectedIdx < 0 && cursorPos > 0) {
        cursorPos--;
        selectedIdx = cursorPos;
      }
      render();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (selectedIdx >= 0 && selectedIdx < score.elements.length - 1) {
        selectedIdx++;
        cursorPos = selectedIdx + 1;
      } else if (selectedIdx < 0 && cursorPos < score.elements.length) {
        selectedIdx = cursorPos;
        cursorPos++;
      }
      render();
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
  reanalyze();
  render();
}

init();
