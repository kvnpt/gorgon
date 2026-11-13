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
import { handleAccount, handleLogin, handleShared, readShared } from './lib/documents.js';

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

    // Shared scores: public, read only (lib/documents.js)
    if (pathname.startsWith('/api/shared/')) return handleShared(request, env, pathname);
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

// /s/<token>: the app shell, which opens read only on a shared path
// (app.js). The score's title goes into the page's title and link preview,
// so a link pasted into a chat reads as the hymn rather than as the app.
async function sharedPage(request, env, pathname) {
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
  const token = decodeURIComponent(pathname.slice(3).replace(/\/$/, ''));
  let got = null;
  try { got = await readShared(env, token); } catch { /* the page shows the error itself */ }
  const title = got?.title ? `${got.title} · Gorgon` : 'Gorgon — Byzantine chant';
  const desc = 'Byzantine chant, to read and chant from. Make a copy to edit your own.';
  const meta = (attr, key, val) => `<meta ${attr}="${key}" content="${escAttr(val)}">`;
  const res = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('head', {
      element(el) {
        el.append(meta('name', 'description', desc)
          + meta('property', 'og:title', got?.title || 'Gorgon')
          + meta('property', 'og:description', desc)
          + meta('property', 'og:site_name', 'Gorgon')
          + meta('property', 'og:type', 'article'), { html: true });
      },
    })
    .transform(page);
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-cache');
  return new Response(res.body, { status: got ? 200 : 404, headers });
}

const escAttr = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
