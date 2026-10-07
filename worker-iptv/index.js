// MovieBox IPTV proxy — Cloudflare Worker.
//
// Why this exists: IPTV providers serve plain http:// streams without CORS
// headers, so an https website can't play them directly (mixed content + CORS).
// This Worker sits in the middle and fixes both.
//
// Safety model (so it can't become an open relay):
//   - It only talks to hosts listed in ALLOWED_HOSTS (wrangler.toml).
//   - It only answers browsers on ALLOWED_ORIGINS (your site) when an Origin
//     header is present.
//   - Provider credentials are NOT stored here. The browser sends the user's
//     own login with each request; the Worker just forwards it.
//   - HLS playlists get their segment URLs rewritten to /relay links that are
//     HMAC-signed with RELAY_SECRET, so /relay only serves URLs this Worker
//     itself produced.
//
// Routes:
//   GET /api?server=&username=&password=&action=...   Xtream player_api.php
//   GET /live?server=&username=&password=&stream_id=&ext=ts|m3u8
//   GET /relay?u=<signed upstream url>&s=<signature>   (internal, HLS segments)

const ACTIONS = new Set([
  "", "get_live_categories", "get_live_streams", "get_short_epg",
]);
const PASS_PARAMS = ["category_id", "stream_id", "limit"];
const LOCALHOST_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function list(value, fallback) {
  const src = (value ?? fallback ?? "").toString();
  return src.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // <video src> and direct visits send no Origin
  if (LOCALHOST_RE.test(origin)) return true;
  return list(env.ALLOWED_ORIGINS).includes(origin.toLowerCase());
}

function corsHeaders(request) {
  const h = new Headers();
  const origin = request.headers.get("Origin");
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Range, Content-Type");
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type");
  return h;
}

function fail(request, status, message) {
  const h = corsHeaders(request);
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(message, { status, headers: h });
}

// Returns "http://host[:port]" if the host is allowed, else null.
function validServer(raw, env) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!list(env.ALLOWED_HOSTS).includes(u.hostname.toLowerCase())) return null;
  return u.origin;
}

function upstreamHeaders(request, env, withRange) {
  const h = new Headers();
  h.set("User-Agent", env.UPSTREAM_UA || "VLC/3.0.20 LibVLC/3.0.20");
  h.set("Accept", "*/*");
  if (withRange) {
    const range = request.headers.get("Range");
    if (range) h.set("Range", range);
  }
  return h;
}

// ---- HMAC signing for /relay ----
async function hmacKey(env) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.RELAY_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
  return new Uint8Array(hex.match(/../g).map(b => parseInt(b, 16)));
}
async function sign(env, text) {
  const key = await hmacKey(env);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}
async function verify(env, text, sigHex) {
  const sig = fromHex(sigHex || "");
  if (!sig) return false;
  const key = await hmacKey(env);
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(text));
}

// ---- HLS playlist rewriting ----
async function relayURL(env, workerOrigin, absolute) {
  const s = await sign(env, absolute);
  return `${workerOrigin}/relay?u=${encodeURIComponent(absolute)}&s=${s}`;
}

async function rewritePlaylist(text, baseUrl, workerOrigin, env) {
  const lines = text.split(/\r?\n/);
  const out = await Promise.all(lines.map(async (line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) {
      // Tags that carry a URI="..." attribute (keys, init segments, renditions).
      const matches = [...t.matchAll(/URI="([^"]+)"/g)];
      if (!matches.length) return line;
      let result = line;
      for (const m of matches) {
        let abs;
        try { abs = new URL(m[1], baseUrl).href; } catch { continue; }
        result = result.replace(m[0], `URI="${await relayURL(env, workerOrigin, abs)}"`);
      }
      return result;
    }
    let abs;
    try { abs = new URL(t, baseUrl).href; } catch { return line; }
    return relayURL(env, workerOrigin, abs);
  }));
  return out.join("\n");
}

function isPlaylist(res, url) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("mpegurl") || /\.m3u8(\?|$)/i.test(url);
}

async function respond(request, env, upstreamRes, finalUrl, workerOrigin) {
  const h = corsHeaders(request);
  h.set("Cache-Control", "no-store");

  if (isPlaylist(upstreamRes, finalUrl)) {
    if (!env.RELAY_SECRET) {
      return fail(request, 500, "RELAY_SECRET is not set on the Worker. Run: wrangler secret put RELAY_SECRET");
    }
    const body = await upstreamRes.text();
    h.set("Content-Type", "application/vnd.apple.mpegurl");
    return new Response(await rewritePlaylist(body, finalUrl, workerOrigin, env), {
      status: upstreamRes.status, headers: h,
    });
  }

  const ct = upstreamRes.headers.get("content-type");
  if (ct) h.set("Content-Type", ct);
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstreamRes.headers.get(name);
    if (v) h.set(name, v);
  }
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: h });
}

async function fetchUpstream(request, env, url, withRange) {
  try {
    return await fetch(url, {
      headers: upstreamHeaders(request, env, withRange),
      redirect: "follow",
    });
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "GET") return fail(request, 405, "Method not allowed");
    if (!originAllowed(request, env)) return fail(request, 403, "Origin not allowed");

    const url = new URL(request.url);
    const p = url.searchParams;

    // ---- Xtream API ----
    if (url.pathname === "/api") {
      const base = validServer(p.get("server") || "", env);
      if (!base) return fail(request, 400, "Server not allowed");
      const username = p.get("username") || "";
      const password = p.get("password") || "";
      const action = p.get("action") || "";
      if (!username || !password) return fail(request, 400, "Missing username or password");
      if (!ACTIONS.has(action)) return fail(request, 400, "Action not allowed");

      const up = new URL(`${base}/player_api.php`);
      up.searchParams.set("username", username);
      up.searchParams.set("password", password);
      if (action) up.searchParams.set("action", action);
      for (const k of PASS_PARAMS) {
        const v = p.get(k);
        if (v && /^\d+$/.test(v)) up.searchParams.set(k, v);
      }
      const res = await fetchUpstream(request, env, up.href, false);
      if (!res) return fail(request, 502, "Couldn't reach the IPTV server");
      const h = corsHeaders(request);
      h.set("Content-Type", res.headers.get("content-type") || "application/json");
      h.set("Cache-Control", "no-store");
      return new Response(res.body, { status: res.status, headers: h });
    }

    // ---- Live stream ----
    if (url.pathname === "/live") {
      const base = validServer(p.get("server") || "", env);
      if (!base) return fail(request, 400, "Server not allowed");
      const username = p.get("username") || "";
      const password = p.get("password") || "";
      const id = p.get("stream_id") || "";
      const ext = p.get("ext") === "m3u8" ? "m3u8" : "ts";
      if (!username || !password) return fail(request, 400, "Missing username or password");
      if (!/^\d+$/.test(id)) return fail(request, 400, "Bad stream id");

      const target = `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${ext}`;
      const res = await fetchUpstream(request, env, target, false);
      if (!res) return fail(request, 502, "Couldn't reach the IPTV server");
      if (!res.ok) return fail(request, res.status, `IPTV server answered ${res.status}`);
      return respond(request, env, res, res.url || target, url.origin);
    }

    // ---- Signed relay (HLS segments, keys, sub-playlists) ----
    if (url.pathname === "/relay") {
      if (!env.RELAY_SECRET) return fail(request, 500, "RELAY_SECRET is not set on the Worker");
      const target = p.get("u") || "";
      if (!(await verify(env, target, p.get("s") || ""))) return fail(request, 403, "Bad signature");
      let t;
      try { t = new URL(target); } catch { return fail(request, 400, "Bad url"); }
      if (t.protocol !== "http:" && t.protocol !== "https:") return fail(request, 400, "Bad url");
      const res = await fetchUpstream(request, env, t.href, true);
      if (!res) return fail(request, 502, "Couldn't reach the IPTV server");
      return respond(request, env, res, res.url || t.href, url.origin);
    }

    return fail(request, 404, "Not found");
  },
};
