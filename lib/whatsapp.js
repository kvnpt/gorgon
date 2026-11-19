// A PDF sent on WhatsApp, for a scan (public/app.js "Send it on WhatsApp").
//
// iPhone Safari never hands a copied PDF to a page, so Paste can't take one.
// Instead the editor waits ("listens") a minute for it to come to agora's
// WhatsApp number. Agora owns that number and its webhook; for each PDF, and
// each "Gorgon code 482 193", it asks this Worker over a service binding
// (the GorgonWhatsApp entrypoint below, never reachable from the web) whether
// anyone here is waiting for it, and hands the file over if so.
//
// Who is waiting is a ticket: a random secret the browser polls with, and a
// six-digit code for WhatsApp. A PDF is taken for a ticket when
//   - its caption carries the ticket's code, or
//   - the same phone sent the code first, or
//   - the ticket was opened signed in, and the phone is linked to that
//     account: in agora (whatsapp_links, passed along as linkedEmail), or
//     here, by sending a code once from a signed-in ticket.
// The file waits in D1 (1 MB parts) until the browser fetches it, once.

import { WorkerEntrypoint } from 'cloudflare:workers';

const DDL = [
  `CREATE TABLE IF NOT EXISTS wa_tickets (
    secret     TEXT PRIMARY KEY,
    code       TEXT NOT NULL UNIQUE,
    email      TEXT,
    phone      TEXT,
    state      TEXT NOT NULL DEFAULT 'waiting',
    file_type  TEXT,
    file_name  TEXT,
    size       INTEGER,
    parts      INTEGER,
    ip         TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wa_parts (
    secret TEXT NOT NULL,
    part   INTEGER NOT NULL,
    data   BLOB NOT NULL,
    PRIMARY KEY (secret, part)
  )`,
  `CREATE TABLE IF NOT EXISTS wa_links (
    phone     TEXT PRIMARY KEY,
    email     TEXT NOT NULL,
    linked_at INTEGER NOT NULL
  )`,
];

export const LISTEN_MS = 60_000;          // what the editor counts down
const GRACE_MS = 30_000;                  // a file that lands just after still counts
const KEEP_MS = 60 * 60_000;              // tickets and unfetched files kept an hour
const PART = 1_000_000;
export const MAX_FILE = 25 * 1024 * 1024; // within a service binding's message
const TICKETS_PER_HOUR = 10;              // from one address
const SECRET_RE = /^[A-Za-z0-9_-]{20,64}$/;

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const ensured = new WeakSet();
async function ensure(db) {
  if (ensured.has(db)) return;
  for (const s of DDL) await db.prepare(s).run();
  ensured.add(db);
}

/** "Gorgon code 482 193" (any case, any spacing): "482193". */
export function codeIn(text) {
  const m = /\bgorgon\b\D{0,16}?(\d{3})\s?(\d{3})(?!\d)/i.exec(String(text || ''));
  return m ? m[1] + m[2] : null;
}

export const codeText = (code) => `Gorgon code ${code.slice(0, 3)} ${code.slice(3)}`;
const waUrl = (number, code) => `https://wa.me/${number}?text=${encodeURIComponent(codeText(code))}`;
const newCode = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
function newSecret() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const mask = (phone) => phone ? `+${phone.slice(0, -3).replace(/\d(?=\d{2})/g, '•')}${phone.slice(-3)}` : null;
const isPdf = (b) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

export const whatsappReady = (env) => !!(env.DB && env.WHATSAPP_NUMBER);

/**
 * POST /api/wa/ticket (anyone) or /api/admin/wa/ticket (signed in, email set):
 *   { secret, code, text, url, number, expires_at, linked }
 * GET  /api/wa/ticket/:secret       { state, expires_at, name, size }
 * GET  /api/wa/ticket/:secret/file  the PDF, once
 */
export async function handleTicket(request, env, pathname, email = null) {
  if (!whatsappReady(env)) return json({ error: 'WhatsApp is not set up here.' }, 503);
  const db = env.DB;
  await ensure(db);
  const now = Date.now();

  if (/\/ticket\/?$/.test(pathname)) {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const ip = request.headers.get('cf-connecting-ip') || '';
    await sweep(db, now);
    const recent = await db.prepare('SELECT COUNT(*) AS n FROM wa_tickets WHERE ip = ? AND created_at > ?')
      .bind(ip, now - 3600_000).first();
    if ((recent?.n || 0) >= TICKETS_PER_HOUR) return json({ error: 'Too many tries. Wait a while, or use Upload.' }, 429);
    const secret = newSecret();
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const row = await db.prepare(
        `INSERT INTO wa_tickets (secret, code, email, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO NOTHING RETURNING code`
      ).bind(secret, code, email, ip, now, now + LISTEN_MS).first().catch(() => null);
      if (!row) continue;
      const link = email ? await db.prepare('SELECT phone FROM wa_links WHERE email = ? ORDER BY linked_at DESC').bind(email).first() : null;
      return json({
        secret, code, text: codeText(code), url: waUrl(env.WHATSAPP_NUMBER, code), number: env.WHATSAPP_NUMBER,
        expires_at: now + LISTEN_MS, signed_in: !!email, linked: mask(link?.phone),
      });
    }
    return json({ error: 'Could not make a code. Try again.' }, 503);
  }

  const m = pathname.match(/\/ticket\/([^/]+)(\/file)?\/?$/);
  if (!m || !SECRET_RE.test(m[1])) return json({ error: 'not found' }, 404);
  const t = await db.prepare('SELECT * FROM wa_tickets WHERE secret = ?').bind(m[1]).first();
  if (!t) return json({ error: 'not found' }, 404);
  if (!m[2]) {
    const state = t.state === 'arrived' || t.state === 'taken' ? t.state : now > t.expires_at + GRACE_MS ? 'expired' : t.state;
    return json({ state, expires_at: t.expires_at, name: t.file_name, size: t.size });
  }
  if (t.state !== 'arrived') return json({ error: 'nothing here' }, 404);
  const parts = (await db.prepare('SELECT data FROM wa_parts WHERE secret = ? ORDER BY part').bind(t.secret).all()).results || [];
  const bytes = new Uint8Array(t.size);
  let at = 0;
  for (const p of parts) { const d = new Uint8Array(p.data); bytes.set(d, at); at += d.length; }
  await db.batch([
    db.prepare("UPDATE wa_tickets SET state = 'taken' WHERE secret = ?").bind(t.secret),
    db.prepare('DELETE FROM wa_parts WHERE secret = ?').bind(t.secret),
  ]);
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${String(t.file_name || 'scan.pdf').replace(/[^\w. -]/g, '_')}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function sweep(db, now) {
  const old = now - KEEP_MS;
  await db.batch([
    db.prepare('DELETE FROM wa_parts WHERE secret IN (SELECT secret FROM wa_tickets WHERE created_at < ?)').bind(old),
    db.prepare('DELETE FROM wa_tickets WHERE created_at < ?').bind(old),
  ]);
}

/** The live ticket a message from this phone is for, if any. */
async function ticketFor(env, { from, text, linkedEmail }) {
  const db = env.DB;
  await ensure(db);
  const now = Date.now();
  const live = now - GRACE_MS;
  const code = codeIn(text);
  if (code) {
    return db.prepare("SELECT * FROM wa_tickets WHERE code = ? AND state IN ('waiting', 'code') AND expires_at >= ?")
      .bind(code, live).first();
  }
  const byPhone = await db.prepare(
    "SELECT * FROM wa_tickets WHERE phone = ? AND state = 'code' AND expires_at >= ? ORDER BY created_at DESC"
  ).bind(from, live).first();
  if (byPhone) return byPhone;
  const here = await db.prepare('SELECT email FROM wa_links WHERE phone = ?').bind(from).first();
  const emails = [...new Set([linkedEmail, here?.email].filter(Boolean).map(e => String(e).toLowerCase()))];
  if (!emails.length) return null;
  return db.prepare(
    `SELECT * FROM wa_tickets WHERE email IN (SELECT value FROM json_each(?)) AND state = 'waiting' AND expires_at >= ?
     ORDER BY created_at DESC`
  ).bind(JSON.stringify(emails), live).first();
}

const REPLIES = {
  code: () => 'Got it. Now share the PDF to this chat, and it opens in Gorgon.',
  badCode: () => 'That Gorgon code has run out. Tap Paste in Gorgon again for a new one.',
  got: () => 'Got it. Your PDF is opening in Gorgon.',
  tooLarge: () => 'That PDF is too large for Gorgon (25 MB at most). Save it to Files and use Upload instead.',
  notPdf: () => 'That isn\'t a PDF Gorgon can open. Save it to Files and use Upload instead.',
};

/**
 * What agora's WhatsApp webhook asks, over the service binding
 * (wrangler: services = [{ binding: "GORGON", service: "gorgon", entrypoint: "GorgonWhatsApp" }]).
 */
export class GorgonWhatsApp extends WorkerEntrypoint {
  /**
   * A message agora got: a text, or a PDF (kind 'pdf', with its caption as
   * text). Answers { take: 'code' | 'pdf' | null, reply? }. A code is dealt
   * with here; for 'pdf', agora downloads it and calls deliver().
   */
  async message({ from, text = '', kind, linkedEmail = null }) {
    if (!whatsappReady(this.env) || !from) return { take: null };
    const env = this.env;
    if (kind === 'text') {
      if (!codeIn(text)) return { take: null };
      const t = await ticketFor(env, { from, text, linkedEmail });
      if (!t) return { take: 'code', reply: REPLIES.badCode() };
      const now = Date.now();
      const stmts = [env.DB.prepare("UPDATE wa_tickets SET phone = ?, state = 'code', expires_at = ? WHERE secret = ?")
        .bind(from, now + LISTEN_MS, t.secret)];
      // A code sent for a signed-in ticket links the phone to that account
      if (t.email) {
        stmts.push(env.DB.prepare(
          'INSERT INTO wa_links (phone, email, linked_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET email = excluded.email, linked_at = excluded.linked_at'
        ).bind(from, t.email, now));
      }
      await env.DB.batch(stmts);
      return { take: 'code', reply: REPLIES.code() };
    }
    if (kind === 'pdf') {
      const t = await ticketFor(env, { from, text, linkedEmail });
      return t ? { take: 'pdf' } : { take: null };
    }
    return { take: null };
  }

  /** The PDF itself, once agora has downloaded it: { reply }. */
  async deliver({ from, text = '', linkedEmail = null, bytes, filename = '' }) {
    const env = this.env;
    const t = await ticketFor(env, { from, text, linkedEmail });
    if (!t) return { reply: REPLIES.badCode() };
    const b = new Uint8Array(bytes);
    if (b.length > MAX_FILE) return { reply: REPLIES.tooLarge() };
    if (!isPdf(b)) return { reply: REPLIES.notPdf() };
    const db = env.DB;
    const parts = Math.ceil(b.length / PART);
    const stmts = [db.prepare('DELETE FROM wa_parts WHERE secret = ?').bind(t.secret)];
    for (let i = 0; i < parts; i++) {
      stmts.push(db.prepare('INSERT INTO wa_parts (secret, part, data) VALUES (?, ?, ?)')
        .bind(t.secret, i, b.subarray(i * PART, (i + 1) * PART)));
    }
    stmts.push(db.prepare(
      "UPDATE wa_tickets SET state = 'arrived', phone = ?, file_type = 'application/pdf', file_name = ?, size = ?, parts = ? WHERE secret = ?"
    ).bind(from, String(filename || 'scan.pdf').slice(0, 200), b.length, parts, t.secret));
    await db.batch(stmts);
    return { reply: REPLIES.got() };
  }
}
