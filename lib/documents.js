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
// The table is created IF NOT EXISTS on first use, so a deploy needs no
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

const ensured = new WeakSet();
async function ensure(db) {
  if (ensured.has(db)) return;
  await db.prepare(DDL).run();
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
 */
export async function handleAccount(request, env, pathname) {
  if (!accessConfigured(env) || !env.DB) {
    return json({ error: 'Sign-in is not set up', configured: false }, 503);
  }
  const email = await identity(request, env);
  if (!email) return json({ error: 'Not signed in', configured: true }, 401);

  const db = env.DB;
  await ensure(db);

  const m = pathname.match(/^\/api\/admin\/documents(?:\/([^/]+))?\/?$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = m[1] ? decodeURIComponent(m[1]) : null;
  const method = request.method;

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
    return out.conflict ? json({ id, ...out }, 409) : json({ id, updated_at: out.updated_at });
  }
  if (method === 'DELETE') {
    await db.prepare('DELETE FROM documents WHERE email = ? AND id = ?').bind(email, id).run();
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
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
