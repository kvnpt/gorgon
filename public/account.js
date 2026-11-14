// Gorgon — saving scores to an account (Cloudflare Access sign-in)
// GPL-3.0
//
// Signed out, nothing changes: the open score lives in this browser's
// localStorage (app.js, 'gorgon-score-v2'). Signed in, the same score is also
// sent to the account under its own id (score.metadata.id), and the account
// menu lists every score the account holds.
//
// Nothing is ever replaced by signing in. The score this browser made as a
// visitor joins the account as one more document. A score changed on two
// devices at once is not merged either: the server refuses the older write
// (409), and this browser keeps its version as a separate copy.
//
// The server side is lib/documents.js; Access (agora's application) covers /admin and
// /api/admin/* only (lib/access.js).

const API = '/api/admin/documents';
const ACCOUNT_KEY = 'gorgon-account';   // who this browser last synced as
const SYNC_KEY = 'gorgon-sync';         // { [docId]: { base, sent } }

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage refused */ } };
const readSync = () => { try { return JSON.parse(lsGet(SYNC_KEY) || '{}') || {}; } catch { return {}; } };
const writeSync = (m) => lsSet(SYNC_KEY, JSON.stringify(m));

// FNV-1a: cheap "has this changed since we sent it".
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + str.length;
}

export function newDocId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isBlank = (score) => !score.elements?.length && !String(score.metadata?.title || '').trim();

let hooks = null;          // { getScore, openScore, newScore, toast }
let state = 'unknown';     // 'unknown' | 'off' | 'visitor' | 'signed-in'
let who = null;
let docs = [];
let busy = null;           // the sync in flight, so two never overlap

async function api(path = '', opts = {}) {
  // redirect: 'manual' so a signed-out request, which Access answers with a
  // redirect to its login page, reads as "not signed in" rather than a CORS error.
  const res = await fetch(API + path, { cache: 'no-store', redirect: 'manual', credentials: 'same-origin', ...opts })
    .catch(() => null);
  return res;
}

/** The open score's id, giving it one if it has none (older saves). */
function currentId(score) {
  score.metadata = score.metadata || {};
  if (!score.metadata.id) score.metadata.id = newDocId();
  return score.metadata.id;
}

/** Has the open score changed since the account last had it? */
function isDirty(score) {
  const meta = readSync()[currentId(score)];
  return !meta || meta.sent !== hash(JSON.stringify(score));
}

async function put(score, base) {
  const res = await api('/' + encodeURIComponent(currentId(score)), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score, base }),
  });
  if (!res) return { ok: false };
  if (res.status === 409) return { conflict: true, ...(await res.json().catch(() => ({}))) };
  if (!res.ok) {
    if (res.status === 401 || res.type === 'opaqueredirect') setState('visitor');
    return { ok: false };
  }
  return { ok: true, ...(await res.json().catch(() => ({}))) };
}

/**
 * Send the open score if it changed. Resolves true once the account holds
 * exactly what is open (or nobody is signed in to send it to).
 */
export function syncNow() {
  if (state !== 'signed-in') return Promise.resolve(state !== 'unknown');
  if (busy) return busy.then(() => syncNow());
  busy = (async () => {
    const score = hooks.getScore();
    const id = currentId(score);
    const text = JSON.stringify(score);
    const h = hash(text);
    const sync = readSync();
    const meta = sync[id];
    if (meta && meta.sent === h) return true;
    if (!meta && isBlank(score)) return true;   // no empty documents on the account

    const out = await put(score, meta ? meta.base : null);
    if (out.ok) {
      writeSync({ ...readSync(), [id]: { ...readSync()[id], base: out.updated_at, sent: h } });
      bumpDoc(id, score, out.updated_at);
      if (out.shared) sendPreview(id);
      return true;
    }
    if (out.conflict) {
      // Changed here and elsewhere. Keep both: this one becomes a new document.
      // getScore() shares metadata with the live score, so this renames the open one.
      hooks.getScore().metadata.id = newDocId();
      hooks.saveLocal();
      const copy = hooks.getScore();
      const again = await put(copy, null);
      if (again.ok) {
        writeSync({ ...readSync(), [copy.metadata.id]: { base: again.updated_at, sent: hash(JSON.stringify(copy)) } });
        bumpDoc(copy.metadata.id, copy, again.updated_at);
      }
      hooks.toast('This score was also changed on another device. Yours is kept as a separate copy.');
      return !!again.ok;
    }
    return false;
  })().finally(() => { busy = null; });
  return busy;
}

function bumpDoc(id, score, updated_at) {
  docs = [{ id, title: String(score.metadata?.title || ''), updated_at },
    ...docs.filter(d => d.id !== id)];
  renderMenu();
}

/** Ask the account who is signed in and what it holds; bring the open score level. */
async function refresh() {
  const res = await api();
  if (!res) { if (state === 'unknown') setState('visitor'); return; }
  if (res.status === 503) { setState('off'); return; }
  if (!res.ok) { setState('visitor'); return; }
  const got = await res.json().catch(() => null);
  if (!got || typeof got.identity !== 'string') { setState('visitor'); return; }

  who = got.identity;
  docs = got.documents || [];
  const was = lsGet(ACCOUNT_KEY);
  const score = hooks.getScore();
  const id = currentId(score);

  if (was && was !== who) {
    // Another account was signed in here before. Its sync records mean
    // nothing for this one. If the open score is already safe on that other
    // account, start from this account's newest score instead of copying it
    // across; if it has unsent changes, keep it and it joins this account.
    const dirty = isDirty(score);
    writeSync({});
    lsSet(ACCOUNT_KEY, who);
    setState('signed-in');
    if (!dirty) {
      if (docs.length) await openDoc(docs[0].id, { skipSave: true });
      else hooks.newScore();
      return;
    }
  } else {
    lsSet(ACCOUNT_KEY, who);
    setState('signed-in');
  }

  // Changed on another device while this one was untouched: take theirs.
  const meta = readSync()[id];
  const remote = docs.find(d => d.id === id);
  if (meta && remote && remote.updated_at !== meta.base && !isDirty(score)) {
    await openDoc(id, { skipSave: true });
    return;
  }
  await syncNow();
}

async function openDoc(id, { skipSave = false } = {}) {
  if (!skipSave) {
    const ok = await syncNow();
    if (!ok) {
      hooks.toast('Could not save this score to your account just now. Try again when you are online.');
      return false;
    }
  }
  const res = await api('/' + encodeURIComponent(id));
  if (!res || !res.ok) { hooks.toast('Could not open that score.'); return false; }
  const got = await res.json().catch(() => null);
  if (!got || !got.score) return false;
  const score = got.score;
  score.metadata = score.metadata || {};
  score.metadata.id = id;
  hooks.openScore(score);
  writeSync({ ...readSync(), [id]: { base: got.updated_at, sent: hash(JSON.stringify(hooks.getScore())) } });
  return true;
}

async function deleteDoc(id) {
  const res = await api('/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res || !res.ok) { hooks.toast('Could not delete that score.'); return; }
  const sync = readSync(); delete sync[id]; writeSync(sync);
  docs = docs.filter(d => d.id !== id);
  if (id === currentId(hooks.getScore())) {
    // The open one stays open, now only in this browser; it goes back to the
    // account only if it is changed again.
    writeSync({ ...readSync(), [id]: { base: null, sent: hash(JSON.stringify(hooks.getScore())) } });
  }
  renderMenu();
}

/** Can the open score be put away without asking (it is safe on the account)? */
export async function currentIsSaved() {
  if (state !== 'signed-in') return false;
  return syncNow();
}

/**
 * A shared score's link preview (the picture chat apps show): drawn by the
 * editor (hooks.previewImage) and sent when what it shows has changed.
 */
let previewBusy = false;
async function sendPreview(id, force = false) {
  if (previewBusy || !hooks.previewImage) return;
  const key = hash(hooks.previewKey());
  if (!force && readSync()[id]?.preview === key) return;
  previewBusy = true;
  try {
    const png = await hooks.previewImage();
    if (!png || currentId(hooks.getScore()) !== id) return;
    const res = await api('/' + encodeURIComponent(id) + '/preview', {
      method: 'PUT', headers: { 'content-type': 'image/png' }, body: png,
    });
    if (res && res.ok) writeSync({ ...readSync(), [id]: { ...readSync()[id], preview: key } });
  } catch { /* tried again with the next change */ } finally {
    previewBusy = false;
  }
}

// ---------------------------------------------------------------------------
// UI: a header button (Sign in / Scores) and the account sheet
// ---------------------------------------------------------------------------

function setState(s) {
  state = s;
  const share = document.getElementById('btn-share');
  if (share) share.hidden = s === 'off' || s === 'unknown';
  const btn = document.getElementById('btn-account');
  if (!btn) return;
  btn.hidden = s === 'off' || s === 'unknown';
  btn.textContent = s === 'signed-in' ? 'Scores' : 'Sign in';
  btn.classList.toggle('signed-in', s === 'signed-in');
  btn.title = s === 'signed-in' ? `Your scores (${who})` : 'Sign in to save your scores to your account';
  renderMenu();
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function renderMenu() {
  const sheet = document.getElementById('account-sheet');
  if (!sheet || sheet.hidden) return;
  const openId = hooks ? currentId(hooks.getScore()) : null;
  const rows = docs.length
    ? docs.map(d => `
      <li class="doc-row${d.id === openId ? ' open' : ''}">
        <button type="button" class="doc-open" data-open="${esc(d.id)}">
          <span class="doc-title">${esc(d.title || 'Untitled')}</span>
          <span class="doc-date">${d.id === openId ? 'Open' : esc(fmtDate(d.updated_at))}</span>
        </button>
        <button type="button" class="doc-del" data-del="${esc(d.id)}" aria-label="Delete ${esc(d.title || 'Untitled')}">×</button>
      </li>`).join('')
    : '<li class="doc-empty">Nothing saved yet. Your open score is saved here as you write.</li>';
  sheet.querySelector('.sheet-body').innerHTML = `
    <div class="sheet-label">Signed in as</div>
    <div class="sheet-who">${esc(who || '')}</div>
    <div class="sheet-label">Your scores</div>
    <ul class="doc-list">${rows}</ul>
    <div class="sheet-actions">
      <a class="header-btn" href="/cdn-cgi/access/logout">Sign out</a>
    </div>`;
}

function openSheet() {
  const sheet = document.getElementById('account-sheet');
  sheet.hidden = false;
  renderMenu();
  syncNow().then(refresh).catch(() => {});
}
function closeSheet() { document.getElementById('account-sheet').hidden = true; }

// ---------------------------------------------------------------------------
// Share: a read-only link to the open score (/s/<token>, lib/documents.js)
// ---------------------------------------------------------------------------
//
// The link reads the account's copy, so sharing needs sign-in and the score
// saved first. It follows later changes. Stop sharing deletes the link.

let shareToken = null;
const shareUrl = (t) => `${location.origin}/s/${t}`;

function renderShare(msg) {
  const sheet = document.getElementById('share-sheet');
  if (!sheet || sheet.hidden) return;
  const body = sheet.querySelector('.sheet-body');
  if (msg || !shareToken) {
    body.innerHTML = `<p class="share-note">${esc(msg || 'Making a link…')}</p>`;
    return;
  }
  const url = shareUrl(shareToken);
  const title = String(hooks.getScore().metadata?.title || '').trim();
  body.innerHTML = `
    <div class="sheet-label">Read-only link${title ? ` to “${esc(title)}”` : ''}</div>
    <div class="share-link">
      <input type="text" id="share-url" readonly value="${esc(url)}" aria-label="Link">
      <button type="button" class="header-btn accent" data-copy>Copy</button>
    </div>
    <p class="share-note">Anyone with the link can read and chant from it on their phone, and make their own copy to edit. They can't change yours. It always shows your latest version.</p>
    <div class="sheet-actions share-actions">
      <button type="button" class="header-btn" data-unshare>Stop sharing</button>
      ${navigator.share ? '<button type="button" class="header-btn" data-native>Send…</button>' : ''}
      <a class="header-btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
    </div>`;
}

async function openShare() {
  const sheet = document.getElementById('share-sheet');
  shareToken = null;
  sheet.hidden = false;
  renderShare();
  const score = hooks.getScore();
  if (isBlank(score)) return renderShare('Write some music first, then share it.');
  if (!(await syncNow())) return renderShare('Could not save this score to your account just now. Try again when you are online.');
  const path = '/' + encodeURIComponent(currentId(hooks.getScore())) + '/share';
  let res = await api(path);
  if (res && res.status === 404) res = await api(path, { method: 'POST' });
  const got = res && res.ok ? await res.json().catch(() => null) : null;
  if (!got || !got.token) return renderShare('Could not make a link just now. Try again in a moment.');
  shareToken = got.token;
  renderShare();
  sendPreview(currentId(hooks.getScore()));
}

function closeShare() { document.getElementById('share-sheet').hidden = true; }

function initShare() {
  const btn = document.getElementById('btn-share');
  const sheet = document.getElementById('share-sheet');
  if (!btn || !sheet) return;
  btn.addEventListener('click', () => {
    if (state === 'signed-in') return openShare();
    // The link lives on the account: sign in, then come back to share
    if (!confirm('Sharing a link keeps the score on your account, so anyone with the link sees your latest version. Sign in to share?')) return;
    hooks.saveLocal();
    location.href = '/admin?back=' + encodeURIComponent('/?share=1');
  });
  sheet.addEventListener('click', async (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) return closeShare();
    if (!shareToken) return;
    const url = shareUrl(shareToken);
    if (e.target.closest('[data-copy]')) {
      try { await navigator.clipboard.writeText(url); hooks.toast('Link copied.'); }
      catch { const f = document.getElementById('share-url'); f.focus(); f.select(); }
    } else if (e.target.closest('[data-native]')) {
      const title = String(hooks.getScore().metadata?.title || '').trim();
      navigator.share({ title: title || 'Gorgon', url }).catch(() => {});
    } else if (e.target.closest('[data-unshare]')) {
      const res = await api('/' + encodeURIComponent(currentId(hooks.getScore())) + '/share', { method: 'DELETE' });
      if (!res || !res.ok) { hooks.toast('Could not stop sharing just now.'); return; }
      shareToken = null;
      closeShare();
      hooks.toast('Stopped sharing. The link no longer works.');
    }
  });
  sheet.addEventListener('focusin', (e) => { if (e.target.id === 'share-url') e.target.select(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeShare(); });
}

/** Resolves once the account has answered who is signed in. */
export function initAccount(h) {
  hooks = h;
  const btn = document.getElementById('btn-account');
  btn.addEventListener('click', () => {
    if (state === 'signed-in') return openSheet();
    hooks.saveLocal();
    location.href = '/admin?back=' + encodeURIComponent(location.pathname + location.search);
  });
  const sheet = document.getElementById('account-sheet');
  sheet.addEventListener('click', async (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) return closeSheet();
    const open = e.target.closest('[data-open]');
    if (open) {
      const id = open.dataset.open;
      if (id === currentId(hooks.getScore()) || await openDoc(id)) closeSheet();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      const d = docs.find(x => x.id === del.dataset.del);
      if (d && confirm(`Delete "${d.title || 'Untitled'}" from your account?`)) await deleteDoc(d.id);
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

  initShare();
  currentId(hooks.getScore());
  const ready = refresh().then(() => {
    // Back from signing in to share
    const q = new URLSearchParams(location.search);
    if (q.has('share')) {
      q.delete('share');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
      if (state === 'signed-in') openShare();
    }
  }).catch(() => {});
  setInterval(() => { syncNow(); }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
    else syncNow();
  });
  return ready;
}
