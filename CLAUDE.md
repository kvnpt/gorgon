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
| `public/account.js` | Sign-in (Cloudflare Access) and saving scores to the account; Scores sheet |
| `lib/access.js`, `lib/documents.js` | Worker: Access JWT check, `/admin` (sign-in), `/api/admin/documents` on D1 |
| `public/lyrics.js` | Lyric mode: syllabify (Greek rules, English Hypher), text ↔ per-note lyrics |
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
- Compose pad (thumb zone): focus is a symbol or an empty slot. One vertical swipe = exactly one increment (no dial). Moving into a blank spot (committing the last symbol, tapping a gap, loading) puts a pending Ison there (`placeholderEl`: dimmed, not saved, not printed, dropped if you leave backwards; it becomes real once changed or committed). In martyria mode the pending symbol is the first martyria option. Del on it acts as backspace. On a note, swipe up/down steps its interval (`neume-values.json`). Tap on a symbol or swipe right commits and moves on; swipe left goes back
- Pad modes (corner toggles, one at a time; `padMode`): Quant. top-left (default: swipes step the interval), Qual. top-right (swipes cycle the note's quality sign `vocalExpression`: none, psifiston, vareia, omalon, antikenoma, heteron, endofonon, filtered by `qualityAllowed` from `neume-combinations.json`), Mart. bottom-left. Quality signs draw inline with the neume (`neumeRun`): vareia before it, the zero-width marks after it
- Martyria mode (pad's bottom-left toggle): the empty slot inserts martyriae instead, and swipes on a martyria cycle its options: the reached pitch (auto) first, then the mode's base notes from `mode-keys.json`, then the rest by distance. A martyria renders as note letter + zero-width root sign (`martyria-rules.json` via `computeMartyria`); an explicit one (`auto:false, noteValue`) sets the pitch
- Palette is hidden behind the Signs button; supporting neumes (gorgon, klasma) attach to the focused base neume
- Lyric mode (`public/lyrics.js`; Lyric button, Enter, or tapping a note's syllable): one text field, kept outside the re-rendered score so the phone keyboard stays up, holds the words from a start note on; every change re-lays them one syllable per note. Space = next word/note, `-` hand break (a word with any `-` is split only there; big hyphen button), `_` holds a syllable over one more note (Hold button; shown as `-` inside a word, extender line after one), `~` joins words on one note. Auto-split: Greek by grammar rules (diphthongs, word-initial clusters), English via Hypher + TeX en-US patterns (`public/vendor/`) with a vowel-group fallback and a church-word exception list. A note's lyric stays a string (`Ky-`, `-`, `_`); `buildLyricText` rebuilds the text from them
- Auto-save to localStorage every 5s (`gorgon-score-v2`). Each score has `metadata.id`
- Accounts (optional): Gorgon shares agora's Cloudflare Access application (team `agora-admin.cloudflareaccess.com`), which already covers `/admin` and `/api/admin/*` on every *.orthodoxy.au host, so one login works across the domain's tools. Sign in is `/admin?back=<path>`, and the account API lives under `/api/admin/` for that reason. `ACCESS_AUD` (that app's audience tag) is in `wrangler.jsonc` vars; empty = sign-in hidden. Signed in, the open score is also PUT to D1 (`gorgon` database, one row per email + doc id) every 5s when changed. Signing in never replaces anything: the visitor's score joins the account as its own document. A write based on an older version gets 409 and the browser keeps its version as a separate copy

## License

GPL-3.0 (compatible with Neanes ecosystem)

## Project Docs

Feasibility, proposition, and ecosystem analysis at `/home/ubuntu/byzantine-chant-writer/`
