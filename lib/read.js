// Reading a line of a scanned score with Claude (transcription mode).
//
// POST /api/admin/read-line, behind Cloudflare Access like the rest of the
// account API, so only signed-in people can spend on it. The browser sends
// one line of the scan (a JPEG, a few tens of kB) and, as examples, up to
// two lines of the same score already written by hand with their notes. The
// answer is the line's notes in Gorgon's own terms, each marked when Claude
// was unsure of it; the browser tints those for review.
//
// Needs the Worker secret ANTHROPIC_API_KEY (without it the endpoint answers
// 503 and the page says reading is not set up). Each account may read
// READ_LINES_PER_MONTH lines a calendar month (wrangler.jsonc vars), counted
// in D1 (`reads`), so the cost stays bounded.

import Anthropic from '@anthropic-ai/sdk';
import neumeValues from '../data/theory/neume-values.json';

const MODEL = 'claude-opus-5-5';
const MAX_IMAGE_B64 = 1_500_000;        // about 1.1 MB of JPEG
const DEFAULT_CAP = 400;                // lines per account per month

const READS_DDL = `CREATE TABLE IF NOT EXISTS reads (
  email TEXT NOT NULL,
  month TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, month)
)`;

// The vocabulary: what Gorgon can draw
const NEUMES = Object.keys(neumeValues.neumeValues)
  .filter(n => !/^(Breath|VareiaDotted\d?|Cross)$/.test(n));
const TIMES = ['', 'klasmaAbove', 'klasmaBelow', 'apli', 'dipli', 'tripli', 'tetrapli'];
const GORGONS = ['', 'gorgonAbove', 'gorgonBelow', 'digorgon', 'trigorgon'];
const QUALITIES = ['', 'psifiston', 'vareia', 'omalon', 'antikenoma', 'heteron', 'endofonon', 'stavros'];

const SCHEMA = {
  type: 'object',
  properties: {
    symbols: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['note', 'martyria', 'rest'] },
          neume: { type: 'string', enum: ['', ...NEUMES] },
          time: { type: 'string', enum: TIMES },
          gorgon: { type: 'string', enum: GORGONS },
          quality: { type: 'string', enum: QUALITIES },
          lyric: { type: 'string' },
          unsure: { type: 'boolean' },
        },
        required: ['kind', 'neume', 'time', 'gorgon', 'quality', 'lyric', 'unsure'],
        additionalProperties: false,
      },
    },
  },
  required: ['symbols'],
  additionalProperties: false,
};

const values = (n) => neumeValues.neumeValues[n];

const SYSTEM = `You transcribe one line of a scanned Byzantine chant score (neumes in Byzantine notation, with the words underneath, usually English) into Gorgon's symbols.

Read the line left to right. Write one symbol per neume group the singer sings as one note: the base (quantitative) neume, with the time sign, gorgon and quality sign that belong to it, and the syllable written under it.

- kind "note": neume = the quantitative neume (its step in brackets below). time / gorgon / quality = "" when there is none.
- kind "martyria": a pitch signature (a note letter such as πα, βου, γα, δι, κε, ζω, νη with a sign under it, e.g. a pi over a 9-like hook, or a delta over two dots). neume, time, gorgon, quality = "".
- kind "rest": a leimma (a hooked parenthesis with a dot). Everything else "".

Syllables: the syllable under the note, with "-" after it when the word goes on ("glo-", "ri-", "fied"); "_" when the note only holds the syllable before it (a melisma line); "-" alone when the note continues a word without a new syllable; "" when there is no word. Keep the scribe's punctuation.

Mark unsure: true on any symbol you are not confident of (the neume, a sign, or where it falls). Be honest: these are the ones a person checks first.

Neumes (step): ${NEUMES.map(n => `${n} (${values(n) > 0 ? '+' : ''}${values(n)})`).join(', ')}.
Time signs: klasmaAbove / klasmaBelow (a small arc over or under), apli (one dot under), dipli (two dots), tripli, tetrapli.
Gorgon: gorgonAbove / gorgonBelow (a small Γ), digorgon, trigorgon.
Quality: psifiston, vareia (a slanted stroke before the note), omalon, antikenoma (a curl at the right end of a line under the note), heteron, endofonon, stavros (a small cross).

Shapes: ison = a short flat stroke with a hook at its left end; oligon = a long straight horizontal stroke; apostrophos = a small reversed "c" or ")"; elaphron = a shallow arc, often drawn as a long swoop with a small hook; running elaphron = apostrophos joined to an elaphron; petasti = a bowl open upwards with a hooked end; kentima = one short stroke, kentemata = two short strokes or dots side by side (on top of an oligon: KentemataPlusOligon; under it: OligonPlusKentemata); hypsili = a short upright or slanted flag at the right end above an oligon or petasti (OligonPlusHypsiliRight, PetastiPlusHypsiliRight). Do not read a hypsili as a gorgon: a gorgon is a small Γ and changes time, not pitch.

When examples of this scribe's lines with their correct symbols are given, follow how this scribe draws each sign.`;

let ensured = false;
async function ensure(db) {
  if (ensured) return;
  await db.prepare(READS_DDL).run();
  ensured = true;
}

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const month = () => new Date().toISOString().slice(0, 7);

function imageBlock(b64) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } };
}

function validImage(b64) {
  return typeof b64 === 'string' && b64.length > 100 && b64.length < MAX_IMAGE_B64 && /^[A-Za-z0-9+/=]+$/.test(b64);
}

/** POST /api/admin/read-line, for a signed-in email */
export async function handleReadLine(request, env, db, email) {
  if (request.method === 'GET') {
    // What the page needs to know before offering the button
    const cap = Number(env.READ_LINES_PER_MONTH) || DEFAULT_CAP;
    if (!env.ANTHROPIC_API_KEY) return json({ ready: false, cap });
    await ensure(db);
    const row = await db.prepare('SELECT lines FROM reads WHERE email = ? AND month = ?').bind(email, month()).first();
    return json({ ready: true, used: row ? row.lines : 0, cap });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Reading is not set up', ready: false }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  if (!validImage(body?.image)) return json({ error: 'No line picture' }, 400);
  const examples = (Array.isArray(body.examples) ? body.examples : [])
    .filter(x => validImage(x?.image) && Array.isArray(x?.symbols)).slice(0, 2);

  const cap = Number(env.READ_LINES_PER_MONTH) || DEFAULT_CAP;
  await ensure(db);
  const m = month();
  const row = await db.prepare('SELECT lines FROM reads WHERE email = ? AND month = ?').bind(email, m).first();
  const used = row ? row.lines : 0;
  if (used >= cap) return json({ error: `This month's ${cap} lines have been read. More next month.`, used, cap }, 429);

  const mode = Number(body.mode) >= 1 && Number(body.mode) <= 8 ? Number(body.mode) : null;
  const content = [];
  examples.forEach((x, i) => {
    content.push({ type: 'text', text: `Example ${i + 1}: a line by the same scribe, and its correct symbols.` });
    content.push(imageBlock(x.image));
    content.push({ type: 'text', text: JSON.stringify({ symbols: x.symbols.slice(0, 60) }) });
  });
  content.push({ type: 'text', text: `Transcribe this line${mode ? ` (the piece is in mode ${mode})` : ''}.` });
  content.push(imageBlock(body.image));

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Claude is busy. Try again in a minute.' }, 503);
    if (e instanceof Anthropic.APIError) return json({ error: `Claude could not read it (${e.status ?? 'error'}).` }, 502);
    return json({ error: 'Could not reach Claude.' }, 502);
  }
  if (res.stop_reason === 'refusal') return json({ error: 'Claude declined to read this line.' }, 422);
  if (res.stop_reason === 'max_tokens') return json({ error: 'The line was too long to read in one go.' }, 422);

  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { return json({ error: 'Claude answered in a form Gorgon could not read.' }, 502); }

  await db.prepare(`INSERT INTO reads (email, month, lines) VALUES (?, ?, 1)
    ON CONFLICT (email, month) DO UPDATE SET lines = lines + 1`).bind(email, m).run();
  return json({ symbols: Array.isArray(out?.symbols) ? out.symbols : [], used: used + 1, cap });
}
