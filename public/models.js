/**
 * models.js — Gorgon v2 Document Model
 *
 * Factory functions for creating score documents and elements.
 * ES module imported by app.js.
 *
 * The document model uses Neanes enum names internally (the theory engine format).
 * The SBMuFL glyph names (camelCase, used by the font/palette) are bridged via
 * SBMUFL_TO_NEUME and NEUME_TO_SBMUFL mapping tables at the bottom of this file.
 */

// ---------------------------------------------------------------------------
// Score document
// ---------------------------------------------------------------------------

/**
 * Create a new empty score document.
 * @param {Object} options
 * @param {string} [options.title]
 * @param {string} [options.composer]
 * @param {string} [options.tone]
 * @param {string} [options.genre='sticheric'] - sticheric|heirmologic|papadic|sticheraric
 * @param {number} [options.timeSignature=2]
 * @param {number} [options.mode=1] - Mode 1-8
 * @param {string} [options.scale='Diatonic'] - Scale enum name
 * @param {string} [options.scaleNote='Pa'] - Starting scale note
 * @param {number|null} [options.templateId=null] - Mode key template ID
 * @returns {Object} Score document
 */
// A score's own id: how the account tells one score from another
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

export function createScore(options = {}) {
  return {
    version: '2.0',
    metadata: {
      id: newId(),
      title: options.title || '',
      composer: options.composer || '',
      tone: options.tone || '',
      genre: options.genre || 'sticheric',
      timeSignature: options.timeSignature || 2,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    },
    modeKey: {
      mode: options.mode || 1,
      scale: options.scale || 'Diatonic',
      scaleNote: options.scaleNote || 'Pa',
      templateId: options.templateId || null,
    },
    elements: [],
  };
}

// ---------------------------------------------------------------------------
// Element factories
// ---------------------------------------------------------------------------

/**
 * Create a note element.
 * @param {string} quantitativeNeume - Neanes enum name, e.g. 'Oligon', 'Apostrophos', 'Petasti'
 * @param {string} [lyric='']
 * @returns {Object} Note element
 */
export function createNote(quantitativeNeume, lyric = '') {
  return {
    type: 'note',
    quantitativeNeume,
    timeNeume: null,       // e.g. 'Klasma_Top', 'Hapli', 'Dipli', 'Tripli', 'Tetrapli'
    gorgonNeume: null,     // e.g. 'Gorgon_Top', 'Digorgon', 'Trigorgon'
    vocalExpression: null,  // e.g. 'Vareia', 'Psifiston', 'Antikenoma', 'Homalon'
    fthora: null,          // e.g. 'DiatonicPa_Top', 'Zygos', 'SoftChromaticThi_Top'
    accidental: null,      // e.g. 'Sharp_2_Left', 'Flat_2_Right'
    ison: null,            // e.g. 'Ison.Pa', 'Ison.Vou'
    measureBar: null,      // e.g. 'MeasureBarRight', 'MeasureBarTop'
    lyric,
    melisma: false,
  };
}

/**
 * Create an auto-computed martyria.
 * When auto is true, the renderer computes the correct martyria from the
 * current pitch context. Set auto to false and provide explicit fields
 * to override.
 * @returns {Object} Martyria element
 */
export function createMartyria() {
  return { type: 'martyria', auto: true };
}

/**
 * Create a mode key element that sets the scale context.
 * @param {number} templateId - ID from mode-keys.json templates
 * @returns {Object} Mode key element
 */
export function createModeKey(templateId) {
  return { type: 'modeKey', templateId };
}

/**
 * Create a barline element.
 * @returns {Object} Barline element
 */
export function createBarline() {
  return { type: 'barline' };
}

/**
 * Create a section break (forces a new line for structural reasons).
 * @returns {Object} Section break element
 */
export function createSectionBreak() {
  return { type: 'sectionBreak' };
}

/**
 * Create a spacer element.
 * @returns {Object} Spacer element
 */
export function createSpacer() {
  return { type: 'spacer' };
}

// ---------------------------------------------------------------------------
// SBMuFL <-> Neanes name mapping
// ---------------------------------------------------------------------------
//
// The SBMuFL spec uses camelCase glyph names (e.g. 'oligonYpsiliRight').
// The Neanes theory engine uses PascalCase enum names (e.g. 'OligonPlusHypsiliRight').
// This mapping bridges between the two so the palette (SBMuFL) and the
// analysis engine (Neanes) can interoperate.
//
// Sources:
//   - data/sbmufl/glyphnames.json (SBMuFL names)
//   - data/theory/neume-values.json (Neanes QuantitativeNeume enum names)
// ---------------------------------------------------------------------------

/**
 * Map from SBMuFL glyph names (camelCase) to Neanes QuantitativeNeume enum names.
 */
export const SBMUFL_TO_NEUME = {
  // --- Ascending neumes: Oligon family ---
  'ison': 'Ison',
  'oligon': 'Oligon',
  'oligonKentimaMiddle': 'OligonPlusKentima',
  'oligonKentimaBelow': 'OligonPlusKentimaBelow',
  'oligonKentimaAbove': 'OligonPlusKentimaAbove',
  'oligonYpsiliRight': 'OligonPlusHypsiliRight',
  'oligonYpsiliLeft': 'OligonPlusHypsiliLeft',
  'oligonKentimaYpsiliRight': 'OligonPlusHypsiliPlusKentimaHorizontal',
  'oligonKentimaYpsiliMiddle': 'OligonPlusHypsiliPlusKentimaVertical',
  'oligonDoubleYpsili': 'OligonPlusDoubleHypsili',
  'oligonKentimataDoubleYpsili': 'OligonKentimataDoubleYpsili',
  'oligonKentimaDoubleYpsiliRight': 'OligonKentimaDoubleYpsiliRight',
  'oligonKentimaDoubleYpsiliLeft': 'OligonKentimaDoubleYpsiliLeft',
  'oligonTripleYpsili': 'OligonTripleYpsili',
  'oligonKentimataTripleYpsili': 'OligonKentimataTripleYpsili',
  'oligonKentimaTripleYpsili': 'OligonKentimaTripleYpsili',

  // --- Oligon + descending compound ---
  'oligonIson': 'OligonPlusIson',
  'oligonApostrofos': 'OligonPlusApostrophos',
  'oligonYporroi': 'OligonPlusHyporoe',
  'oligonElafron': 'OligonPlusElaphron',
  'oligonElafronApostrofos': 'OligonPlusElaphronPlusApostrophos',
  'oligonChamili': 'OligonPlusHamili',

  // --- Ascending neumes: Petasti family ---
  'petastiIson': 'PetastiWithIson',
  'petasti': 'Petasti',
  'petastiOligon': 'PetastiPlusOligon',
  'petastiKentima': 'PetastiPlusKentimaAbove',
  'petastiYpsiliRight': 'PetastiPlusHypsiliRight',
  'petastiYpsiliLeft': 'PetastiPlusHypsiliLeft',
  'petastiKentimaYpsiliRight': 'PetastiPlusHypsiliPlusKentimaHorizontal',
  'petastiKentimaYpsiliMiddle': 'PetastiPlusHypsiliPlusKentimaVertical',
  'petastiDoubleYpsili': 'PetastiPlusDoubleHypsili',
  'petastiKentimataDoubleYpsili': 'PetastiKentimataDoubleYpsili',
  'petastiKentimaDoubleYpsiliRight': 'PetastiKentimaDoubleYpsiliRight',
  'petastiKentimaDoubleYpsiliLeft': 'PetastiKentimaDoubleYpsiliLeft',
  'petastiTripleYpsili': 'PetastiTripleYpsili',
  'petastiKentimataTripleYpsili': 'PetastiKentimataTripleYpsili',
  'petastiKentimaTripleYpsili': 'PetastiKentimaTripleYpsili',

  // --- Petasti + descending compound ---
  'petastiApostrofos': 'PetastiPlusApostrophos',
  'petastiYporroi': 'PetastiPlusHyporoe',
  'petastiElafron': 'PetastiPlusElaphron',
  'petastiRunningElafron': 'PetastiPlusRunningElaphron',
  'petastiElafronApostrofos': 'PetastiPlusElaphronPlusApostrophos',
  'petastiChamili': 'PetastiHamili',
  'petastiChamiliApostrofos': 'PetastiHamiliApostrofos',
  'petastiChamiliElafron': 'PetastiHamiliElafron',
  'petastiChamiliElafronApostrofos': 'PetastiHamiliElafronApostrofos',
  'petastiDoubleChamili': 'PetastiDoubleHamili',
  'petastiDoubleChamiliApostrofos': 'PetastiDoubleHamiliApostrofos',

  // --- Descending neumes ---
  'apostrofos': 'Apostrophos',
  'apostrofosSyndesmos': 'DoubleApostrophos',
  'isonApostrofos': 'IsonPlusApostrophos',
  'yporroi': 'Hyporoe',
  'elafron': 'Elaphron',
  'runningElafron': 'RunningElaphron',
  'elafronApostrofos': 'ElaphronPlusApostrophos',
  'chamili': 'Hamili',
  'chamiliApostrofos': 'HamiliPlusApostrophos',
  'chamiliElafron': 'HamiliPlusElaphron',
  'chamiliElafronApostrofos': 'HamiliPlusElaphronPlusApostrophos',
  'doubleChamili': 'DoubleHamili',
  'doubleChamiliApostrofos': 'DoubleHamiliApostrofos',
  'doubleChamiliElafron': 'DoubleHamiliElafron',
  'doubleChamiliElafronApostrofos': 'DoubleHamiliElafronApostrofos',
  'tripleChamili': 'TripleHamili',

  // --- Kentima / Kentemata family ---
  'kentima': 'Kentima',
  'kentimata': 'Kentemata',
  'oligonKentimataBelow': 'OligonPlusKentemata',
  'oligonKentimataAbove': 'KentemataPlusOligon',
  'oligonIsonKentimata': 'OligonPlusIsonPlusKentemata',
  'oligonKentimaMiddleKentimata': 'OligonKentimaMiddleKentimata',
  'oligonYpsiliRightKentimata': 'OligonPlusKentemataPlusHypsiliRight',
  'oligonYpsiliLeftKentimata': 'OligonPlusKentemataPlusHypsiliLeft',
  'oligonApostrofosKentimata': 'OligonPlusApostrophosPlusKentemata',
  'oligonYporroiKentimata': 'OligonPlusHyporoePlusKentemata',
  'oligonElafronKentimata': 'OligonPlusElaphronPlusKentemata',
  'oligonRunningElafronKentimata': 'OligonPlusRunningElaphronPlusKentemata',
  'oligonElafronApostrofosKentimata': 'OligonPlusElaphronPlusApostrophosPlusKentemata',
  'oligonChamiliKentimata': 'OligonPlusHamiliPlusKentemata',

  // --- Rests and special ---
  'stavros': 'Cross',
  'breath': 'Breath',
};

/**
 * Reverse map: Neanes QuantitativeNeume enum name -> SBMuFL glyph name.
 */
export const NEUME_TO_SBMUFL = Object.fromEntries(
  Object.entries(SBMUFL_TO_NEUME).map(([k, v]) => [v, k])
);
