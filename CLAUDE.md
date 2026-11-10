# CLAUDE.md — Gorgon

Byzantine chant notation writer. Live at `gorgon.orthodoxy.au`.

## Stack

- Vanilla JS, no build step, no framework
- Express server (serves static + SBMuFL API)
- Neanes font (WOFF2, GPL-3.0, SBMuFL PUA-mapped glyphs)
- 375 glyphs from SBMuFL spec (`data/sbmufl/`)
- Cloudflare Worker with static assets (`worker.js` + `wrangler.jsonc`): `public/` served as assets, `/api/*` and `/health` from bundled `data/` JSON. Deploy: `npm run cf:deploy`
- Legacy: Docker on hades (`server.js`), Caddy reverse proxy. Keep `server.js` and `worker.js` API routes in sync

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express server, health endpoint, SBMuFL API (Docker) |
| `worker.js` | Cloudflare Worker: same API, static assets via `ASSETS` |
| `wrangler.jsonc` | Worker config |
| `public/app.js` | Editor logic: data model, palette, renderer, compose pad, events |
| `public/gestures.js` | Compose-pad gesture recogniser (tap, vertical detent steps, horizontal swipe, long press) |
| `public/app.css` | Styles (dark UI, paper-like score, print CSS) |
| `public/index.html` | App shell |
| `public/fonts/Neanes.woff2` | Byzantine neume font |
| `data/sbmufl/*.json` | Glyph catalog (glyphnames, ranges, classes) |

## Architecture

- Score = array of elements (neume, martyria, linebreak, spacer)
- Each neume references an SBMuFL glyph name + codepoint
- Rendering: font glyphs in PUA range via `font-family: 'Neanes'`
- Palette organised by SBMuFL ranges (13 categories → 6 tabs)
- Compose pad (thumb zone): focus is a symbol or an empty slot. On the empty slot, swipe up/down inserts Ison then climbs/descends the interval ladder (`neume-values.json`); tap repeats the previous note. On a symbol, swipe up/down steps its value. Swipe right commits and moves on; swipe left goes back
- Palette is hidden behind the Signs button; supporting neumes (gorgon, klasma) attach to the focused base neume
- Auto-save to localStorage every 5s

## License

GPL-3.0 (compatible with Neanes ecosystem)

## Project Docs

Feasibility, proposition, and ecosystem analysis at `/home/ubuntu/byzantine-chant-writer/`
