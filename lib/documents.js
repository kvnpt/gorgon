// A signed-in person's scores, in D1: one row per (account, document id).
//
// The browser keeps the open score in localStorage exactly as it does for a
// visitor; signed in, that score is also sent here under its own id. Signing
// in therefore never replaces anything: a score the browser made as a visitor
// is added to the account as one more document, beside whatever is there.
//
// Each write names the version it was based on (`base`, the updated_at the
// browser last saw). A write based on an older version is refused with 409 and
// the newer copy, and the browser keeps its own as a separate document rather
// than overwrite either (public/account.js).
//
// A score can also be shared: a link (/s/<token>) anyone can open to read it,
// never to change it. The link follows the account's copy, so fixes made
// later reach everyone who has it. One token per document; stopping sharing
// deletes it, and sharing again makes a new one.
//
// The tables are created IF NOT EXISTS on first use, so a deploy needs no
// migration step.

import { identity, accessConfigured } from './access.js';

const DDL = `CREATE TABLE IF NOT EXISTS documents (
  email      TEXT NOT NULL,
  id         TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, id)
)`;

export const MAX_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const SHARES_DDL = `CREATE TABLE IF NOT EXISTS shares (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  id         TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (email, id)
)`;

// The picture a chat app shows for a shared link (drawn by the browser,
// public/app.js previewImage): one per document, replaced as it changes
const PREVIEWS_DDL = `CREATE TABLE IF NOT EXISTS previews (
  email      TEXT NOT NULL,
  id         TEXT NOT NULL,
  png        BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, id)
)`;
const MAX_PREVIEW_BYTES = 600 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const TOKEN_RE = /^[A-Za-z0-9]{10,32}$/;
const TOKEN_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function newToken() {
  // 12 of 57 letters: about 70 bits, short enough to read out
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => TOKEN_ABC[b % TOKEN_ABC.length]).join('');
}

const ensured = new WeakSet();
async function ensure(db) {
  if (ensured.has(db)) return;
  await db.batch([db.prepare(DDL), db.prepare(SHARES_DDL), db.prepare(PREVIEWS_DDL)]);
  ensured.add(db);
}

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

const titleOf = (score) => String(score?.metadata?.title || '').trim().slice(0, 200);

async function list(db, email) {
  const { results } = await db.prepare(
    'SELECT id, title, updated_at FROM documents WHERE email = ? ORDER BY updated_at DESC LIMIT 500'
  ).bind(email).all();
  return results || [];
}

async function read(db, email, id) {
  const row = await db.prepare('SELECT data, updated_at FROM documents WHERE email = ? AND id = ?')
    .bind(email, id).first();
  if (!row) return null;
  let score = null;
  try { score = JSON.parse(row.data); } catch { /* unreadable row reads as missing */ }
  return score ? { score, updated_at: row.updated_at } : null;
}

async function write(db, email, id, score, base) {
  const data = JSON.stringify(score);
  const had = await db.prepare('SELECT data, updated_at FROM documents WHERE email = ? AND id = ?')
    .bind(email, id).first();
  if (had && had.data === data) return { updated_at: had.updated_at };
  if (had && had.updated_at !== base) {
    let theirs = null;
    try { theirs = JSON.parse(had.data); } catch { /* replaced below */ }
    return { conflict: true, updated_at: had.updated_at, score: theirs };
  }
  const at = Math.max(Date.now(), (had ? had.updated_at : 0) + 1);
  if (had) {
    // Conditional on the version we compared against, so two writes racing
    // from two devices cannot both win.
    const r = await db.prepare(
      'UPDATE documents SET data = ?, title = ?, updated_at = ? WHERE email = ? AND id = ? AND updated_at = ?'
    ).bind(data, titleOf(score), at, email, id, had.updated_at).run();
    if (!r.meta || r.meta.changes !== 1) return write(db, email, id, score, base);
  } else {
    const r = await db.prepare(
      'INSERT OR IGNORE INTO documents (email, id, title, data, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(email, id, titleOf(score), data, at).run();
    if (!r.meta || r.meta.changes !== 1) return write(db, email, id, score, base);
  }
  return { updated_at: at };
}

/**
 * /api/admin/documents          GET: { identity, documents: [{id,title,updated_at}] }
 * /api/admin/documents/:id      GET: { id, score, updated_at }
 *                                 PUT { score, base }: { id, updated_at } | 409 { conflict, score, updated_at }
 *                                 DELETE: { ok }
 * /api/admin/documents/:id/share GET: { token } | 404   (is it shared?)
 *                                 POST: { token }        (share it; the same link if it already is)
 *                                 DELETE: { ok }         (stop sharing; the link stops working)
 */
export async function handleAccount(request, env, pathname) {
  if (!accessConfigured(env) || !env.DB) {
    return json({ error: 'Sign-in is not set up', configured: false }, 503);
  }
  const email = await identity(request, env);
  if (!email) return json({ error: 'Not signed in', configured: true }, 401);

  const db = env.DB;
  await ensure(db);

  const m = pathname.match(/^\/api\/admin\/documents(?:\/([^/]+)(\/share|\/preview)?)?\/?$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = m[1] ? decodeURIComponent(m[1]) : null;
  const method = request.method;

  if (m[2]) {
    if (!ID_RE.test(id)) return json({ error: 'bad document id' }, 400);
    if (m[2] === '/preview') return handlePreview(db, email, id, request);
    return handleShare(db, email, id, method);
  }

  if (!id) {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return json({ identity: email, documents: await list(db, email) });
  }
  if (!ID_RE.test(id)) return json({ error: 'bad document id' }, 400);

  if (method === 'GET') {
    const doc = await read(db, email, id);
    return doc ? json({ id, ...doc }) : json({ error: 'not found' }, 404);
  }
  if (method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: 'Score too large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'Bad JSON' }, 400); }
    const score = body && body.score;
    if (!score || typeof score !== 'object' || !Array.isArray(score.elements)) {
      return json({ error: 'Not a score' }, 400);
    }
    const base = Number.isFinite(body.base) ? body.base : null;
    const out = await write(db, email, id, score, base);
    if (out.conflict) return json({ id, ...out }, 409);
    // Shared: the browser then keeps the link's preview picture up to date
    return json({ id, updated_at: out.updated_at, shared: !!(await shareOf(db, email, id)) });
  }
  if (method === 'DELETE') {
    // A deleted score's link stops working with it
    await db.batch([
      db.prepare('DELETE FROM documents WHERE email = ? AND id = ?').bind(email, id),
      db.prepare('DELETE FROM shares WHERE email = ? AND id = ?').bind(email, id),
      db.prepare('DELETE FROM previews WHERE email = ? AND id = ?').bind(email, id),
    ]);
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

async function shareOf(db, email, id) {
  const row = await db.prepare('SELECT token FROM shares WHERE email = ? AND id = ?').bind(email, id).first();
  return row ? row.token : null;
}

async function handleShare(db, email, id, method) {
  if (method === 'GET') {
    const token = await shareOf(db, email, id);
    return token ? json({ token }) : json({ error: 'not shared' }, 404);
  }
  if (method === 'POST') {
    const had = await shareOf(db, email, id);
    if (had) return json({ token: had });
    // Only a score the account holds can be shared: the link reads that copy
    const doc = await db.prepare('SELECT 1 AS ok FROM documents WHERE email = ? AND id = ?').bind(email, id).first();
    if (!doc) return json({ error: 'Not saved to the account yet' }, 409);
    for (let tries = 0; tries < 3; tries++) {
      const token = newToken();
      const r = await db.prepare(
        'INSERT OR IGNORE INTO shares (token, email, id, created_at) VALUES (?, ?, ?, ?)'
      ).bind(token, email, id, Date.now()).run();
      if (r.meta && r.meta.changes === 1) return json({ token });
      // Lost a race with another tab sharing the same score: use theirs
      const now = await shareOf(db, email, id);
      if (now) return json({ token: now });
    }
    return json({ error: 'Could not make a link' }, 500);
  }
  if (method === 'DELETE') {
    await db.prepare('DELETE FROM shares WHERE email = ? AND id = ?').bind(email, id).run();
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

// PUT a PNG (the body): the picture shown for the score's shared link
async function handlePreview(db, email, id, request) {
  if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
  const body = await request.arrayBuffer();
  const buf = new Uint8Array(body);
  if (buf.length > MAX_PREVIEW_BYTES) return json({ error: 'Picture too large' }, 413);
  if (PNG_MAGIC.some((b, i) => buf[i] !== b)) return json({ error: 'Not a PNG' }, 400);
  const doc = await db.prepare('SELECT 1 AS ok FROM documents WHERE email = ? AND id = ?').bind(email, id).first();
  if (!doc) return json({ error: 'Not saved to the account yet' }, 409);
  const at = Date.now();
  await db.prepare(
    'INSERT INTO previews (email, id, png, updated_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT (email, id) DO UPDATE SET png = excluded.png, updated_at = excluded.updated_at'
  ).bind(email, id, body, at).run();
  return json({ ok: true, updated_at: at });
}

/** The shared link's preview picture: { png, updated_at } or null */
export async function readPreview(env, token) {
  if (!env.DB || !TOKEN_RE.test(token || '')) return null;
  await ensure(env.DB);
  const row = await env.DB.prepare(
    'SELECT p.png, p.updated_at FROM shares s JOIN previews p ON p.email = s.email AND p.id = s.id WHERE s.token = ?'
  ).bind(token).first();
  if (!row || !row.png || !row.png.length && !row.png.byteLength) return null;
  return { png: new Uint8Array(row.png), updated_at: row.updated_at };
}

/**
 * Public, no sign-in: /api/shared/:token  GET: { title, score, updated_at }
 * Outside /api/admin/, so Access never asks a reader to log in. Only what a
 * reader needs goes out: the score, never whose it is.
 */
export async function readShared(env, token) {
  if (!env.DB || !TOKEN_RE.test(token || '')) return null;
  await ensure(env.DB);
  const row = await env.DB.prepare(
    'SELECT d.data, d.title, d.updated_at, p.updated_at AS preview_at FROM shares s '
    + 'JOIN documents d ON d.email = s.email AND d.id = s.id '
    + 'LEFT JOIN previews p ON p.email = s.email AND p.id = s.id WHERE s.token = ?'
  ).bind(token).first();
  if (!row) return null;
  let score = null;
  try { score = JSON.parse(row.data); } catch { return null; }
  if (score && score.metadata) {
    // The reader gets a copy of the music, not the author's document
    const { id, ...rest } = score.metadata;
    score.metadata = rest;
  }
  return { title: row.title, score, updated_at: row.updated_at, preview_at: row.preview_at || null };
}

export async function handleShared(request, env, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
  const token = decodeURIComponent(pathname.slice('/api/shared/'.length).replace(/\/$/, ''));
  const got = await readShared(env, token);
  if (!got) return json({ error: 'This link is not shared, or no longer is.' }, 404);
  const { preview_at, ...out } = got;
  return Response.json(out, { headers: { 'cache-control': 'no-cache' } });
}

/**
 * /admin sits behind Access (agora's application covers it on every
 * *.orthodoxy.au host), so it is Gorgon's sign-in, as it is agora's. Reaching the Worker means Access let you through;
 * go back to the page you came from (a path on this site only).
 */
export async function handleLogin(request, env) {
  const url = new URL(request.url);
  let back = '/';
  try {
    const b = new URL(url.searchParams.get('back') || '/', url.origin);
    if (b.origin === url.origin && !b.pathname.startsWith('/admin')) back = b.pathname + b.search + b.hash;
  } catch { /* not a path */ }
  if (!accessConfigured(env)) {
    return new Response('Sign-in is not set up on this site yet.\n', {
      status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(null, { status: 302, headers: { location: back, 'cache-control': 'no-store' } });
}
