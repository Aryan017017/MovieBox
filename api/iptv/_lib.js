// Shared helpers for the IPTV proxy functions (api/iptv/api.js, live.js, relay.js).
// Node.js serverless runtime — NOT edge — because this provider blocks Cloudflare's
// IP ranges but not Vercel's AWS-based ones (verified by hand).
const crypto = require("crypto");
const { Readable } = require("stream");

const ACTIONS = new Set([
  "", "get_live_categories", "get_live_streams", "get_short_epg",
  "get_vod_categories", "get_vod_streams", "get_vod_info",
  "get_series_categories", "get_series", "get_series_info",
]);
const PASS_PARAMS = ["category_id", "stream_id", "limit", "series_id", "vod_id"];

function list(value) {
  return String(value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Returns "http://host[:port]" if the host is in ALLOWED_HOSTS, else null.
function validServer(raw, allowedHosts) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!list(allowedHosts).includes(u.hostname.toLowerCase())) return null;
  return u.origin;
}

// forceRange: media routes (live/vod/relay) pass true so every request
// upstream carries a *bounded* Range, never an open-ended one. These are
// 500MB-2GB+ movie files, and an open "bytes=0-" or "bytes=N-" (no end) —
// whether that's our own fallback for a rangeless client request, or the
// browser's own initial "bytes=0-" probe, both verified by hand — asks the
// provider for everything from that point to EOF. Streaming that in one
// response hangs indefinitely through vercel dev locally and errors out on
// a real Vercel deployment. Clamping to a bounded chunk avoids ever
// requesting more than CHUNK bytes in one response; the <video> element
// issues further real bounded-or-not requests for more, same as any
// Range-supporting server, once it sees Accept-Ranges/Content-Range.
const CHUNK = 2 * 1024 * 1024; // 2MB
function clampRange(rangeHeader) {
  if (!rangeHeader) return `bytes=0-${CHUNK - 1}`;
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return `bytes=0-${CHUNK - 1}`; // unrecognized form — don't forward it verbatim
  const start = Number(m[1]);
  if (m[2]) return rangeHeader; // client gave an explicit end — already bounded
  return `bytes=${start}-${start + CHUNK - 1}`;
}
function upstreamHeaders(rangeHeader, forceRange) {
  const h = { "User-Agent": process.env.UPSTREAM_UA || "VLC/3.0.20 LibVLC/3.0.20", Accept: "*/*" };
  const range = forceRange ? clampRange(rangeHeader) : rangeHeader || null;
  if (range) h.Range = range;
  return h;
}

function sign(secret, text) {
  return crypto.createHmac("sha256", secret).update(text).digest("hex");
}
function verify(secret, text, sigHex) {
  if (!/^[0-9a-f]+$/i.test(sigHex || "")) return false;
  const expected = Buffer.from(sign(secret, text), "hex");
  const given = Buffer.from(sigHex, "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function relayURL(secret, origin, absolute) {
  return `${origin}/api/iptv/relay?u=${encodeURIComponent(absolute)}&s=${sign(secret, absolute)}`;
}

// Rewrites every URI in an HLS playlist (segments, keys, sub-playlists) to a
// signed /api/iptv/relay link, so the provider's raw http:// URLs never reach the browser.
function rewritePlaylist(text, baseUrl, origin, secret) {
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) {
      const matches = [...t.matchAll(/URI="([^"]+)"/g)];
      if (!matches.length) return line;
      let result = line;
      for (const m of matches) {
        let abs;
        try { abs = new URL(m[1], baseUrl).href; } catch { continue; }
        result = result.replace(m[0], `URI="${relayURL(secret, origin, abs)}"`);
      }
      return result;
    }
    let abs;
    try { abs = new URL(t, baseUrl).href; } catch { return line; }
    return relayURL(secret, origin, abs);
  }).join("\n");
}

function isPlaylist(contentType, url) {
  const ct = (contentType || "").toLowerCase();
  return ct.includes("mpegurl") || /\.m3u8(\?|$)/i.test(url);
}

function originOf(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${req.headers.host}`;
}

// Forwards an upstream fetch() Response to the Vercel `res`, rewriting HLS
// playlists to relay links and streaming everything else (segments, .ts) as-is.
async function pipeUpstream(res, upstreamRes, finalUrl, origin, secret) {
  res.setHeader("Cache-Control", "no-store");

  if (isPlaylist(upstreamRes.headers.get("content-type"), finalUrl)) {
    if (!secret) { res.status(500).send("RELAY_SECRET is not set on the project"); return; }
    const body = await upstreamRes.text();
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.status(upstreamRes.status).send(rewritePlaylist(body, finalUrl, origin, secret));
    return;
  }

  const ct = upstreamRes.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  for (const name of ["content-length", "content-range"]) {
    const v = upstreamRes.headers.get(name);
    if (v) res.setHeader(name, v);
  }
  // Some upstream CDNs send a malformed Accept-Ranges value (e.g. a literal
  // byte count instead of the token "bytes") — verified by hand. Chrome's
  // media engine only recognizes the real token, so a bad one makes it
  // decide the server has no range support and fall back to a full-file
  // download instead of progressive ranged playback.
  if (upstreamRes.headers.get("accept-ranges") || upstreamRes.headers.get("content-range")) {
    res.setHeader("accept-ranges", "bytes");
  }
  res.status(upstreamRes.status);
  if (!upstreamRes.body) { res.end(); return; }
  // Video playback constantly aborts/restarts range requests (seeking,
  // buffering, switching sources) — without these handlers, the resulting
  // "other side closed" stream error is unhandled and crashes the process.
  const nodeStream = Readable.fromWeb(upstreamRes.body);
  nodeStream.on("error", () => { try { res.end(); } catch {} });
  res.on("close", () => { try { nodeStream.destroy(); } catch {} });
  nodeStream.pipe(res);
}

// Follows redirects manually rather than via fetch's redirect:"follow" —
// on Vercel's Node runtime, automatic redirect-following silently hangs on
// this provider's multi-hop cross-host redirect chains (dns-plevo.cc ->
// yzx-port.com -> a raw-IP signed CDN url), even though each hop resolves
// in well under a second when fetched individually. Verified by hand.
async function fetchUpstream(url, headers) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    let res;
    try { res = await fetch(current, { headers, redirect: "manual" }); }
    catch { return null; }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    try { current = new URL(location, current).href; }
    catch { return res; }
  }
  return null;
}

module.exports = {
  ACTIONS, PASS_PARAMS, list, validServer, upstreamHeaders,
  sign, verify, relayURL, rewritePlaylist, isPlaylist, originOf, pipeUpstream, fetchUpstream,
};
