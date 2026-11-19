// Cloudflare Worker entry: static files come from ./public (Workers static
// assets); this handles the JSON API that server.js serves under Express.
import glyphs from './data/sbmufl/glyphnames.json';
import ranges from './data/sbmufl/ranges.json';
import classes from './data/sbmufl/classes.json';
import neumeValues from './data/theory/neume-values.json';
import scales from './data/theory/scales.json';
import fthoraRules from './data/theory/fthora-rules.json';
import modeKeys from './data/theory/mode-keys.json';
import neumeCombinations from './data/theory/neume-combinations.json';
import martyriaRules from './data/theory/martyria-rules.json';
import attractions from './data/theory/attractions.json';
import { handleAccount, handleLogin, handleShared, readShared, readPreview } from './lib/documents.js';
import { handleTicket } from './lib/whatsapp.js';

// Agora's WhatsApp webhook hands scan PDFs over through this (service binding)
export { GorgonWhatsApp } from './lib/whatsapp.js';

const API = {
  '/api/glyphs': glyphs,
  '/api/ranges': ranges,
  '/api/classes': classes,
  '/api/theory/neume-values': neumeValues,
  '/api/theory/scales': scales,
  '/api/theory/fthora-rules': fthoraRules,
  '/api/theory/mode-keys': modeKeys,
  '/api/theory/neume-combinations': neumeCombinations,
  '/api/theory/martyria-rules': martyriaRules,
  '/api/theory/attractions': attractions,
};

// Serialise once per isolate rather than per request.
const cache = new Map();

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/health') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
    }

    // Behind Cloudflare Access (lib/access.js): sign-in and saved documents.
    if (pathname === '/admin') return handleLogin(request, env);
    if (pathname.startsWith('/api/admin/')) return handleAccount(request, env, pathname);

    // A PDF sent on WhatsApp, waited for by a ticket (lib/whatsapp.js)
    if (pathname.startsWith('/api/wa/ticket')) return handleTicket(request, env, pathname);

    // Shared scores: public, read only (lib/documents.js)
    if (pathname.startsWith('/api/shared/')) return handleShared(request, env, pathname);
    if (/^\/s\/[^/]+\/preview\.png$/.test(pathname)) return sharedPreview(env, pathname);
    if (pathname.startsWith('/s/')) return sharedPage(request, env, pathname);

    if (pathname.startsWith('/api/')) {
      const key = pathname.replace(/\.json$/, '');
      if (!(key in API)) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      if (!cache.has(key)) cache.set(key, JSON.stringify(API[key]));
      return new Response(cache.get(key), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

const MODE_LABELS = {
  1: 'Mode 1', 2: 'Mode 2', 3: 'Mode 3', 4: 'Mode 4',
  5: 'Plagal Mode 1', 6: 'Plagal Mode 2', 7: 'Grave Mode', 8: 'Plagal Mode 4',
};

// /s/<token>: the app shell, which opens read only on a shared path
// (app.js). A link pasted into a chat shows the picture the author's browser
// drew (title and the first notes with their words, /s/<token>/preview.png),
// the hymn's title, and its subtitle and mode below: nothing about Gorgon,
// whose own line (index.html) is only for a link to the home page.
async function sharedPage(request, env, pathname) {
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
  const token = decodeURIComponent(pathname.slice(3).replace(/\/$/, ''));
  let got = null;
  try { got = await readShared(env, token); } catch { /* the page shows the error itself */ }
  const title = got ? (got.title || 'Untitled') : 'Gorgon — Byzantine chant';
  const s = got?.score;
  const mode = MODE_LABELS[s?.modeKey?.mode || s?.mode];
  const hymn = got ? (got.title || 'Untitled') : 'Gorgon';
  const about = [String(s?.metadata?.subtitle || '').trim(), mode].filter(Boolean).join(' · ');
  const desc = about || 'Byzantine chant';
  const origin = new URL(request.url).origin;
  const image = got?.preview_at
    ? `${origin}/s/${encodeURIComponent(token)}/preview.png?v=${got.preview_at}` : null;
  const meta = (attr, key, val) => `<meta ${attr}="${key}" content="${escAttr(val)}">`;
  const res = new HTMLRewriter()
    // The home page's own preview tags give way to the score's
    .on('meta[property^="og:"], meta[name="description"]', { element(el) { el.remove(); } })
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('head', {
      element(el) {
        el.append(meta('name', 'description', desc)
          + meta('property', 'og:title', hymn)
          + meta('property', 'og:description', desc)
          + meta('property', 'og:type', 'article')
          + meta('property', 'og:url', `${origin}/s/${encodeURIComponent(token)}`)
          + (image
            ? meta('property', 'og:image', image)
              + meta('property', 'og:image:type', 'image/png')
              + meta('property', 'og:image:width', '1200')
              + meta('property', 'og:image:height', '630')
              + meta('property', 'og:image:alt', [hymn, about].filter(Boolean).join(' · '))
              + meta('name', 'twitter:card', 'summary_large_image')
            : ''), { html: true });
      },
    })
    .transform(page);
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-cache');
  return new Response(res.body, { status: got ? 200 : 404, headers });
}

// /s/<token>/preview.png: the link's picture, while the score is shared
async function sharedPreview(env, pathname) {
  const token = decodeURIComponent(pathname.split('/')[2] || '');
  let got = null;
  try { got = await readPreview(env, token); } catch { /* missing reads as not found */ }
  if (!got) return new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(got.png, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' },
  });
}

const escAttr = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
