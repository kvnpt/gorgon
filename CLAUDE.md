# CLAUDE.md — Gorgon

Byzantine chant notation writer. Live at `gorgon.orthodoxy.au`.

## Stack

- Vanilla JS, no build step, no framework
- Express server (serves static + SBMuFL API)
- Neanes font (WOFF2, GPL-3.0, SBMuFL PUA-mapped glyphs)
- 375 glyphs from SBMuFL spec (`data/sbmufl/`)
- Cloudflare Worker with static assets (`worker.js` + `wrangler.jsonc`): `public/` served as assets, `/api/*` and `/health` from bundled `data/` JSON. Deploys automatically on push to `main` (`.github/workflows/deploy.yml`, needs repo secret `CLOUDFLARE_API_TOKEN`); manual: `npm run cf:deploy`
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
- Compose pad (thumb zone): focus is a symbol or an empty slot. One vertical swipe = exactly one increment (no dial). On the empty slot, the first swipe inserts Ison; tap repeats the previous note. On a note, swipe up/down steps its interval (`neume-values.json`). Tap on a symbol or swipe right commits and moves on; swipe left goes back
- Martyria mode (pad's bottom-left toggle): the empty slot inserts martyriae instead, and swipes on a martyria cycle its options: the reached pitch (auto) first, then the mode's base notes from `mode-keys.json`, then the rest by distance. A martyria renders as note letter + zero-width root sign (`martyria-rules.json` via `computeMartyria`); an explicit one (`auto:false, noteValue`) sets the pitch
- Palette is hidden behind the Signs button; supporting neumes (gorgon, klasma) attach to the focused base neume
- Auto-save to localStorage every 5s

## License

GPL-3.0 (compatible with Neanes ecosystem)

## Project Docs

Feasibility, proposition, and ecosystem analysis at `/home/ubuntu/byzantine-chant-writer/`
