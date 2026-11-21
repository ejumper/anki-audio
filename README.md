# anki-audio

Audio-first Anki review in a browser: pick a deck, listen to each card read aloud
(TTS via piper), and rate it with taps — no keyboard needed. Vanilla-JS frontend,
tiny Node backend, **zero npm dependencies** (Node 22 stdlib + global `fetch` only).

Flow: deck list (Anki-style counts) → open deck → **front** (auto-read, double-tap
replays) → tap → **back** (auto-read, double-tap replays) → tap → *"rate card"* and
the screen splits: **top = right** (tap good / double easy), **bottom = wrong**
(tap hard / double again). When nothing is due anymore it says *"deck complete"*
and returns to the deck list.

- Card audio is cached client-side (IndexedDB, keyed `sha256(text)`, per-deck
  manifests, 1 GiB LRU cap) and server-side (`<cache dir>/<sha256>.mp3` + sidecar).
- Ratings are queued offline (IndexedDB) and flushed to Anki via `answerCards`.
- `sync` fires on app load and whenever you leave a review.
- Prefetch on deck open generates all of the deck's audio in the background
  (`caching n/m` chip) without blocking review.

## API

All Anki traffic goes through the server (AnkiConnect stays private).

| Route | Shape |
|---|---|
| `POST /api/anki` | Body `{action, version, params}` → forwarded to `ANKI_URL` as-is (adds `key` when `ANKI_CONNECT_KEY` is set). Upstream JSON + status returned verbatim. 30 s timeout. |
| `POST /api/tts` | Body `{input}`. Cache hit → mp3 with `X-Cache: hit`, `X-Audio-Key`, `X-Audio-Duration` (when known). Miss → primary then fallback piper (`POST …/v1/audio/speech`, `{"input","response_format":"mp3"}`, 30 s each); a backend answering 400 `"input too long"` is re-queried through its chunk API (`chunk_from`/`chunk_to`, ≤16 chunks per request) and reassembled with `X-Chunk-Total` / `X-Chunk-Lengths` / `X-Chunk-Durations`. Success → `X-Cache: miss`, `X-Audio-Key`, `X-Tts-Backend`, `X-Audio-Duration`. Empty input → `400 {"error":"empty input"}`; both tiers down → `502 {"error":"tts unavailable"}`. Concurrent identical inputs are deduped in-flight. Cache key = SHA-256 hex of the UTF-8 bytes of `input`, computed with `node:crypto` (client side: `crypto.subtle` over the same string — hashes match). |
| `GET /api/media/<filename>` | `retrieveMediaFile` via AnkiConnect → decoded base64 bytes, guessed content type, `Cache-Control: public, max-age=31536000, immutable`. Null result → 404. |
| `GET /api/health` | `{anki, primary, fallback}` booleans (2.5 s probes; tier health = `<tts url with /v1/audio/speech → /health>`). |

Static files are served from `public/`.

## Configuration (env)

| Var | Default |
|---|---|
| `PORT` | `8080` |
| `ANKI_URL` | `http://anki:8765` |
| `ANKI_CONNECT_KEY` | *(unset — `key` only added when set)* |
| `TTS_PRIMARY` | `http://100.75.135.87/piper/v1/audio/speech` |
| `TTS_FALLBACK` | `http://100.93.215.27:8900/v1/audio/speech` |
| `TTS_CACHE_DIR` | `/data/tts-cache` |

## Run locally

```sh
node server.js          # or: npm start  (no install step — no dependencies)
```

Then open `http://localhost:8080`. To point at a local Anki:
`ANKI_URL=http://127.0.0.1:8765 TTS_CACHE_DIR=./tts-cache node server.js`.

## Deploy

```sh
./deploy.sh
```

rsyncs the repo to `ejumps@100.93.215.27:/opt/anki/app/` (excluding `.git`) and runs
`docker compose up -d --build web` in `/opt/anki`. The container is `node:22-alpine`,
runs as root so it can write the `/data/tts-cache` bind mount.

## Verification checklist

```sh
node --check server.js                      # syntax
curl -s localhost:8080/api/health           # {"anki":true,"primary":true,"fallback":true}
curl -s -X POST localhost:8080/api/anki -H 'content-type: application/json' \
     -d '{"action":"deckNames","version":6,"params":{}}'          # deck list
curl -sD - -X POST localhost:8080/api/tts -H 'content-type: application/json' \
     -d '{"input":"hello"}' -o t.mp3        # first: X-Cache: miss
#   repeat → X-Cache: hit, byte-identical file; sha256("hello") == X-Audio-Key
curl -sD - "localhost:8080/api/media/<known image>" -o m.img      # image bytes, immutable cache
```

Browser walk-through: deck rows render counts (new/learn/review/total); opening a
deck starts review immediately plus the `caching n/m` chip; the first front plays
from the tap; tap → back, tap → *"rate card"*, split rates map
tap/double → good/easy (top) and hard/again (bottom); ratings land in Anki
(`answerCards`); an *again* card returns ~1 min later (or via the quiet
"waiting for learning cards…" state); *"deck complete"* auto-returns to the deck list.
