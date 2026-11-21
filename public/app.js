"use strict";

/* ==========================================================================
   anki-audio frontend — vanilla JS, one plain script, no build step.
   Sections: constants · hashing · IndexedDB · anki api · tts text · tts cache
   · playback · gestures · html rendering · sync · deck list · review loop
   · prefetch & cache management · ratings queue · settings · init
   ========================================================================== */

/* ------------------------------ constants -------------------------------- */

const CAP_BYTES = 1024 ** 3; // 1 GiB LRU cap on per-deck audio
const PHRASE_RATE = "rate card";
const PHRASE_DONE = "deck complete";
const PHRASE_AGAIN = "again"; // spoken in the RATED confirm state
const PHRASE_HARD = "hard";
const PHRASE_GOOD = "good";
const PHRASE_EASY = "easy";
const PHRASE_BY_EASE = { 1: PHRASE_AGAIN, 2: PHRASE_HARD, 3: PHRASE_GOOD, 4: PHRASE_EASY };
const TAP_WINDOW_MS = 300; // single vs double tap discrimination window
const TAP_MAX_MOVE_PX = 12; // pointer drift beyond which a release is not a tap
const LONG_PRESS_MS = 500; // hold time that fires the state's long-press action
const LONG_PRESS_MOVE_PX = 16; // jitter tolerance before a hold breaks
const SWIPE_PX = 56; // device-space travel distance that fires swipe up / down
const SWIPE_CONE_DEG = 60; // acceptance cone around the device up/down axes
const AGAIN_RETURN_MS = 65_000; // "again" cards are due again ~1 min later
const WAIT_POLL_MS = 15_000; // re-check interval while waiting for learning cards
const WAIT_GIVEUP_MS = 15 * 60_000; // give up 15 min after the last again-answer
const PREFETCH_CONCURRENCY = 3;
const CARD_BATCH = 100; // cardsInfo batch size
const FLUSH_INTERVAL_MS = 30_000;

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const cardIdOf = (card) => card.cardId ?? card.id;
const isAbort = (err) => Boolean(err) && err.name === "AbortError";

/* -------------------------------- hashing -------------------------------- */

/** SHA-256 hex of the UTF-8 bytes of a string. */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fixed VITS speaking rate for card audio (>1 = slower, clearer speech — true
// re-synthesis, not playback stretching). The playback-speed chips stack on
// top of this. Salted into every TTS cache key (client AND server derive keys
// identically) so a rate change can never serve stale audio.
const TTS_LENGTH_SCALE = 1.1;

/** TTS cache key — must match the server's derivation byte-for-byte. */
async function ttsCacheKey(text) {
  return sha256Hex(`${TTS_LENGTH_SCALE}\u0000${text}`);
}

/* ------------------------------- IndexedDB -------------------------------- */

let dbPromise = null;

function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("anki-audio", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "hash" });
        if (!db.objectStoreNames.contains("decks")) db.createObjectStore("decks", { keyPath: "name" });
        if (!db.objectStoreNames.contains("ratings")) {
          db.createObjectStore("ratings", { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(store, key) {
  const db = await idb();
  return idbReq(db.transaction(store, "readonly").objectStore(store).get(key));
}

async function idbAll(store) {
  const db = await idb();
  return idbReq(db.transaction(store, "readonly").objectStore(store).getAll());
}

async function idbPut(store, value) {
  const db = await idb();
  return idbReq(db.transaction(store, "readwrite").objectStore(store).put(value));
}

async function idbDel(store, key) {
  const db = await idb();
  return idbReq(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

/** Clear whole object stores in ONE transaction (cache wipe; ratings spared). */
async function idbClear(stores) {
  const db = await idb();
  const tx = db.transaction(stores, "readwrite");
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("clear aborted"));
  });
  for (const name of stores) tx.objectStore(name).clear();
  await done;
}

/* ------------------------------- anki api -------------------------------- */

async function ankiRaw(action, params = {}, signal) {
  const res = await fetch("/api/anki", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }),
    signal,
  });
  if (!res.ok) throw new Error(`anki proxy returned ${res.status}`);
  return res.json();
}

async function anki(action, params = {}, signal) {
  const data = await ankiRaw(action, params, signal);
  if (data.error != null) throw new Error(String(data.error));
  return data.result;
}

async function cardsInfoBatched(ids, signal) {
  const out = [];
  for (let i = 0; i < ids.length; i += CARD_BATCH) {
    const info = await anki("cardsInfo", { cards: ids.slice(i, i + CARD_BATCH) }, signal);
    if (Array.isArray(info)) out.push(...info);
  }
  return out;
}

/* ------------------------------ tts text --------------------------------- */

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

function unescapeHtml(text) {
  return text.replace(
    /&(?:amp|lt|gt|quot|#39|nbsp|#\d+|#x[0-9a-f]+);/gi,
    (entity) => {
      const key = entity.slice(1, -1).toLowerCase();
      if (key in HTML_ENTITIES) return HTML_ENTITIES[key];
      if (key[0] === "#") {
        const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        if (Number.isFinite(code)) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return entity;
          }
        }
      }
      return entity;
    }
  );
}

/**
 * Card HTML → speakable text. Port of Anki-AI's strip_html_lines(): sound
 * tags and <img> go first, then style blocks, <br>/block tags become
 * newlines, remaining tags are stripped, entities unescaped, and the
 * non-empty trimmed lines are joined with single spaces.
 */
function ttsText(html) {
  let text = String(html || "");
  text = text.replace(/\[sound:[^\]]*\]/gi, "");
  text = text.replace(/<img[^>]*>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?(?:div|p|li|tr|h[1-6]|ul|ol|table)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = unescapeHtml(text);
  const lines = text
    .split(/\r\n|[\n\r\v\f\x85\u2028\u2029]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.join(" ");
}

/* ------------------------- number normalization -------------------------- */

// Numbers spelled for speech: 1–3 digits as words (253 → "two hundred and
// fifty-three", British "and"), round magnitudes of 4–10 digits normally
// (1000 → "one thousand", 70000 → "seventy thousand", … 9000000000 →
// "nine billion"), anything else digit-wise (5314 → "five, three, one, four").
// IPv4 addresses read digit-by-digit with "dot"; decimals use "point";
// leading-zero codes stay digit-wise (007 → "zero, zero, seven"); negative
// signs read "minus". Digits glued to letters (IPv4, Day01, v2) and 3+-group
// dotted versions (3.14.15) are left untouched — use a TTS replacement.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0–999 → words (253 → "two hundred and fifty-three"). */
function numberToWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  const rest = n % 100;
  return ONES[Math.floor(n / 100)] + " hundred" + (rest ? " and " + numberToWords(rest) : "");
}

/** Digit string → "five, three, one, four". */
function digitize(digits) {
  return [...digits].map((d) => ONES[Number(d)]).join(", ");
}

/** Integer digit string (separators already stripped) → speech words. */
function integerToSpeech(digits) {
  if (digits.length > 1 && digits[0] === "0") return digitize(digits); // codes: 007 → zero, zero, seven
  if (digits.length <= 3) return numberToWords(Number(digits));
  if (digits.length <= 10 && /^[1-9]0+$/.test(digits)) {
    // round magnitude d×10^k: 1000 → one thousand … 9000000000 → nine billion
    const k = digits.length - 1;
    const group = k <= 5 ? "thousand" : k <= 8 ? "million" : "billion";
    return numberToWords(Number(digits[0]) * 10 ** (k % 3)) + " " + group;
  }
  return digitize(digits); // 5314 → five, three, one, four
}

const NUM_RE =
  /(?<![\w.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?!\.\d|\w)|(?<![\w.])(-?\d[\d,]*(?:\.\d+)?)(?!\.\d|\w)/g;

/** Speak numbers/IPs in plain text per the rules above. */
function normalizeNumbers(text) {
  return text.replace(NUM_RE, (match, ip, num) => {
    if (ip) {
      const octets = ip.split(".");
      if (octets.some((o) => Number(o) > 255)) return match; // not a real IP — leave alone
      return octets.map(digitize).join(", dot, ");
    }
    let m = num;
    let sign = "";
    if (m.startsWith("-")) {
      sign = "minus ";
      m = m.slice(1);
    }
    const dot = m.indexOf(".");
    const intRaw = dot === -1 ? m : m.slice(0, dot);
    const frac = dot === -1 ? "" : m.slice(dot + 1);
    let out = sign + integerToSpeech(intRaw.replaceAll(",", ""));
    if (frac) out += " point " + [...frac].map((d) => ONES[Number(d)]).join(" ");
    return out;
  });
}

/**
 * Standalone all-caps runs → letter-spaced for speech, joined like the
 * digit-wise number output: "OSPF" → "O, S, P, F" ("STP prevents loops" →
 * "S, T, P prevents loops"). Only pure [A-Z]{2,} words match — single
 * capitals ("A", "I") are normal words, and letters glued to digits or dots
 * (IPv4, OSPFv2, U.S.A.) aren't pure runs, so they're left untouched.
 */
function normalizeAcronyms(text) {
  return text.replace(/\b[A-Z]{2,}\b/g, (word) => [...word].join(", "));
}

/**
 * THE single card-TTS choke point: card HTML → the exact string that gets
 * hashed (sha256Hex) and POSTed to /api/tts. Applies the user's TTS
 * replacements (settings section — literal substring, top-to-bottom, trimmed
 * inputs, empty "find" ignored, empty "replace with" deletes), then built-in
 * number normalization (most-specific-wins: replacements run first, so their
 * word-form outputs survive the number pass untouched), then acronym
 * letter-ization (runs after numbers, so a replacement outputting "OSPF" is
 * letter-ized just like a number would be spoken), then collapses whitespace
 * runs and trims. EVERY card-text path — prefetch AND playback — must go
 * through this: diverging strings would silently split the cache. Fixed
 * phrases ("rate card", "deck complete", rating labels) bypass replacements
 * entirely.
 */
function prepareTtsText(html) {
  let text = ttsText(html);
  for (const rule of settings.replacements) {
    const from = String(rule.from ?? "").trim();
    if (!from) continue;
    text = text.replaceAll(from, String(rule.to ?? "").trim());
  }
  text = normalizeNumbers(text);
  text = normalizeAcronyms(text);
  return text.replace(/\s+/g, " ").trim();
}

/* ------------------------------ tts cache -------------------------------- */

const ttsInflight = new Map(); // hash → shared ttsGet promise
const sessionProtected = new Set(); // hashes that must survive orphan sweeps (phrases)

/**
 * hash → IndexedDB blob; on miss POST /api/tts and store. Never throws to
 * callers that don't want it to (playText wraps it) — failures do throw here.
 */
async function ttsGet(text, signal) {
  const hash = await ttsCacheKey(text);
  const cached = await idbGet("audio", hash);
  if (cached && cached.blob) return cached;
  const existing = ttsInflight.get(hash);
  if (existing) return existing;
  const pending = (async () => {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, length_scale: TTS_LENGTH_SCALE }),
      signal,
    });
    if (!res.ok) throw new Error(`tts returned ${res.status}`);
    const blob = await res.blob();
    const dur = Number.parseFloat(res.headers.get("X-Audio-Duration"));
    const record = { hash, blob, bytes: blob.size, dur: Number.isFinite(dur) ? dur : null };
    try {
      await idbPut("audio", record);
    } catch (err) {
      console.warn("tts cache write failed:", err);
    }
    return record;
  })();
  ttsInflight.set(hash, pending);
  try {
    return await pending;
  } finally {
    ttsInflight.delete(hash);
  }
}

async function ttsGetWithRetry(text, signal) {
  try {
    return await ttsGet(text, signal);
  } catch (err) {
    if (isAbort(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (signal && signal.aborted) {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      throw abort;
    }
    return ttsGet(text, signal);
  }
}

/* ------------------------------- playback -------------------------------- */

const audio = new Audio();
let currentObjectUrl = null;
let playSeq = 0; // cancels in-flight plays when it changes

/* Mute: playback-only gate — prefetch/caching keep running underneath. */
let muted = false;

function syncMuteUI() {
  const btn = $("mute-btn");
  if (!btn) return;
  btn.dataset.muted = String(muted); // CSS shows/hides the active icon + red tint
  btn.setAttribute("aria-pressed", String(muted));
  btn.setAttribute("aria-label", muted ? "Unmute TTS" : "Mute TTS");
}

function toggleMute() {
  muted = !muted;
  lsSet("anki-audio-muted", muted ? "1" : "0");
  if (muted) audio.pause(); // silence what's playing right now
  syncMuteUI();
}

function playRecord(record) {
  if (muted) return Promise.resolve(false); // silent — but ttsGet already ran
  if (!record || !record.blob) return Promise.resolve(false);
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(record.blob);
  audio.src = currentObjectUrl;
  applyPlaybackRate(); // speed + pitch normalization, re-applied on every play
  return audio
    .play()
    .then(() => true)
    .catch((err) => {
      console.warn("audio play failed:", err);
      return false;
    });
}

/** Fetch + play one text. Failures warn and resolve — never block the flow. */
async function playText(text) {
  if (!text) return false;
  const seq = ++playSeq;
  try {
    const record = await ttsGet(text);
    if (seq !== playSeq) return false;
    return await playRecord(record);
  } catch (err) {
    console.warn("tts failed:", err && err.message);
    return false;
  }
}

/** Play and resolve when the clip ends (used for "deck complete"). */
async function playTextAndWait(text, timeoutMs = 12_000) {
  if (!text) return false;
  if (muted) return false; // resolves immediately — finishDeck's auto-return still runs
  const seq = ++playSeq;
  try {
    const record = await ttsGet(text);
    if (seq !== playSeq || !record || !record.blob) return false;
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(record.blob);
    audio.src = currentObjectUrl;
    return await new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        resolve(ok);
      };
      const onEnded = () => finish(true);
      const onError = () => {
        console.warn("audio playback error");
        finish(false);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      applyPlaybackRate(); // speed + pitch normalization, re-applied on every play
      audio.play().catch((err) => {
        console.warn("audio play failed:", err);
        finish(false);
      });
    });
  } catch (err) {
    console.warn("tts failed:", err && err.message);
    return false;
  }
}

/** Stop any playback and cancel pending play requests. */
function stopPlayback() {
  playSeq++;
  audio.pause();
}

/* -------------------------------- gestures -------------------------------- */

/** Current screen rotation in degrees (0/90/180/270) — read at swipe time. */
function deviceAngleDeg() {
  const a = screen.orientation ? screen.orientation.angle : NaN;
  if (Number.isFinite(a)) return ((a % 360) + 360) % 360;
  const w = window.orientation; // deprecated fallback — older iOS
  if (Number.isFinite(w)) return ((w % 360) + 360) % 360;
  return 0;
}

const SWIPE_CONE_TAN = Math.tan((SWIPE_CONE_DEG * Math.PI) / 180);

/**
 * Classify a swipe vector (CSS px deltas) → "easy" | "again" | null.
 * Pure — the angle is passed in for testability. The vector is rotated into
 * DEVICE space ([[cos,-sin],[sin,cos]]·(dx,dy)) so gestures keep their meaning
 * under screen rotation: toward the phone's physical top edge = easy, toward
 * the bottom = again, in every orientation. Acceptance cone: within
 * SWIPE_CONE_DEG of those axes (shaky hands while running).
 */
function classifySwipe(dx, dy, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const xd = c * dx - s * dy;
  const yd = s * dx + c * dy;
  if (Math.hypot(xd, yd) < SWIPE_PX) return null;
  if (Math.abs(xd) > Math.abs(yd) * SWIPE_CONE_TAN) return null; // outside the cone
  return yd < 0 ? "easy" : "again";
}

/**
 * One shared binder for the review stage — tap, long press, vertical swipe,
 * and an optional double-tap window:
 *
 * - tap: a quick release (< LONG_PRESS_MS, drift ≤ TAP_MAX_MOVE_PX). With
 *   onDoubleTap given (BACK only), the single tap waits TAP_WINDOW_MS for a
 *   second tap; without it the tap fires instantly on release (FRONT/RATED).
 * - long press: LONG_PRESS_MS held within LONG_PRESS_MOVE_PX jitter → fires
 *   while still held and suppresses this gesture's tap/swipe handling.
 * - swipe: device-space travel crossing SWIPE_PX within SWIPE_CONE_DEG of the
 *   phone's up/down axes (classifySwipe — rotation-independent) fires at the
 *   threshold crossing and cancels tap + long-press.
 *
 * Multi-touch is ignored; native callout/selection chrome is suppressed via
 * CSS (-webkit-touch-callout) + a contextmenu guard. Returns an unbind fn.
 */
function bindGestures(el, handlers) {
  const {
    onTap = null,
    onDoubleTap = null,
    onLongPress = null,
    onSwipeUp = null,
    onSwipeDown = null,
  } = handlers;
  let downId = null;
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  let drift = 0; // largest distance from the pointer-down origin
  let consumed = false; // long press / swipe already fired — no tap after
  let lastTapAt = 0;
  let tapTimer = null;
  let holdTimer = null;
  let activePointers = 0;
  let multiTouch = false;

  const clearTapTimer = () => {
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
  };

  const clearHoldTimer = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const onDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    activePointers++;
    if (activePointers > 1) {
      // Second finger — the gesture is no longer clean.
      multiTouch = true;
      lastTapAt = 0;
      clearTapTimer();
      clearHoldTimer();
      return;
    }
    downId = e.pointerId;
    downAt = Date.now();
    downX = e.clientX;
    downY = e.clientY;
    drift = 0;
    consumed = false;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — move tracking still works */
    }
    if (onLongPress) {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        consumed = true; // suppresses tap + swipe for the rest of this gesture
        clearTapTimer(); // …including a pending single tap from the last one
        onLongPress();
      }, LONG_PRESS_MS);
    }
  };

  const onMove = (e) => {
    if (e.pointerId !== downId || multiTouch || consumed) return;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    const dist = Math.hypot(dx, dy);
    if (dist > drift) drift = dist;
    if (holdTimer && dist > LONG_PRESS_MOVE_PX) clearHoldTimer(); // jitter broke the hold
    if (!onSwipeUp && !onSwipeDown) return;
    const dir = classifySwipe(dx, dy, deviceAngleDeg());
    if (dir) {
      consumed = true;
      clearHoldTimer();
      clearTapTimer(); // swipe cancels tap + long press
      lastTapAt = 0;
      if (dir === "easy") {
        if (onSwipeUp) onSwipeUp();
      } else if (onSwipeDown) {
        onSwipeDown();
      }
    }
  };

  const onUp = (e) => {
    activePointers = Math.max(0, activePointers - 1);
    if (e.pointerId !== downId) {
      if (activePointers === 0) multiTouch = false;
      return;
    }
    downId = null;
    clearHoldTimer();
    if (multiTouch) {
      if (activePointers === 0) multiTouch = false;
      return;
    }
    if (consumed || !onTap) return; // long press / swipe already acted
    drift = Math.max(drift, Math.hypot(e.clientX - downX, e.clientY - downY));
    if (drift > TAP_MAX_MOVE_PX) return; // a drag, not a tap
    if (Date.now() - downAt >= LONG_PRESS_MS) return; // a slow hold, not a quick tap
    if (!onDoubleTap) {
      onTap(); // no double-tap action in this state — act instantly
      return;
    }
    const now = Date.now();
    if (lastTapAt && now - lastTapAt < TAP_WINDOW_MS) {
      clearTapTimer();
      lastTapAt = 0;
      onDoubleTap();
    } else {
      lastTapAt = now;
      tapTimer = setTimeout(() => {
        tapTimer = null;
        lastTapAt = 0;
        onTap();
      }, TAP_WINDOW_MS);
    }
  };

  const onCancel = () => {
    downId = null;
    activePointers = 0;
    multiTouch = false;
    consumed = false;
    lastTapAt = 0;
    clearTapTimer();
    clearHoldTimer();
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);

  return function unbind() {
    clearTapTimer();
    clearHoldTimer();
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
  };
}

let gestureTeardown = null;

function setGestures(unbinders) {
  teardownGestures();
  gestureTeardown = unbinders;
}

function teardownGestures() {
  if (gestureTeardown) {
    for (const unbind of gestureTeardown) unbind();
    gestureTeardown = null;
  }
}

/* ----------------------------- html rendering ----------------------------- */

/** Light display sanitizer: scripts, iframes, on* handlers, javascript: URLs. */
function sanitizeHtml(html) {
  let out = String(html || "");
  out = out.replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, "");
  out = out.replace(/<iframe\b[\s\S]*?(?:<\/iframe\s*>|$)/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(
    /(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]*)/gi,
    '$1="#"'
  );
  return out;
}

function rewriteImages(html) {
  return html.replace(
    /(<img[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, prefix, doubleQuoted, singleQuoted, bare) => {
      const src = doubleQuoted ?? singleQuoted ?? bare ?? "";
      return `${prefix}"/api/media/${encodeURIComponent(src)}"`;
    }
  );
}

/** Sanitize + point images at /api/media — the final display HTML. */
function displayHtml(rawHtml) {
  return rewriteImages(sanitizeHtml(rawHtml));
}

/** The back side of an answer: everything after the <hr> split (or all of it). */
function backPart(card) {
  const answer = String(card.answer || card.question || "");
  const split =
    /<hr[^>]*\bid\s*=\s*["']?answer["']?[^>]*>/i.exec(answer) ||
    /<hr\b[^>]*>/i.exec(answer);
  return split ? answer.slice(split.index + split[0].length) : answer;
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function stageMessage(text) {
  teardownGestures();
  stage.innerHTML = `<div class="waiting">${escapeHtml(text)}</div>`;
}

/* --------------------------------- sync ----------------------------------- */

let syncPending = 0;

function renderSyncChips() {
  $("deck-sync-chip").hidden = syncPending === 0;
  $("review-sync-chip").hidden = syncPending === 0;
}

/** Fire-and-forget AnkiConnect sync; errors are ignored. */
function fireSync() {
  syncPending++;
  renderSyncChips();
  ankiRaw("sync", {})
    .catch((err) => console.warn("sync failed:", err))
    .finally(() => {
      syncPending = Math.max(0, syncPending - 1);
      renderSyncChips();
    });
}

/* ------------------------------- deck list -------------------------------- */

let deckListToken = 0;
let deckIdsByName = null; // full deck name → deck id (from deckNamesAndIds)

function parseNameIdMap(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const name = entry.name ?? entry.deck ?? entry.deckName;
      const id = entry.deck_id ?? entry.deckId ?? entry.id;
      if (name != null && id != null) out[name] = id;
    }
  } else if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number") out[key] = value; // name → id
      else if (typeof value === "string") out[value] = Number(key); // id → name
      else if (value && typeof value === "object" && typeof value.name === "string") {
        out[value.name] = Number(key); // id → {name}
      }
    }
  }
  return out;
}

/**
 * Defensive normalization of a getDeckStats result (array OR object keyed by
 * deck id) to {name: {new_count, learn_count, review_count, total_in_deck}}
 * plus an id index. Returns a resolver: deck name → counts. Row matching uses
 * deck_id first (the live spike: `name` carries only the last "::" segment and
 * can be ambiguous), with exact-name and last-segment fallbacks.
 */
function statsResolver(raw) {
  const byName = {};
  const byId = new Map();
  const items = Array.isArray(raw)
    ? raw.map((entry) => [null, entry])
    : raw && typeof raw === "object"
      ? Object.entries(raw)
      : [];
  for (const [key, entry] of items) {
    if (!entry || typeof entry !== "object") continue;
    const counts = {
      new_count: num(entry.new_count),
      learn_count: num(entry.learn_count),
      review_count: num(entry.review_count),
      total_in_deck: num(entry.total_in_deck),
    };
    if (typeof entry.name === "string") byName[entry.name] = counts;
    let id = entry.deck_id ?? entry.deckId ?? entry.id;
    if (id == null && key != null && key !== "" && Number.isFinite(Number(key))) id = Number(key);
    if (id != null && Number.isFinite(Number(id))) byId.set(Number(id), counts);
  }
  return function resolve(deckName) {
    const id = deckIdsByName && deckIdsByName[deckName] != null ? Number(deckIdsByName[deckName]) : null;
    if (id != null && byId.has(id)) return byId.get(id);
    if (Object.prototype.hasOwnProperty.call(byName, deckName)) return byName[deckName];
    const segment = deckName.split("::").pop();
    return byName[segment] ?? null;
  };
}

function deckRow(name, counts) {
  const segments = name.split("::");
  const row = document.createElement("button");
  row.className = "deck-row";
  row.type = "button";

  const label = document.createElement("span");
  label.className = "deck-name";
  label.textContent = segments.pop();
  label.style.marginLeft = `${segments.length * 18}px`;
  row.appendChild(label);

  const countsEl = document.createElement("span");
  countsEl.className = "deck-counts";
  const fresh = counts ? counts.new_count : 0;
  const learning = counts ? counts.learn_count : 0;
  const review = counts ? counts.review_count : 0;
  for (const [cls, value] of [
    ["dc-new", fresh],
    ["dc-learn", learning],
    ["dc-review", review],
    ["dc-total", fresh + learning + review], // plain sum, not total_in_deck
  ]) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = String(value);
    countsEl.appendChild(span);
  }
  row.appendChild(countsEl);

  row.addEventListener("click", () => void openDeck(name));
  return row;
}

async function loadDeckList() {
  const token = ++deckListToken;
  const listEl = $("deck-list");
  try {
    const names = (await anki("deckNames", {})) || [];
    try {
      deckIdsByName = parseNameIdMap(await anki("deckNamesAndIds", {}));
    } catch (err) {
      console.warn("deckNamesAndIds failed, falling back to name matching:", err);
      deckIdsByName = null;
    }
    const raw = names.length
      ? await anki("getDeckStats", { decks: names })
      : [];
    if (token !== deckListToken) return; // superseded by a newer load
    const resolve = statsResolver(raw);
    listEl.textContent = "";
    if (!names.length) {
      listEl.innerHTML = '<div class="empty">no decks</div>';
      return;
    }
    for (const name of names) listEl.appendChild(deckRow(name, resolve(name)));
  } catch (err) {
    console.warn("deck list failed:", err);
    if (token === deckListToken) listEl.innerHTML = '<div class="empty">couldn\'t load decks — is Anki running?</div>';
  }
}

/* ------------------------------ review loop -------------------------------- */

const review = {
  deck: null,
  token: 0, // invalidated whenever the session changes
  active: false,
  queue: [], // cardsInfo entries awaiting display (queue[0] = current)
  phase: null, // front | back | rated | rating | waiting | done
  pendingEase: null, // chosen in "back" — submitted to Anki only on confirm
  current: null,
  againCards: new Map(), // cardId → returnAt (answerTime + 65s) for ease-1 answers
  waitTimer: null,
  repolling: false,
  prefetch: null, // {controller, deck}
};

const isCurrentSession = (token) => review.active && token === review.token;

/** True while an "again" answer from the last 15 minutes may still come back. */
function waitingForAgainCards() {
  let latestReturnAt = 0;
  for (const returnAt of review.againCards.values()) {
    if (returnAt > latestReturnAt) latestReturnAt = returnAt;
  }
  if (!latestReturnAt) return false;
  return Date.now() - (latestReturnAt - AGAIN_RETURN_MS) < WAIT_GIVEUP_MS;
}

function deckQuery(deck, dueOnly) {
  return `deck:"${deck.replace(/"/g, '\\"')}"${dueOnly ? " is:due" : ""}`;
}

/** Anki's review order: learning → review (incl. early) → new, each by due asc. */
function queueGroup(card) {
  if (card.queue === 1) return 0;
  if (card.queue === 2 || card.queue === 3) return 1;
  return 2;
}

function sortQueue(cards) {
  return cards.slice().sort((a, b) => {
    const ga = queueGroup(a);
    const gb = queueGroup(b);
    if (ga !== gb) return ga - gb;
    return num(a.due) - num(b.due);
  });
}

async function buildQueue(deck) {
  const ids = await anki("findCards", { query: deckQuery(deck, true) });
  const info = await cardsInfoBatched(ids);
  return sortQueue(info.filter((card) => (card.queue ?? 0) >= 0));
}

function setCounts(counts) {
  const el = $("counts");
  if (!counts) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const fresh = counts.new_count;
  const learning = counts.learn_count;
  const reviewCount = counts.review_count;
  $("cnt-new").textContent = String(fresh);
  $("cnt-learn").textContent = String(learning);
  $("cnt-review").textContent = String(reviewCount);
  $("cnt-left").textContent = `${fresh + learning + reviewCount} left`;
}

async function refreshCounts() {
  const deck = review.deck;
  if (!deck) return;
  try {
    const raw = await anki("getDeckStats", { decks: [deck] });
    if (deck !== review.deck) return;
    const counts = statsResolver(raw)(deck);
    if (counts) setCounts(counts);
  } catch (err) {
    console.warn("counts refresh failed:", err);
  }
}

async function openDeck(name) {
  const token = ++review.token;
  review.deck = name;
  review.active = true;
  review.queue = [];
  review.phase = null;
  review.pendingEase = null;
  review.current = null;
  review.againCards.clear();
  clearWaitTimer();
  stopPlayback();
  $("review-view").hidden = false;
  $("deck-view").hidden = true;
  setCounts(null);
  stageMessage("loading…");
  void touchDeck(name); // LRU bookkeeping starts at deck open
  startPrefetch(name); // never blocks review
  try {
    const queue = await buildQueue(name);
    if (!isCurrentSession(token)) return;
    review.queue = queue;
    void refreshCounts();
    advance(token);
  } catch (err) {
    console.warn("open deck failed:", err);
    if (isCurrentSession(token)) stageMessage("couldn't load this deck");
  }
}

function showFront() {
  const card = review.queue[0];
  if (!card) {
    advance(review.token);
    return;
  }
  review.current = card;
  review.phase = "front";
  review.pendingEase = null;
  stage.innerHTML = `<div class="card"><div class="card-inner">${displayHtml(card.question)}</div></div>`;
  const text = prepareTtsText(card.question); // one choke point: hash == sent
  setGestures([
    bindGestures(stage, {
      onTap: () => showBack(), // instant — no double-tap action on the front
      onLongPress: () => void playText(text), // replay front audio
    }),
  ]);
  void playText(text); // chained from the deck-open tap / previous rating
}

/**
 * The rating state — the back stays visible and every gesture rates (tap
 * hard · double good · swipe up easy · swipe down again · hold replays).
 * `replay` is false when re-rating returns here: the "rate card" phrase
 * already plays, the back audio must not.
 */
function showBack(replay = true) {
  const card = review.current;
  if (!card || (review.phase !== "front" && review.phase !== "rated")) return;
  review.phase = "back";
  review.pendingEase = null; // stale pending rating discarded on (re)entry
  const rawBack = backPart(card);
  stage.innerHTML = `<div class="card"><div class="card-inner">${displayHtml(rawBack)}</div></div>`;
  const text = prepareTtsText(rawBack); // one choke point: hash == sent
  setGestures([
    bindGestures(stage, {
      onTap: () => registerRating(2), // hard
      onDoubleTap: () => registerRating(3), // good — TAP_WINDOW_MS window
      onSwipeUp: () => registerRating(4), // easy
      onSwipeDown: () => registerRating(1), // again
      onLongPress: () => void playText(text), // replay back audio
    }),
  ]);
  if (replay) void playText(text);
}

/**
 * PENDING rating: records the ease and enters the RATED confirm state.
 * Nothing is submitted to Anki here — only confirmRating() does that.
 */
function registerRating(ease) {
  if (review.phase !== "back" || !review.current) return;
  review.pendingEase = ease;
  showRated();
}

/** RATED — back + chosen label + hint; speaks the rating label aloud. */
function showRated() {
  const ease = review.pendingEase;
  if (review.phase !== "back" || ease == null) return;
  review.phase = "rated";
  const label = PHRASE_BY_EASE[ease];
  const rawBack = backPart(review.current);
  stage.innerHTML =
    `<div class="card"><div class="card-inner">${displayHtml(rawBack)}</div></div>` +
    `<div class="rated"><div class="rated-label">${escapeHtml(label)}</div>` +
    `<div class="rated-hint">tap: next card · hold: re-rate</div></div>`;
  setGestures([
    bindGestures(stage, {
      onTap: () => void confirmRating(), // CONFIRM — submit the pending rating
      onLongPress: () => {
        // RE-RATE — same card again; the pending rating is overwritten
        void playText(PHRASE_RATE);
        showBack(false);
      },
    }),
  ]);
  void playText(label); // rating label via the fixed-phrase mechanism
}

/**
 * CONFIRM — the ONLY path that submits a rating to Anki; the card is
 * answerCards'd exactly once. The phase flips to "rating" and the gestures
 * tear down before any await, so a second confirm can never start. Closing
 * the app before confirm submits nothing and the card stays due (intended,
 * safe). Mechanics below are the original rate-card path: offline ratings
 * queue first, then counts refresh + advance (repoll / waiting / finishDeck
 * all unchanged).
 */
async function confirmRating() {
  if (review.phase !== "rated") return;
  const card = review.current;
  const ease = review.pendingEase;
  if (!card || ease == null) return;
  review.phase = "rating"; // transient submit guard
  review.pendingEase = null;
  teardownGestures(); // no double submissions
  const id = cardIdOf(card);
  if (ease === 1) review.againCards.set(id, Date.now() + AGAIN_RETURN_MS);
  else review.againCards.delete(id); // no longer coming back as an "again" card
  await queueRating(id, ease); // local queue first, flush kicked off
  if (!isCurrentSession(review.token)) return;
  review.queue.shift();
  void refreshCounts(); // live counts after every rating
  advance(review.token);
}

function advance(token) {
  if (!isCurrentSession(token)) return;
  if (review.queue.length > 0) {
    showFront();
    return;
  }
  void repoll(token);
}

/**
 * Queue empty → re-run findCards is:due. New ids (not already queued) append
 * and review continues; otherwise wait for learning cards if an "again" was
 * answered within the last 15 min, else the deck is done.
 */
async function repoll(token) {
  if (!isCurrentSession(token) || review.repolling) return;
  review.repolling = true;
  try {
    const ids = await anki("findCards", { query: deckQuery(review.deck, true) });
    if (!isCurrentSession(token)) return;
    const queued = new Set(review.queue.map(cardIdOf));
    const fresh = ids.filter((id) => !queued.has(id));
    let cards = fresh.length ? await cardsInfoBatched(fresh) : [];
    cards = cards.filter((card) => (card.queue ?? 0) >= 0);
    if (!isCurrentSession(token)) return;
    if (cards.length) {
      review.queue.push(...sortQueue(cards));
      showFront();
      return;
    }
  } catch (err) {
    console.warn("queue re-poll failed:", err);
    if (isCurrentSession(token)) {
      if (waitingForAgainCards()) enterWaiting(token);
      else stageMessage("couldn't reach Anki");
    }
    return;
  } finally {
    review.repolling = false;
  }
  if (waitingForAgainCards()) enterWaiting(token);
  else finishDeck(token);
}

function clearWaitTimer() {
  if (review.waitTimer) {
    clearTimeout(review.waitTimer);
    review.waitTimer = null;
  }
}

function enterWaiting(token) {
  if (!isCurrentSession(token)) return;
  review.phase = "waiting";
  teardownGestures();
  stage.innerHTML = '<div class="waiting">waiting for learning cards…</div>';
  clearWaitTimer();
  review.waitTimer = setTimeout(() => {
    review.waitTimer = null;
    void repoll(token);
  }, WAIT_POLL_MS);
}

async function finishDeck(token) {
  if (!isCurrentSession(token) || review.phase === "done") return;
  review.phase = "done";
  teardownGestures();
  clearWaitTimer();
  stage.innerHTML = '<div class="waiting">deck complete</div>';
  await playTextAndWait(PHRASE_DONE);
  if (!isCurrentSession(token)) return;
  leaveReview();
}

function leaveReview() {
  if (!review.active) return;
  review.active = false;
  review.token++;
  review.phase = null;
  review.queue = [];
  review.pendingEase = null;
  review.current = null;
  review.deck = null;
  clearWaitTimer();
  cancelPrefetch();
  teardownGestures();
  stopPlayback();
  $("counts").hidden = true;
  $("review-view").hidden = true;
  $("deck-view").hidden = false;
  fireSync(); // leaving review (back button or deck complete)
  void loadDeckList(); // refresh counts
}

/* ------------------------- prefetch & cache management -------------------- */

function showCaching(done, total) {
  const chip = $("caching-chip");
  chip.textContent = `caching ${done}/${total}`;
  chip.hidden = false;
}

function hideCachingChip() {
  $("caching-chip").hidden = true;
}

function startPrefetch(deck) {
  cancelPrefetch();
  const controller = new AbortController();
  const state = { controller, deck };
  review.prefetch = state;
  runPrefetch(deck, controller.signal)
    .catch((err) => {
      if (!isAbort(err)) console.warn("prefetch failed:", err);
    })
    .finally(() => {
      if (review.prefetch === state) review.prefetch = null;
      hideCachingChip();
    });
}

function cancelPrefetch() {
  if (review.prefetch) {
    review.prefetch.controller.abort();
    review.prefetch = null;
  }
  hideCachingChip();
}

async function touchDeck(name) {
  try {
    const existing = await idbGet("decks", name);
    await idbPut("decks", {
      name,
      manifest: existing ? existing.manifest : {},
      bytes: existing ? existing.bytes : 0,
      lastUsed: Date.now(),
    });
  } catch (err) {
    console.warn("deck touch failed:", err);
  }
}

function manifestBytes(manifest, bytesByHash) {
  return Object.keys(manifest || {}).reduce((sum, hash) => sum + (bytesByHash.get(hash) || 0), 0);
}

async function allDeckRecords() {
  try {
    return await idbAll("decks");
  } catch {
    return [];
  }
}

/** Delete audio blobs no deck manifest references (phrases are protected). */
async function dropUnreferenced(hashes) {
  if (!hashes.length) return;
  try {
    const referenced = new Set();
    for (const deck of await allDeckRecords()) {
      for (const hash of Object.keys(deck.manifest || {})) referenced.add(hash);
    }
    for (const hash of hashes) {
      if (referenced.has(hash) || sessionProtected.has(hash)) continue;
      await idbDel("audio", hash);
    }
  } catch (err) {
    console.warn("orphan cleanup failed:", err);
  }
}

/** LRU-evict whole decks until referenced audio fits the 1 GiB cap. */
async function enforceCap() {
  try {
    const decks = await allDeckRecords();
    const audioRows = await idbAll("audio");
    const bytesByHash = new Map(audioRows.map((row) => [row.hash, num(row.bytes)]));
    let total = decks.reduce((sum, deck) => sum + manifestBytes(deck.manifest, bytesByHash), 0);
    if (total <= CAP_BYTES) return;
    const lru = decks.slice().sort((a, b) => num(a.lastUsed) - num(b.lastUsed));
    for (const deck of lru) {
      if (total <= CAP_BYTES) break;
      if (deck.name === review.deck) continue; // never evict the open deck
      total -= manifestBytes(deck.manifest, bytesByHash);
      await idbDel("decks", deck.name);
    }
    // Now sweep blobs that no surviving manifest references.
    const referenced = new Set();
    for (const deck of await allDeckRecords()) {
      for (const hash of Object.keys(deck.manifest || {})) referenced.add(hash);
    }
    for (const row of audioRows) {
      if (referenced.has(row.hash) || sessionProtected.has(row.hash)) continue;
      await idbDel("audio", row.hash);
    }
  } catch (err) {
    console.warn("cache cap enforcement failed:", err);
  }
}

/**
 * Background prefetch on deck open: fetch ALL cards of the deck, extract both
 * sides' texts, diff against the deck manifest (regenerate only missing hashes,
 * drop entries no longer present), synthesize with concurrency 3 and a
 * progress chip, then enforce the LRU cap. Aborted when the deck is left.
 */
async function runPrefetch(deck, signal) {
  const ids = await anki("findCards", { query: deckQuery(deck, false) }, signal);
  const all = await cardsInfoBatched(ids, signal);
  if (signal.aborted) return;

  // Build manifest {hash: {ids, sides}} + unique texts for both sides.
  const manifest = {};
  const textByHash = new Map();
  for (const card of all) {
    const cardId = cardIdOf(card);
    if (cardId == null || (card.queue ?? 0) < 0) continue;
    for (const side of ["front", "back"]) {
      const text =
        side === "front" ? prepareTtsText(card.question) : prepareTtsText(backPart(card));
      if (!text) continue;
      const hash = await ttsCacheKey(text);
      const entry = manifest[hash] || (manifest[hash] = { ids: [], sides: [] });
      if (!entry.ids.includes(cardId)) entry.ids.push(cardId);
      entry.sides.push(side);
      textByHash.set(hash, text);
    }
  }
  if (signal.aborted) return;

  const previous = await idbGet("decks", deck);
  const oldManifest = (previous && previous.manifest) || {};
  const dropped = Object.keys(oldManifest).filter((hash) => !manifest[hash]);
  const audioRows = await idbAll("audio");
  const bytesByHash = new Map(audioRows.map((row) => [row.hash, num(row.bytes)]));
  await idbPut("decks", {
    name: deck,
    manifest,
    bytes: manifestBytes(manifest, bytesByHash),
    lastUsed: Date.now(),
  });
  if (dropped.length) await dropUnreferenced(dropped); // diff-on-reopen orphans

  // Generate everything not already cached — concurrency 3, with progress.
  const missing = [...textByHash.entries()].filter(([hash]) => !bytesByHash.has(hash));
  if (missing.length) {
    showCaching(0, missing.length);
    let done = 0;
    let next = 0;
    const workers = Array.from({ length: Math.min(PREFETCH_CONCURRENCY, missing.length) }, async () => {
      while (!signal.aborted) {
        const index = next++;
        if (index >= missing.length) break;
        try {
          await ttsGetWithRetry(missing[index][1], signal);
        } catch (err) {
          if (!isAbort(err)) console.warn("prefetch tts failed:", err);
        }
        done++;
        if (!signal.aborted) showCaching(done, missing.length);
      }
    });
    await Promise.all(workers);
    if (signal.aborted) return;
  }

  // Recompute stored bytes now that new blobs exist, then hold the cap.
  try {
    const freshRows = await idbAll("audio");
    const freshBytes = new Map(freshRows.map((row) => [row.hash, num(row.bytes)]));
    const record = await idbGet("decks", deck);
    if (record) await idbPut("decks", { ...record, bytes: manifestBytes(manifest, freshBytes) });
  } catch (err) {
    console.warn("deck bytes update failed:", err);
  }
  await enforceCap();
}

/* ----------------------------- ratings queue ------------------------------ */

/**
 * Ratings go into IndexedDB FIRST, then flush is attempted immediately.
 * Flusher walks entries in order: success or a "can't answer this card"
 * error deletes the entry; network failure keeps it and stops.
 */
async function queueRating(cardId, ease) {
  try {
    await idbPut("ratings", { cardId, ease, ts: Date.now() });
  } catch (err) {
    console.warn("failed to queue rating:", err);
  }
  void flushRatings();
}

let flushing = false;

async function flushRatings() {
  if (flushing) return;
  flushing = true;
  try {
    const entries = (await idbAll("ratings")).slice().sort((a, b) => num(a.id) - num(b.id));
    for (const entry of entries) {
      let data = null;
      try {
        const res = await fetch("/api/anki", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "answerCards",
            version: 6,
            params: { answers: [{ cardId: entry.cardId, ease: entry.ease }] },
          }),
        });
        if (!res.ok) break; // proxy/Anki unreachable → keep entry, stop
        data = await res.json().catch(() => null);
      } catch (err) {
        console.warn("ratings flush network error:", err);
        break;
      }
      if (!data || typeof data !== "object" || !("error" in data || "result" in data)) break; // unrecognized reply
      if (data.error == null) {
        await idbDel("ratings", entry.id);
        continue;
      }
      const message = String(data.error);
      if (/card|not found/i.test(message)) {
        await idbDel("ratings", entry.id); // card can't be answered — drop it
        continue;
      }
      console.warn("ratings flush anki error:", message);
      break; // unknown error → keep the entry and retry later
    }
  } catch (err) {
    console.warn("ratings flush failed:", err);
  } finally {
    flushing = false;
  }
}

/* -------------------------------- settings -------------------------------- */

const SETTINGS_KEYS = {
  theme: "anki-audio-theme",
  speed: "anki-audio-speed",
  replacements: "anki-audio-replacements",
};
const SPEED_CHOICES = [0.5, 0.75, 0.8, 0.9, 1, 1.25, 1.5];
const THEME_META_COLOR = { light: "#f0f0f2", dark: "#17171a" }; // matches --bg
const CLEAR_CONFIRM_MS = 4_000; // armed → idle revert window
const CLEAR_DONE_MS = 2_500; // "cleared" confirmation display
const REPL_SAVE_DEBOUNCE_MS = 300; // replacement-row input persistence

/** Persisted user settings — restored and validated by loadSettings(). */
const settings = { theme: "light", speed: 1, replacements: [] };

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.warn("settings save failed:", err);
  }
}

/** Restore theme / speed / replacements — invalid or missing → light, 1, []. */
function loadSettings() {
  const rawTheme = lsGet(SETTINGS_KEYS.theme);
  const theme = rawTheme === "dark" || rawTheme === "light" ? rawTheme : "light";

  const rawSpeed = Number(lsGet(SETTINGS_KEYS.speed));
  const speed = SPEED_CHOICES.includes(rawSpeed) ? rawSpeed : 1;

  let replacements = [];
  try {
    const parsed = JSON.parse(lsGet(SETTINGS_KEYS.replacements) || "[]");
    if (Array.isArray(parsed)) {
      replacements = parsed
        .filter((rule) => rule && typeof rule === "object")
        .map((rule) => ({ from: String(rule.from ?? ""), to: String(rule.to ?? "") }));
    }
  } catch (err) {
    console.warn("replacements unreadable, starting from []:", err);
  }

  settings.theme = theme;
  settings.speed = speed;
  settings.replacements = replacements;
}

/* --------------------------------- theme ---------------------------------- */

/**
 * Apply + persist the theme. Sets data-theme on <html> (CSS custom-property
 * palette) and keeps the browser chrome <meta name="theme-color"> in sync.
 */
function applyTheme(theme) {
  settings.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = settings.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_META_COLOR[settings.theme]);
  lsSet(SETTINGS_KEYS.theme, settings.theme);
  syncSettingsControls();
}

/* ---------------------------- playback speed ------------------------------ */

/**
 * Rate + pitch normalization on the shared <audio>. Runs at startup and is
 * re-applied defensively on every play path (preservesPitch + webkit/moz
 * fallbacks where the property exists).
 */
function applyPlaybackRate() {
  try {
    audio.preservesPitch = true;
    if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
    if ("mozPreservesPitch" in audio) audio.mozPreservesPitch = true;
    audio.playbackRate = settings.speed; // shared element → applies mid-play too
  } catch (err) {
    console.warn("playback rate apply failed:", err);
  }
}

/** Apply + persist the playback speed. */
function applySpeed(speed) {
  const value = Number(speed);
  settings.speed = SPEED_CHOICES.includes(value) ? value : 1;
  applyPlaybackRate();
  lsSet(SETTINGS_KEYS.speed, String(settings.speed));
  syncSettingsControls();
}

/* --------------------------- tts replacements ----------------------------- */

let replSaveTimer = null;

function saveReplacements() {
  lsSet(SETTINGS_KEYS.replacements, JSON.stringify(settings.replacements));
  markSettingsDirty();
}

function scheduleReplacementSave() {
  if (replSaveTimer) clearTimeout(replSaveTimer);
  replSaveTimer = setTimeout(() => {
    replSaveTimer = null;
    saveReplacements();
  }, REPL_SAVE_DEBOUNCE_MS);
}

/** Persist now (change/blur, view close, page unload) so no edit is lost. */
function flushReplacementSave() {
  if (replSaveTimer) {
    clearTimeout(replSaveTimer);
    replSaveTimer = null;
  }
  saveReplacements();
  if (remoteSaveTimer) {
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = null;
  }
  void saveRemoteSettings(); // immediate + keepalive: survives unload
}

/* ------------------- remote settings (source of truth) ------------------- */

// The server holds one shared settings profile for all devices; localStorage
// is only a mirror. (iOS Safari can refuse localStorage writes entirely, and
// per-device storage loses TTS replacements when switching devices.)
let settingsDirty = false; // a user edit is in flight — don't let adoption clobber it
let remoteSaveTimer = null;

function markSettingsDirty() {
  settingsDirty = true;
  if (remoteSaveTimer) clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(() => {
    remoteSaveTimer = null;
    void saveRemoteSettings();
  }, 400);
}

async function saveRemoteSettings() {
  try {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
      keepalive: true, // survives page unload
    });
  } catch (err) {
    console.warn("settings server save failed:", err);
  }
}

/** Server wins (shared profile). 404 = unseeded → seed it from this device. */
async function loadRemoteSettings() {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (res.status === 404) {
      await saveRemoteSettings(); // first run: local values seed the server
      return;
    }
    if (!res.ok) return;
    const remote = await res.json();
    if (!remote || typeof remote !== "object" || settingsDirty) return;
    settings.theme = remote.theme === "dark" ? "dark" : "light";
    settings.speed = SPEED_CHOICES.includes(Number(remote.speed)) ? Number(remote.speed) : 1;
    settings.replacements = Array.isArray(remote.replacements)
      ? remote.replacements
          .filter((rule) => rule && typeof rule === "object")
          .map((rule) => ({ from: String(rule.from ?? ""), to: String(rule.to ?? "") }))
      : [];
    applyTheme(settings.theme); // apply + mirror locally (no dirty flag set)
    applySpeed(settings.speed);
    lsSet(SETTINGS_KEYS.replacements, JSON.stringify(settings.replacements));
  } catch (err) {
    console.warn("settings server load failed:", err);
  }
}

/* ------------------------- storage / clear cache -------------------------- */

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Approximate cache size = sum of tracked `bytes` in the IDB audio store. */
async function refreshCacheSize() {
  let bytes = 0;
  try {
    const rows = await idbAll("audio");
    bytes = rows.reduce((sum, row) => sum + num(row.bytes), 0);
  } catch (err) {
    console.warn("cache size read failed:", err);
  }
  const el = $("cache-size");
  if (el) el.textContent = formatBytes(bytes);
}

let clearState = "idle"; // idle → armed (4s confirm window) → done → idle
let clearTimer = null;

function setClearState(state) {
  clearState = state;
  const btn = $("clear-cache-btn");
  btn.classList.toggle("confirm", state === "armed");
  btn.classList.toggle("done", state === "done");
  btn.textContent =
    state === "armed"
      ? "Tap again to confirm"
      : state === "done"
        ? "Cleared ✓"
        : "Clear audio cache";
}

function onClearCacheClick() {
  if (clearState === "idle") {
    setClearState("armed");
    clearTimer = setTimeout(() => {
      clearTimer = null;
      setClearState("idle");
    }, CLEAR_CONFIRM_MS);
    return;
  }
  if (clearState === "armed") void clearAudioCache();
  // "done" — ignore taps while the confirmation shows
}

async function clearAudioCache() {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  const btn = $("clear-cache-btn");
  btn.disabled = true;
  try {
    // audio + decks ONLY — the ratings queue (unsynced answers) is sacred.
    await idbClear(["audio", "decks"]);
    setClearState("done");
    await refreshCacheSize();
    clearTimer = setTimeout(() => {
      clearTimer = null;
      setClearState("idle");
    }, CLEAR_DONE_MS);
  } catch (err) {
    console.warn("cache clear failed:", err);
    setClearState("idle");
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------ settings view ----------------------------- */

function syncSettingsControls() {
  for (const btn of document.querySelectorAll("[data-theme-choice]")) {
    const active = btn.dataset.themeChoice === settings.theme;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  for (const btn of document.querySelectorAll("[data-speed]")) {
    const active = Number(btn.dataset.speed) === settings.speed;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

function renderReplacementRows() {
  const list = $("repl-rows");
  list.textContent = "";
  settings.replacements.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "replace-row";

    const find = document.createElement("input");
    find.className = "replace-input";
    find.type = "text";
    find.placeholder = "text to replace";
    find.setAttribute("aria-label", "text to replace");
    find.value = String(rule.from ?? "");
    find.addEventListener("input", () => {
      settings.replacements[index].from = find.value;
      scheduleReplacementSave();
    });
    find.addEventListener("change", flushReplacementSave);

    const repl = document.createElement("input");
    repl.className = "replace-input";
    repl.type = "text";
    repl.placeholder = "replace with";
    repl.setAttribute("aria-label", "replace with");
    repl.value = String(rule.to ?? "");
    repl.addEventListener("input", () => {
      settings.replacements[index].to = repl.value;
      scheduleReplacementSave();
    });
    repl.addEventListener("change", flushReplacementSave);

    const remove = document.createElement("button");
    remove.className = "replace-remove";
    remove.type = "button";
    remove.setAttribute("aria-label", "remove row");
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      flushReplacementSave();
      settings.replacements.splice(index, 1);
      saveReplacements();
      renderReplacementRows();
    });

    row.append(find, repl, remove);
    list.appendChild(row);
  });
}

function addReplacementRow() {
  flushReplacementSave();
  settings.replacements.push({ from: "", to: "" });
  saveReplacements();
  renderReplacementRows();
  const last = $("repl-rows").lastElementChild;
  if (last) {
    const find = last.querySelector("input");
    if (find) find.focus();
  }
}

function openSettings() {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  setClearState("idle");
  syncSettingsControls();
  renderReplacementRows();
  $("deck-view").hidden = true;
  $("settings-view").hidden = false;
  void refreshCacheSize();
}

function closeSettings() {
  flushReplacementSave();
  $("settings-view").hidden = true;
  $("deck-view").hidden = false;
}

function initSettings() {
  loadSettings();
  applyTheme(settings.theme);
  applySpeed(settings.speed); // also arms pitch normalization at startup
  $("settings-btn").addEventListener("click", openSettings);
  $("settings-back-btn").addEventListener("click", closeSettings);
  for (const btn of document.querySelectorAll("[data-theme-choice]")) {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.themeChoice);
      markSettingsDirty();
    });
  }
  for (const btn of document.querySelectorAll("[data-speed]")) {
    btn.addEventListener("click", () => {
      applySpeed(btn.dataset.speed);
      markSettingsDirty();
    });
  }
  $("clear-cache-btn").addEventListener("click", onClearCacheClick);
  $("mute-btn").addEventListener("click", toggleMute);
  muted = lsGet("anki-audio-muted") === "1"; // local-only preference (device-scoped)
  syncMuteUI();
  $("repl-add").addEventListener("click", addReplacementRow);
  window.addEventListener("beforeunload", flushReplacementSave);
  window.addEventListener("online", () => void saveRemoteSettings()); // queued while offline
  void loadRemoteSettings(); // adopt the shared profile (or seed it on first run)
}

/* --------------------------------- init ----------------------------------- */

function init() {
  // iOS zoom guard: Safari pinch zoom fires vendor-only gesture* events
  // (touch-action: manipulation covers double-tap; this covers pinch).
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  // Suppress the native long-press callout/selection menu — the review stage
  // owns every hold gesture (-webkit-touch-callout covers the WebKit side).
  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  initSettings(); // restore theme/speed/replacements + wire the settings view
  $("back-btn").addEventListener("click", leaveReview);
  window.addEventListener("online", () => void flushRatings());
  setInterval(() => void flushRatings(), FLUSH_INTERVAL_MS);
  void flushRatings(); // flush anything queued before a reload
  fireSync(); // sync on app load
  void loadDeckList();
  // Warm the fixed phrases through the normal cache pipeline.
  for (const phrase of [PHRASE_RATE, PHRASE_DONE, PHRASE_AGAIN, PHRASE_HARD, PHRASE_GOOD, PHRASE_EASY]) {
    void ttsGet(phrase)
      .then((record) => sessionProtected.add(record.hash))
      .catch((err) => console.warn("phrase tts failed:", err));
  }
  void enforceCap();
}

init();
