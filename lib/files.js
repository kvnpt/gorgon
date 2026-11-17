// The pictures of a score's scan, and the file they came from, kept in the
// account so every device signed in to it can show them (public/scan.js).
//
// A browser keeps them in its own IndexedDB; signed in, it also sends each
// one here once, and another device fetches the ones it lacks. They live in
// the same D1 database as the scores, in parts of at most 1 MB (D1 rows are
// limited to 2 MB), so nothing new needs setting up. Ids are the random ids
// scan.js gives each page or file, and a file never changes under its id.
//
// Only the account that sent a file can read it. What is served is a picture
// or a PDF, never anything a browser would run.

const FILES_DDL = `CREATE TABLE IF NOT EXISTS files (
  email      TEXT NOT NULL,
  id         TEXT NOT NULL,
  part       INTEGER NOT NULL,
  parts      INTEGER NOT NULL DEFAULT 1,
  type       TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  data       BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, id, part)
)`;

const PART = 1_000_000;
const MAX_FILE = 40 * 1024 * 1024;           // one PDF or picture
const MAX_ACCOUNT = 300 * 1024 * 1024;       // all of an account's files
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf']);

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const ensured = new WeakSet();
async function ensure(db) {
  if (ensured.has(db)) return;
  await db.prepare(FILES_DDL).run();
  ensured.add(db);
}

// What the bytes say they are, whatever the request claimed
function sniff(b) {
  const at = (i, ...xs) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf';        // %PDF
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return 'image/heic';             // ....ftyp
  return '';
}

/**
 * /api/admin/files          GET: { files: [{ id, type, name, size }], used, cap }
 * /api/admin/files/:id      GET: the file
 *                           PUT (the bytes; x-file-name): { ok }
 *                           DELETE ?doc=<score id>: { ok, kept? } (kept while another score uses it)
 */
export async function handleFiles(request, env, db, email, pathname) {
  await ensure(db);
  const m = pathname.match(/^\/api\/admin\/files(?:\/([^/]+))?\/?$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = m[1] ? decodeURIComponent(m[1]) : null;
  const method = request.method;

  if (!id) {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const { results } = await db.prepare(
      'SELECT id, type, name, size FROM files WHERE email = ? AND part = 0 ORDER BY updated_at'
    ).bind(email).all();
    const used = await db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE email = ? AND part = 0').bind(email).first();
    return json({ files: results || [], used: used?.n || 0, cap: MAX_ACCOUNT });
  }
  if (!ID_RE.test(id)) return json({ error: 'bad file id' }, 400);

  if (method === 'GET') {
    const { results } = await db.prepare(
      'SELECT part, parts, type, name, data FROM files WHERE email = ? AND id = ? ORDER BY part'
    ).bind(email, id).all();
    const rows = results || [];
    if (!rows.length || rows[0].part !== 0 || rows.length !== rows[0].parts) return json({ error: 'not found' }, 404);
    const chunks = rows.map(r => new Uint8Array(r.data));
    const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { body.set(c, o); o += c.length; }
    const { type, name } = rows[0];
    const headers = {
      'content-type': type,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    };
    if (type === 'application/pdf') {
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name || 'scan.pdf')}`;
    }
    return new Response(body, { headers });
  }

  if (method === 'PUT') {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_FILE) return json({ error: 'File too large' }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) return json({ error: 'Empty file' }, 400);
    if (bytes.length > MAX_FILE) return json({ error: 'File too large' }, 413);
    const type = sniff(bytes);
    if (!TYPES.has(type)) return json({ error: 'Only pictures and PDFs' }, 415);
    let name = '';
    try { name = decodeURIComponent(request.headers.get('x-file-name') || ''); } catch { /* no name */ }
    name = name.replace(/[\u0000-\u001f"\\/]/g, '').slice(0, 200);

    const had = await db.prepare('SELECT size FROM files WHERE email = ? AND id = ? AND part = 0').bind(email, id).first();
    const used = await db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE email = ? AND part = 0').bind(email).first();
    if ((used?.n || 0) - (had?.size || 0) + bytes.length > MAX_ACCOUNT) {
      return json({ error: 'The account has no room for more scans' }, 507);
    }

    // The parts after the first go in first: the file is listed (part 0)
    // only once all of it is there
    const parts = Math.ceil(bytes.length / PART);
    const at = Date.now();
    await db.prepare('DELETE FROM files WHERE email = ? AND id = ?').bind(email, id).run();
    const row = (k) => db.prepare(
      'INSERT INTO files (email, id, part, parts, type, name, size, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(email, id, k, parts, type, name, bytes.length, bytes.slice(k * PART, (k + 1) * PART).buffer, at);
    for (let k = 1; k < parts; k += 4) {
      await db.batch([k, k + 1, k + 2, k + 3].filter(j => j < parts).map(row));
    }
    await row(0).run();
    return json({ ok: true, size: bytes.length });
  }

  if (method === 'DELETE') {
    // A copy of the score (kept after a clash between devices) may use the
    // same pictures: they stay while any other score of the account names them
    const doc = new URL(request.url).searchParams.get('doc') || '';
    const other = await db.prepare(
      "SELECT 1 AS n FROM documents WHERE email = ? AND id != ? AND instr(data, ?) > 0 LIMIT 1"
    ).bind(email, doc, `"${id}"`).first();
    if (other) return json({ ok: true, kept: true });
    await db.prepare('DELETE FROM files WHERE email = ? AND id = ?').bind(email, id).run();
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}
