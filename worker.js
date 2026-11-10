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
