"use strict";

/**
 * anki-audio server — Node 22, zero npm dependencies.
 * Modules used: node:http, node:crypto, node:fs, node:path + global fetch.
 *
 * API:
 *   POST /api/anki            AnkiConnect passthrough ({action, version, params})
 *   POST /api/tts             piper TTS: sha256 disk cache + primary/fallback failover
 *   GET  /api/media/<file>    Anki media file via retrieveMediaFile (base64 → bytes)
 *   GET  /api/health          {anki, primary, fallback}
 * Plus static files from public/.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");

/* ------------------------------- config -------------------------------- */

const PORT = Number(process.env.PORT) || 8080;
const ANKI_URL = process.env.ANKI_URL || "http://anki:8765";
const ANKI_CONNECT_KEY = process.env.ANKI_CONNECT_KEY;
const TTS_PRIMARY = process.env.TTS_PRIMARY || "http://100.75.135.87/piper/v1/audio/speech";
const TTS_FALLBACK = process.env.TTS_FALLBACK || "http://100.93.215.27:8900/v1/audio/speech";
const TTS_CACHE_DIR = process.env.TTS_CACHE_DIR || "/data/tts-cache";
const SETTINGS_PATH = process.env.SETTINGS_PATH || "/data/app/settings.json";

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ANKI_TIMEOUT_MS = 30_000;
const TTS_ATTEMPT_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_500;
const CHUNK_WINDOW = 16; // max chunks per chunk_from/chunk_to request

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const MEDIA_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  css: "text/css",
  html: "text/html; charset=utf-8",
};

try {
  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
} catch (err) {
  console.warn(`[tts] cannot create cache dir ${TTS_CACHE_DIR}: ${err.message}`);
}

/* ------------------------------ helpers -------------------------------- */

function sendJson(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function mediaType(filename) {
  const ext = path.extname(filename).toLowerCase().slice(1);
  return MEDIA_TYPES[ext] || "application/octet-stream";
}

function parseDuration(headerValue) {
  const n = Number.parseFloat(headerValue);
  return Number.isFinite(n) ? n : null;
}

/* --------------------------- anki forwarding ---------------------------- */

/**
 * POST one AnkiConnect request body to ANKI_URL (adding the configured key),
 * returning the upstream status + raw body text. Shared by /api/anki,
 * /api/media and the health probe.
 */
async function ankiFetch(body, timeoutMs = ANKI_TIMEOUT_MS) {
  const payload = { ...body };
  if (ANKI_CONNECT_KEY) payload.key = ANKI_CONNECT_KEY;
  const res = await fetch(ANKI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text() };
}

async function handleAnki(req, res) {
  const raw = (await readBody(req)).toString("utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return sendJson(res, 400, { error: "invalid request" });
  }
  if (ANKI_CONNECT_KEY) payload.key = ANKI_CONNECT_KEY;
  let upstream;
  try {
    upstream = await fetch(ANKI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ANKI_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[anki] upstream failed: ${err.message}`);
    return sendJson(res, 502, { error: "anki unavailable" });
  }
  const text = await upstream.text();
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json",
  });
  res.end(text);
}

async function handleMedia(res, rawFilename) {
  let filename;
  try {
    filename = decodeURIComponent(rawFilename);
  } catch {
    return sendJson(res, 400, { error: "bad filename" });
  }
  if (!filename || filename.includes("\0")) return sendJson(res, 404, { error: "not found" });

  let upstream;
  try {
    upstream = await ankiFetch({ action: "retrieveMediaFile", version: 6, params: { filename } });
  } catch (err) {
    console.warn(`[media] anki unreachable: ${err.message}`);
    return sendJson(res, 502, { error: "anki unavailable" });
  }
  let data;
  try {
    data = JSON.parse(upstream.text);
  } catch {
    return sendJson(res, 502, { error: "anki unavailable" });
  }
  if (data && data.error != null) {
    return /not found/i.test(String(data.error))
      ? sendJson(res, 404, { error: "not found" })
      : sendJson(res, 502, { error: "anki error" });
  }
  // AnkiConnect returns result: false for missing media (not null) — require a
  // non-empty base64 string instead of merely non-null.
  if (!data || typeof data.result !== "string" || data.result.length === 0) return sendJson(res, 404, { error: "not found" });

  const buf = Buffer.from(String(data.result), "base64");
  res.writeHead(200, {
    "Content-Type": mediaType(filename),
    "Content-Length": buf.length,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(buf);
}

/* -------------------------------- TTS ----------------------------------- */

const inflightTts = new Map(); // cache key → shared generation promise

/** Disk cache lookup: <key>.mp3 + sidecar <key>.json {dur, backend}. */
async function readCache(key) {
  try {
    const buf = await fsp.readFile(path.join(TTS_CACHE_DIR, `${key}.mp3`));
    let meta = null;
    try {
      meta = JSON.parse(await fsp.readFile(path.join(TTS_CACHE_DIR, `${key}.json`), "utf8"));
    } catch {
      /* sidecar missing/corrupt → serve audio without duration */
    }
    return { buf, dur: meta && Number.isFinite(Number(meta.dur)) ? Number(meta.dur) : null };
  } catch {
    return null;
  }
}

async function writeCache(key, buf, dur, backend) {
  try {
    await fsp.mkdir(TTS_CACHE_DIR, { recursive: true });
    await fsp.writeFile(path.join(TTS_CACHE_DIR, `${key}.mp3`), buf);
    await fsp.writeFile(
      path.join(TTS_CACHE_DIR, `${key}.json`),
      JSON.stringify({ dur: Number.isFinite(dur) ? dur : null, backend })
    );
  } catch (err) {
    console.warn(`[tts] cache write failed: ${err.message}`);
  }
}

/** One whole-input synthesis attempt against one backend. */
async function synthWhole(base, text, lengthScale) {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, response_format: "mp3", ...(lengthScale != null ? { length_scale: lengthScale } : {}) }),
    signal: AbortSignal.timeout(TTS_ATTEMPT_TIMEOUT_MS),
  });
  if (res.status === 400) {
    const errText = await res.text();
    if (errText.includes("input too long")) return { tooLong: true };
    throw new Error(`tts backend 400: ${errText.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`tts backend returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("tts backend returned no audio");
  return { buf, dur: parseDuration(res.headers.get("X-Audio-Duration")) };
}

/**
 * Chunked assembly from the same backend's deterministic chunk API: walk
 * chunk_from..chunk_to in windows of ≤16 chunks, slice each window's mp3 body
 * per its X-Chunk-Lengths, concatenate everything, sum X-Chunk-Durations.
 */
async function synthChunked(base, text) {
  const parts = [];
  const lengths = [];
  const durations = [];
  let total = null;
  let offset = 0; // next chunk_from
  let windows = 0;

  while (total === null || offset < total) {
    if (++windows > 4096) throw new Error("chunk walk exceeded safety limit");
    const from = offset;
    const to = total === null ? from + CHUNK_WINDOW - 1 : Math.min(from + CHUNK_WINDOW - 1, total - 1);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, response_format: "mp3", chunk_from: from, chunk_to: to, ...(lengthScale != null ? { length_scale: lengthScale } : {}) }),
      signal: AbortSignal.timeout(TTS_ATTEMPT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`chunk request returned ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());

    const totalHeader = Number.parseInt(res.headers.get("X-Chunk-Total") || "", 10);
    if (total === null) {
      if (!Number.isFinite(totalHeader) || totalHeader <= 0) throw new Error("missing X-Chunk-Total");
      total = totalHeader;
    }

    const lensHeader = res.headers.get("X-Chunk-Lengths");
    const lens = lensHeader
      ? lensHeader
          .split(",")
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n >= 0)
      : [body.length];
    let pos = 0;
    for (const len of lens) {
      if (pos + len > body.length) throw new Error("X-Chunk-Lengths exceed response body");
      parts.push(body.subarray(pos, pos + len));
      lengths.push(len);
      pos += len;
    }
    const dursHeader = res.headers.get("X-Chunk-Durations");
    if (dursHeader) {
      for (const piece of dursHeader.split(",")) {
        const d = Number.parseFloat(piece);
        durations.push(Number.isFinite(d) ? d : 0);
      }
    }
    offset += CHUNK_WINDOW;
  }

  const buf = Buffer.concat(parts);
  if (buf.length === 0) throw new Error("chunked synthesis produced no audio");
  const dur = durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) : null;
  return {
    buf,
    dur,
    chunk: { total, lengths, durations },
  };
}

/** Try primary then fallback; on "input too long" chunk on that same backend. */
async function synthesize(text, lengthScale) {
  const tiers = [
    ["primary", TTS_PRIMARY],
    ["fallback", TTS_FALLBACK],
  ];
  for (const [backend, base] of tiers) {
    try {
      const whole = await synthWhole(base, text, lengthScale);
      if (!whole.tooLong) return { buf: whole.buf, dur: whole.dur, backend, chunk: null };
      console.warn(`[tts] ${backend}: input too long → chunking`);
      const chunked = await synthChunked(base, text, lengthScale);
      return { buf: chunked.buf, dur: chunked.dur, backend, chunk: chunked.chunk };
    } catch (err) {
      console.warn(`[tts] ${backend} failed: ${err.message}`);
    }
  }
  return null;
}

/** Deduplicate concurrent identical inputs: one generation, shared result. */
function generate(key, text, lengthScale) {
  const existing = inflightTts.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const result = await synthesize(text, lengthScale);
    if (!result) return null;
    await writeCache(key, result.buf, result.dur, result.backend);
    return result;
  })();
  inflightTts.set(key, promise);
  promise.then(
    () => inflightTts.delete(key),
    () => inflightTts.delete(key)
  );
  return promise;
}

async function handleTts(req, res) {
  const raw = (await readBody(req)).toString("utf8");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }
  const input = body && typeof body.input === "string" ? body.input : "";
  if (input.length === 0) return sendJson(res, 400, { error: "empty input" });

  // Optional VITS speaking rate (>1 = slower); salted into the cache key so a
  // rate change can never serve stale audio. Mirrors the client's ttsCacheKey.
  let lengthScale = null;
  if (body.length_scale != null) {
    lengthScale = Number(body.length_scale);
    if (!Number.isFinite(lengthScale) || lengthScale < 0.5 || lengthScale > 2.0) {
      return sendJson(res, 400, { error: "invalid length_scale" });
    }
  }

  const key = sha256Hex(`${lengthScale ?? 1}\u0000${input}`);
  const cached = await readCache(key);
  if (cached) {
    const headers = {
      "Content-Type": "audio/mpeg",
      "Content-Length": cached.buf.length,
      "X-Cache": "hit",
      "X-Audio-Key": key,
    };
    if (Number.isFinite(cached.dur)) headers["X-Audio-Duration"] = String(cached.dur);
    res.writeHead(200, headers);
    return void res.end(cached.buf);
  }

  const gen = await generate(key, input, lengthScale);
  if (!gen) return sendJson(res, 502, { error: "tts unavailable" });

  const headers = {
    "Content-Type": "audio/mpeg",
    "Content-Length": gen.buf.length,
    "X-Cache": "miss",
    "X-Audio-Key": key,
    "X-Tts-Backend": gen.backend,
  };
  if (Number.isFinite(gen.dur)) headers["X-Audio-Duration"] = String(gen.dur);
  if (gen.chunk) {
    headers["X-Chunk-Total"] = String(gen.chunk.total);
    headers["X-Chunk-Lengths"] = gen.chunk.lengths.join(",");
    if (gen.chunk.durations.length > 0) {
      headers["X-Chunk-Durations"] = gen.chunk.durations.join(",");
    }
  }
  res.writeHead(200, headers);
  res.end(gen.buf);
}

/* ------------------------------- health ---------------------------------- */

async function ankiHealthy() {
  try {
    const up = await ankiFetch({ action: "version", version: 6, params: {} }, HEALTH_TIMEOUT_MS);
    if (up.status !== 200) return false;
    const data = JSON.parse(up.text);
    return Boolean(data) && data.error == null;
  } catch {
    return false;
  }
}

async function tierHealthy(base) {
  try {
    const res = await fetch(base.replace("/v1/audio/speech", "/health"), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function handleHealth(res) {
  const [anki, primary, fallback] = await Promise.all([
    ankiHealthy(),
    tierHealthy(TTS_PRIMARY),
    tierHealthy(TTS_FALLBACK),
  ]);
  sendJson(res, 200, { anki, primary, fallback });
}

/* ------------------------------- static ---------------------------------- */

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "bad path" });
  }
  if (rel === "/") rel = "/index.html";
  if (rel.endsWith("/")) rel += "index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 404, { error: "not found" });
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: "not found" });

  const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------- settings -------------------------------- */

// Shared user settings (theme / playback speed / TTS replacements) — the
// server is the source of truth across devices; the browser keeps a
// localStorage mirror for instant paint and offline resilience.
const SPEED_CHOICES = [0.5, 0.75, 0.8, 0.9, 1, 1.25, 1.5];
const MAX_REPLACEMENTS = 200;
const MAX_REPLACEMENT_LEN = 500;

function sanitizeSettings(raw) {
  const out = {
    theme: raw && raw.theme === "dark" ? "dark" : "light",
    speed: 1,
    replacements: [],
  };
  const speed = raw ? Number(raw.speed) : NaN;
  if (SPEED_CHOICES.includes(speed)) out.speed = speed;
  if (raw && Array.isArray(raw.replacements)) {
    out.replacements = raw.replacements.slice(0, MAX_REPLACEMENTS).map((rule) => ({
      from: String(rule && rule.from != null ? rule.from : "").slice(0, MAX_REPLACEMENT_LEN),
      to: String(rule && rule.to != null ? rule.to : "").slice(0, MAX_REPLACEMENT_LEN),
    }));
  }
  return out;
}

async function readSettingsFile() {
  try {
    return sanitizeSettings(JSON.parse(await fsp.readFile(SETTINGS_PATH, "utf8")));
  } catch (err) {
    if (err.code === "ENOENT") return null; // never seeded yet
    console.warn("[settings] unreadable, treating as unseeded:", err.message);
    return null;
  }
}

async function writeSettingsFile(settings) {
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fsp.rename(tmp, SETTINGS_PATH); // atomic
}

async function handleSettingsGet(res) {
  const settings = await readSettingsFile();
  if (!settings) return sendJson(res, 404, { error: "not seeded" });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(settings));
}

async function handleSettingsPut(req, res) {
  const body = await readBody(req);
  let raw;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }
  const settings = sanitizeSettings(raw);
  await writeSettingsFile(settings);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(settings));
}

/* -------------------------------- router --------------------------------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (req.method === "POST" && p === "/api/anki") return await handleAnki(req, res);
    if (req.method === "POST" && p === "/api/tts") return await handleTts(req, res);
    if (req.method === "GET" && p === "/api/health") return await handleHealth(res);
    if (req.method === "GET" && p === "/api/settings") return await handleSettingsGet(res);
    if (req.method === "PUT" && p === "/api/settings") return await handleSettingsPut(req, res);
    if (req.method === "GET" && p.startsWith("/api/media/")) {
      return await handleMedia(res, p.slice("/api/media/".length));
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (p.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
      return serveStatic(req, res, p);
    }
    sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    const status = err && err.statusCode === 413 ? 413 : 500;
    console.error("[server]", err);
    if (!res.headersSent) sendJson(res, status, { error: status === 413 ? "payload too large" : "internal error" });
    else res.end();
  }
});

server.on("error", (err) => {
  console.error(`[server] ${err.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`anki-audio listening on :${PORT} (anki=${ANKI_URL})`);
});
