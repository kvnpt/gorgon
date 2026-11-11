// Gorgon — lyric mode: syllabify typed text and lay it under the notes
// GPL-3.0
//
// The text typed in lyric mode is the source; each note gets one slot of it.
//   space   ends a word: the next letters start on the next note
//   -       breaks a word by hand. A word with any '-' is split only there
//   _       holds the syllable before it over one more note (melisma)
//   ~       joins two words on one note ("and~the")
// Words without a '-' are split automatically: Greek by its grammar rules,
// English with Hypher and the TeX en-US patterns plus a vowel-group fallback
// (patterns are made for typesetting and leave short words whole).
//
// A note's lyric stays a plain string: the syllable, with a trailing '-'
// when the word goes on, or '-' / '_' alone on a held note (inside a word /
// after the end of one).

import Hypher from './vendor/hypher.js';
import enUs from './vendor/hyphen-en-us.js';

// Every syllable boundary, not just typographically nice ones
const hypherEn = new Hypher({ ...enUs, leftmin: 1, rightmin: 2 });

// ============================================================================
// GREEK
// ============================================================================

const GREEK_VOWELS = new Set('αεηιουω');
const GREEK_DIPHTHONGS = new Set(['αι', 'ει', 'οι', 'υι', 'ου', 'αυ', 'ευ', 'ηυ', 'ωυ']);
// Clusters a Greek word can begin with stay together on the next syllable
// (Χρι-στός, ἀ-νέ-στη); any other cluster splits after its first letter
// (ἄγ-γε-λος, Ἀλ-λη-λού-ι-α).
const GREEK_ONSETS = new Set((
  'βγ βδ βλ βρ γδ γκ γλ γμ γν γρ δν δρ θλ θν θρ κλ κμ κν κρ κτ μν μπ ντ '
  + 'πλ πν πρ πτ σβ σγ σθ σκ σλ σμ σν σπ στ σφ σχ τζ τμ τρ τσ φθ φλ φν φρ φτ '
  + 'χθ χλ χμ χν χρ σκλ σκρ σπλ σπρ στρ σφρ φτρ χτρ γκλ γκρ μπλ μπρ ντρ'
).split(' '));

const DIAERESIS = '̈';
const YPOGEGRAMMENI = 'ͅ';

function isGreek(word) {
  return /[Ͱ-Ͽἀ-῿]/.test(word);
}

// Letters with their combining marks, so accents travel with their letter
function greekUnits(word) {
  const units = [];
  for (const ch of word.normalize('NFD')) {
    if (/\p{M}/u.test(ch) && units.length) {
      const u = units[units.length - 1];
      u.text += ch;
      if (ch === DIAERESIS) u.diaeresis = true;
      else if (ch !== YPOGEGRAMMENI) u.marked = true;
    } else {
      const base = ch.toLowerCase().replace('ς', 'σ');
      units.push({ text: ch, base, diaeresis: false, marked: false });
    }
  }
  return units;
}

// Break positions (in characters of the NFC word) for a Greek word
function greekBreaks(word) {
  const units = greekUnits(word);
  // Vowel nuclei: a vowel, or a diphthong unless the second letter has a
  // diaeresis or the first carries the accent or breathing (ϊ, άι).
  const nuclei = [];
  for (let i = 0; i < units.length; i++) {
    if (!GREEK_VOWELS.has(units[i].base)) continue;
    const next = units[i + 1];
    if (next && GREEK_DIPHTHONGS.has(units[i].base + next.base)
        && !next.diaeresis && !units[i].marked) {
      nuclei.push([i, i + 1]);
      i++;
    } else {
      nuclei.push([i, i]);
    }
  }
  const unitBreaks = [];
  for (let n = 1; n < nuclei.length; n++) {
    const from = nuclei[n - 1][1] + 1;
    const to = nuclei[n][0];          // the consonants are units[from..to)
    let onset = 0;
    for (let len = Math.min(3, to - from); len >= 2; len--) {
      const cluster = units.slice(to - len, to).map(u => u.base).join('');
      if (GREEK_ONSETS.has(cluster)) { onset = len; break; }
    }
    if (!onset) onset = to > from ? 1 : 0;
    unitBreaks.push(to - onset);
  }
  // Unit index to character offset in the NFC form
  const offsets = [];
  let pos = 0;
  for (const u of units) { offsets.push(pos); pos += u.text.normalize('NFC').length; }
  return unitBreaks.map(i => offsets[i]);
}

// ============================================================================
// ENGLISH
// ============================================================================

// Church words the patterns get wrong or leave whole
const EN_EXCEPTIONS = Object.fromEntries((
  'al-le-lu-i-a a-men ho-ly ev-er-y glo-ry ris-en heav-en heav-ens heav-en-ly '
  + 'a-ges Ky-ri-e e-le-i-son The-o-to-kos Chris-te Sa-vi-our Sav-iour '
  + 'Mar-y vir-gin bless-ed glo-ri-ous glo-ri-fy pow-er pow-ers ev-er '
  + 'fa-ther moth-er spir-it e-ter-nal cre-a-tion cre-a-tor tri-ni-ty '
  + 'Is-ra-el Je-ru-sa-lem Je-sus Mes-si-ah an-gel an-gels hea-ven-ward '
  + 'peo-ple low-ly ho-ly-ness ho-li-ness a-bide a-bove a-gain a-live '
  + 'Ma-ri-a i-con i-cons Pas-cha pas-cha be-ing see-ing'
).split(' ').map(w => [w.replace(/-/g, '').toLowerCase(), w]));

const EN_VOWEL = /[aeiouy]/i;
const EN_ONSETS = new Set((
  'bl br ch cl cr dr dw fl fr gl gr kn ph pl pr qu sc sh sk sl sm sn sp st sw '
  + 'th tr tw wh wr chr sch scr shr spl spr squ str thr'
).split(' '));

// Vowel groups in an English fragment, with a silent final e (or -es/-ed)
// left out: "love", "loves" are one group, "table", "ages" two.
function enVowelGroups(s, atWordEnd) {
  // Trailing punctuation does not hide a silent e ("life.")
  const lower = atWordEnd ? s.toLowerCase().replace(/[^\p{L}]+$/u, '') : s.toLowerCase();
  const groups = [];
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    const vowel = ch === 'y' ? i > 0 && !EN_VOWEL.test(lower[i - 1]) : EN_VOWEL.test(ch);
    if (!vowel) continue;
    const last = groups[groups.length - 1];
    if (last && last[1] === i - 1 && ch !== 'y') last[1] = i;
    else groups.push([i, i]);
  }
  if (atWordEnd && groups.length > 1) {
    const g = groups[groups.length - 1];
    const tail = lower.slice(g[0]);
    const before = lower.slice(0, g[0]);
    const silentE = tail === 'e' && !/[^aeiouy]l$/.test(before) && /[^aeiouy]$/.test(before);
    const silentEs = tail === 'es' && /[^aeiouy]$/.test(before) && !/(s|x|z|ch|sh|g|c)$/.test(before);
    const silentEd = tail === 'ed' && /[^aeiouy]$/.test(before) && !/[td]$/.test(before);
    if (g[0] === g[1] && (silentE || silentEs || silentEd)) groups.pop();
  }
  return groups;
}

// Split a fragment the patterns left with more than one vowel group
function enFallbackBreaks(s, atWordEnd) {
  const groups = enVowelGroups(s, atWordEnd);
  const breaks = [];
  const lower = s.toLowerCase();
  for (let n = 1; n < groups.length; n++) {
    const from = groups[n - 1][1] + 1;
    const to = groups[n][0];
    const cons = lower.slice(from, to);
    let onset;
    if (cons.length <= 1) onset = cons.length;
    else if (cons.endsWith('ck') || cons === 'x') onset = 0;
    else {
      onset = 1;
      for (let len = Math.min(3, cons.length); len >= 2; len--) {
        if (EN_ONSETS.has(cons.slice(-len))) { onset = len; break; }
      }
    }
    const at = to - onset;
    if (at > 0 && at < s.length) breaks.push(at);
  }
  return breaks;
}

function englishBreaks(word) {
  const key = word.toLowerCase().replace(/[^\p{L}]/gu, '');
  const known = EN_EXCEPTIONS[key];
  if (known) {
    // Map the exception's breaks onto the word as typed (punctuation kept)
    const breaks = [];
    let letters = 0;
    const want = new Set();
    let count = 0;
    for (const ch of known) { if (ch === '-') want.add(count); else count++; }
    for (let i = 0; i < word.length; i++) {
      if (/\p{L}/u.test(word[i])) {
        if (want.has(letters) && letters > 0) breaks.push(i);
        letters++;
      }
    }
    return breaks;
  }
  const parts = hypherEn.hyphenate(word);
  const breaks = [];
  let pos = 0;
  parts.forEach((part, k) => {
    for (const b of enFallbackBreaks(part, k === parts.length - 1)) breaks.push(pos + b);
    pos += part.length;
    if (k < parts.length - 1) breaks.push(pos);
  });
  // Every syllable needs a sounded vowel ("you", "tombs" stay whole)
  return breaks.filter(b => enVowelGroups(word.slice(0, b), false).length
    && enVowelGroups(word.slice(b), true).length);
}

// Break positions for a word without hand breaks
export function autoBreaks(word) {
  if (word.length < 2) return [];
  return isGreek(word) ? greekBreaks(word) : englishBreaks(word);
}

export function syllabify(word) {
  const breaks = autoBreaks(word);
  const out = [];
  let prev = 0;
  for (const b of breaks) { out.push(word.slice(prev, b)); prev = b; }
  out.push(word.slice(prev));
  return out;
}

// ============================================================================
// TEXT <-> NOTE SLOTS
// ============================================================================

/**
 * Parse lyric text into one slot per note.
 * @returns {{text: string, start: number, end: number}[]} each slot's lyric
 *   and the range of the source text it came from (for the caret)
 */
export function parseLyricText(text, { auto = true } = {}) {
  const slots = [];
  let lastSyllable = null;   // the slot a leading '_' holds over
  const re = /[^ \t\n]+/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const base = m.index;
    let letters = '';
    const src = [];          // source offset of each letter
    const hand = [];         // letter positions of '-'
    const holds = [];        // { at: letter position, src }
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '-') hand.push(letters.length);
      else if (ch === '_') holds.push({ at: letters.length, src: base + i });
      else { letters += ch; src.push(base + i); }
    }
    const handMode = hand.length > 0 || !auto || letters.includes('~');
    const cuts = new Set(handMode ? hand : autoBreaks(letters));
    for (const h of holds) cuts.add(h.at);
    const bounds = [...cuts].filter(c => c > 0 && c < letters.length).sort((a, b) => a - b);
    const syls = [];
    let prev = 0;
    for (const b of [...bounds, letters.length]) {
      if (b > prev) syls.push([prev, b]);
      prev = b;
    }

    const holdSlot = (h, display) => ({ text: display, start: h.src, end: h.src + 1 });
    // Holds before the first letter carry the previous word's last syllable
    for (const h of holds.filter(h => h.at === 0)) {
      slots.push(lastSyllable ? holdSlot(h, '_') : holdSlot(h, ''));
    }
    // A word left ending in '-' goes on past the last note
    const openEnd = hand.includes(letters.length) && letters.length > 0;
    syls.forEach(([a, b], k) => {
      const more = k < syls.length - 1 || openEnd;
      const syl = letters.slice(a, b).replace(/~/g, ' ');
      const slot = { text: syl + (more ? '-' : ''), start: src[a], end: src[b - 1] + 1 };
      slots.push(slot);
      lastSyllable = slot;
      for (const h of holds.filter(h => h.at === b && b > 0)) {
        slots.push(holdSlot(h, more ? '-' : '_'));
      }
    });
  }
  return slots;
}

/** Rebuild editable text from the notes' lyrics (inverse of parseLyricText). */
export function buildLyricText(lyrics) {
  let out = '';
  let inWord = false;
  let pendingBlanks = 0;     // empty lyrics are held notes, unless trailing
  const hold = () => {
    if (out.endsWith('-')) out = out.slice(0, -1) + '_';
    else if (out.endsWith(' ')) out = out.slice(0, -1) + '_ ';
    else out += '_';
  };
  for (const raw of lyrics) {
    const l = (raw || '').trim();
    if (!l) { pendingBlanks++; continue; }
    for (; pendingBlanks > 0; pendingBlanks--) hold();
    if (l === '-' || l === '_') { hold(); continue; }
    if (out && !inWord && !out.endsWith(' ')) out += ' ';
    out += l.replace(/ +/g, '~');
    inWord = l.endsWith('-');
    if (!inWord) out += ' ';
  }
  return out;
}

/** Index of the slot the caret is in (slots.length: the note after them). */
export function slotAtCaret(slots, text, caret) {
  const i = slots.findIndex(s => caret <= s.end);
  if (i >= 0) return i;
  if (!slots.length) return 0;
  const tail = text.slice(slots[slots.length - 1].end, caret);
  return /\s/.test(tail) ? slots.length : slots.length - 1;
}
