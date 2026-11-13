/**
 * analysis.js — Byzantine Chant Score Analysis Engine
 *
 * Walks a score's element array and computes musical state at each position:
 * absolute note value, note name, scale position, beat tracking, fthora
 * validation, and auto-martyria computation.
 *
 * This is the computational core of the Gorgon notation editor.
 */

// ---------------------------------------------------------------------------
// Note value <-> name conversion helpers
// ---------------------------------------------------------------------------

/**
 * Build a reverse lookup from integer note value to note name.
 * Uses the noteOrder array to prefer canonical names (middle octave first).
 * E.g. value 0 -> 'Pa', value 5 -> 'ZoHigh', value -2 -> 'Zo'.
 */
function buildNoteValueToName(noteValues, noteOrder) {
  const map = new Map();
  // Walk noteOrder so that the first (lowest) canonical name wins for each value.
  // We want the "middle" octave names (Pa, Vou, Ga...) to take priority,
  // so we iterate in reverse and let middle-octave entries overwrite.
  for (let i = noteOrder.length - 1; i >= 0; i--) {
    map.set(noteValues[noteOrder[i]], noteOrder[i]);
  }
  return map;
}

/**
 * Convert an absolute note value to a human-readable name.
 * Values outside the pre-defined range get a computed name with octave suffix.
 */
function noteValueToName(value, valueToNameMap) {
  if (valueToNameMap.has(value)) {
    return valueToNameMap.get(value);
  }
  // Fallback: compute from modulo position within the 7-note cycle
  const BASE_NAMES = ['Pa', 'Vou', 'Ga', 'Thi', 'Ke', 'Zo', 'Ni'];
  const mod = ((value % 7) + 7) % 7;
  const octave = Math.floor(value / 7);
  const baseName = BASE_NAMES[mod];
  if (octave > 0) return baseName + 'High'.repeat(octave);
  if (octave < 0) return baseName + 'Low'.repeat(-octave);
  return baseName;
}

// ---------------------------------------------------------------------------
// Fthora helpers
// ---------------------------------------------------------------------------

/**
 * Extract the fthora "family" prefix from a fthora enum string.
 * E.g. "DiatonicPa_Top" -> "Diatonic", "Enharmonic_Bottom" -> "Enharmonic",
 *      "HardChromaticThi_TopSecondary" -> "HardChromatic",
 *      "GeneralSharp_Top" -> "GeneralSharp"
 */
function fthoraFamily(fthoraName) {
  if (!fthoraName) return null;
  // Strip position suffix (_Top, _Bottom, _TopSecondary, etc.)
  const base = fthoraName.replace(/_(Top|Bottom|TopSecondary|TopTertiary)$/, '');
  // Known prefixes in priority order (longer first to avoid partial matches)
  const prefixes = [
    'HardChromatic', 'SoftChromatic',
    'GeneralSharp', 'GeneralFlat',
    'Enharmonic', 'Diatonic',
    'Zygos', 'Kliton', 'Spathi',
  ];
  for (const prefix of prefixes) {
    if (base.startsWith(prefix)) return prefix;
  }
  return base;
}

/**
 * Validate whether a fthora can be placed on the current note value.
 * Returns true if valid, false if not.
 */
function isFthoraValid(fthoraName, currentNoteValue, fthoraRules) {
  const family = fthoraFamily(fthoraName);
  if (!family) return false;

  const rule = fthoraRules.fthoraValidation[family];
  if (!rule) return false;

  // "any" means valid on every note
  if (rule.validNotes === 'any') return true;

  // Check against the explicit valid note values
  if (rule.validNoteValues) {
    return rule.validNoteValues.includes(currentNoteValue);
  }

  return false;
}

/**
 * Determine which scale a fthora activates, given the current note.
 */
function resolveActivatedScale(fthoraName, currentNoteName, fthoraRules) {
  const family = fthoraFamily(fthoraName);
  if (!family) return null;

  const activation = fthoraRules.fthoraScaleActivation[family];
  if (!activation) return null;

  // Simple string -> direct scale name
  if (typeof activation === 'string') return activation;

  // Object -> depends on which note the fthora sits on
  const noteKey = 'on' + currentNoteName;
  if (activation[noteKey]) return activation[noteKey];
  return activation.default || null;
}

// ---------------------------------------------------------------------------
// Martyria computation
// ---------------------------------------------------------------------------

/**
 * Compute the martyria root sign for a given note value and scale.
 * Returns { rootSign, noteValue } or null if no mapping exists.
 */
export function computeMartyria(noteValue, currentScale, martyriaRules) {
  const scaleRules = martyriaRules.rootSignsByScale[currentScale];
  if (!scaleRules) return null;

  // Method-based scales (HardChromatic, SoftChromatic) use even/odd logic
  if (scaleRules.method) {
    if (currentScale === 'HardChromatic') {
      const rootSign = (noteValue % 2 === 0) ? 'Squiggle' : 'Tilt';
      return { rootSign, noteValue };
    }
    if (currentScale === 'SoftChromatic') {
      const rootSign = (noteValue % 2 === 0)
        ? 'SoftChromaticPaRootSign'
        : 'SoftChromaticSquiggle';
      return { rootSign, noteValue };
    }
  }

  // Explicit map lookup
  const key = String(noteValue);
  if (scaleRules[key]) {
    return { rootSign: scaleRules[key], noteValue };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Time / beat helpers
// ---------------------------------------------------------------------------

/**
 * Compute the beat duration contributed by a note element.
 * Base duration is 1 beat. TimeNeume modifiers adjust this.
 */
// Time signs are stored by SBMuFL glyph name; timeDurations uses Neanes names
const SBMUFL_TIME = {
  klasmaAbove: 'Klasma_Top', klasmaBelow: 'Klasma_Bottom', apli: 'Hapli',
  dipli: 'Dipli', tripli: 'Tripli', tetrapli: 'Tetrapli',
};

function computeBeatDuration(element, timeDurations) {
  let duration = 1;
  const time = SBMUFL_TIME[element.timeNeume] || element.timeNeume;

  if (time && timeDurations[time] !== undefined) {
    // Klasma/Hapli add 1 beat (duration stays the same as they extend),
    // Dipli adds 2, Tripli adds 3, Tetrapli adds 4.
    // The timeDurations values represent additional beats.
    duration += timeDurations[time];
  }

  return duration;
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

/**
 * Analyze a Byzantine chant score, computing musical state at each position.
 *
 * @param {Array} elements - Score elements (note, martyria, modeKey, barline, etc.)
 * @param {Object} modeKey - Starting mode: { mode, scale, scaleNote, templateId }
 * @param {Object} theory  - Loaded theory data:
 *   { neumeValues, scales, fthoraRules, martyriaRules }
 * @returns {Array} Analysis results, one object per element.
 */
export function analyzeScore(elements, modeKey, theory) {
  const { neumeValues, scales, fthoraRules, martyriaRules } = theory;

  // Build the noteValue -> noteName reverse lookup
  const valueToNameMap = buildNoteValueToName(scales.noteValues, scales.noteOrder);

  // Time duration lookup from neume-values.json
  const timeDurations = neumeValues.timeDurations || {};

  // --- Initialize state from the starting modeKey ---
  let currentNoteValue = scales.noteValues[modeKey.scaleNote] ?? 0;
  let currentScale = modeKey.scale || 'Diatonic';
  let measure = 1;
  let beat = 1;
  let beatsInMeasure = 2; // Default Byzantine duple time
  let activeFthora = null;

  const results = [];

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const entry = {
      element,
      noteValue: null,
      noteName: null,
      scalePosition: null,
      currentScale,
      intervalFromPrev: null,
      beat: { measure, beat, beatsInMeasure },
      activeFthora: activeFthora ? { ...activeFthora } : null,
      autoMartyria: null,
      warnings: [],
    };

    switch (element.type) {
      // ----- NOTE -----
      case 'note': {
        const neume = element.quantitativeNeume;
        const interval = neumeValues.neumeValues[neume];

        if (interval === undefined) {
          entry.warnings.push(`Unknown quantitative neume: "${neume}"`);
          // Treat as ison (0 interval) so analysis can continue
          entry.intervalFromPrev = 0;
          entry.noteValue = currentNoteValue;
        } else {
          entry.intervalFromPrev = interval;
          entry.noteValue = currentNoteValue + interval;
        }

        const newNoteValue = entry.noteValue;
        entry.noteName = noteValueToName(newNoteValue, valueToNameMap);
        entry.scalePosition = ((newNoteValue % 7) + 7) % 7;
        entry.currentScale = currentScale;

        // --- Fthora handling ---
        if (element.fthora) {
          const valid = isFthoraValid(element.fthora, newNoteValue, fthoraRules);
          if (valid) {
            const noteName = noteValueToName(newNoteValue, valueToNameMap);
            const newScale = resolveActivatedScale(element.fthora, noteName, fthoraRules);
            if (newScale) {
              currentScale = newScale;
              activeFthora = { type: element.fthora, startIdx: i };
              entry.activeFthora = { ...activeFthora };
              entry.currentScale = currentScale;
            }
          } else {
            entry.warnings.push(
              `Fthora "${element.fthora}" is not valid on note value ${newNoteValue} ` +
              `(${noteValueToName(newNoteValue, valueToNameMap)})`
            );
          }
        }

        // --- Beat tracking ---
        const duration = computeBeatDuration(element, timeDurations);
        entry.beat = { measure, beat, beatsInMeasure };
        beat += duration;

        // Update running note position
        currentNoteValue = newNoteValue;
        break;
      }

      // ----- MARTYRIA -----
      case 'martyria': {
        // An explicit martyria (one the user chose, e.g. at the start of a
        // piece) testifies a pitch and sets it; an auto one reads it.
        if (element.auto === false && typeof element.noteValue === 'number') {
          currentNoteValue = element.noteValue;
        }
        entry.noteValue = currentNoteValue;
        entry.noteName = noteValueToName(currentNoteValue, valueToNameMap);
        entry.scalePosition = ((currentNoteValue % 7) + 7) % 7;
        entry.currentScale = currentScale;

        {
          const martyria = computeMartyria(currentNoteValue, currentScale, martyriaRules);
          if (martyria) {
            entry.autoMartyria = {
              rootSign: martyria.rootSign,
              noteValue: martyria.noteValue,
              noteName: noteValueToName(currentNoteValue, valueToNameMap),
              scale: currentScale,
            };
          } else {
            entry.warnings.push(
              `No martyria rule found for note value ${currentNoteValue} ` +
              `in scale "${currentScale}"`
            );
          }
        }
        break;
      }

      // ----- MODE KEY -----
      case 'modeKey': {
        // Reset scale context from the template.
        // The templateId encodes mode info; for now we reset to what the
        // modeKey element specifies. If the caller has pre-resolved the
        // template into scale/scaleNote fields, use those.
        if (element.scale) {
          currentScale = element.scale;
        }
        if (element.scaleNote && scales.noteValues[element.scaleNote] !== undefined) {
          currentNoteValue = scales.noteValues[element.scaleNote];
        }
        entry.currentScale = currentScale;
        entry.noteValue = currentNoteValue;
        entry.noteName = noteValueToName(currentNoteValue, valueToNameMap);
        entry.scalePosition = ((currentNoteValue % 7) + 7) % 7;

        // Clear active fthora on mode reset
        activeFthora = null;
        entry.activeFthora = null;
        break;
      }

      // ----- BARLINE -----
      case 'barline': {
        entry.currentScale = currentScale;
        entry.noteValue = currentNoteValue;
        entry.noteName = noteValueToName(currentNoteValue, valueToNameMap);

        // Advance measure, reset beat
        measure += 1;
        beat = 1;
        entry.beat = { measure, beat, beatsInMeasure };
        break;
      }

      // ----- SECTION BREAK -----
      case 'sectionBreak': {
        entry.currentScale = currentScale;
        entry.noteValue = currentNoteValue;

        // Section breaks also advance the measure
        measure += 1;
        beat = 1;
        entry.beat = { measure, beat, beatsInMeasure };
        break;
      }

      // ----- REST (leimma): an empty beat of its own -----
      case 'rest': {
        entry.currentScale = currentScale;
        entry.noteValue = currentNoteValue;
        entry.noteName = noteValueToName(currentNoteValue, valueToNameMap);
        beat += (['leimma1', 'leimma2', 'leimma3', 'leimma4'].indexOf(element.glyph) + 1) || 1;
        break;
      }

      // ----- SPACER / OTHER -----
      default: {
        // Spacers and unknown types: carry forward current state
        entry.currentScale = currentScale;
        entry.noteValue = currentNoteValue;
        entry.noteName = noteValueToName(currentNoteValue, valueToNameMap);
        break;
      }
    }

    results.push(entry);
  }

  return results;
}
