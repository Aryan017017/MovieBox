// GET /api/stream?base=&type=movie|tv&imdb=tt1234567[&season=&episode=]
//
// Server-side relay to a Stremio-style HTTP stream addon (PenguPlay,
// CNCVerse Bridge, 111477, ...) — these have no CORS headers (built for the
// native Stremio app, not browser fetches), so the browser can't call them
// directly; this just forwards the one request and returns the upstream
// JSON. The caller (app.js) fans this out once per configured source and
// merges the results into one picker list.
//
// `base` must resolve to a host in STREAM_ALLOWED_HOSTS (comma-separated;
// defaults to the sources this site ships with, so it works with zero
// server config) or the request is rejected — same allowlist approach as
// the IPTV proxy (api/iptv/_lib.js's validServer), which exists so this
// endpoint can't be abused as an open SSRF proxy to an arbitrary host.
// Override STREAM_ALLOWED_HOSTS on the Vercel project only if you add a
// source on a new host.
const { sign } = require("./iptv/_lib");

const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_ALLOWED_HOSTS = "pengu.uk,cncverse.dpdns.org,st.111477.xyz,torrentio.strem.fun";

function list(value) {
  return String(value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Returns a clean "https://host[:port][/path]" (manifest.json / trailing
// slash stripped) if the host is allowed, else null.
function validBase(raw, allowedHosts) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (!list(allowedHosts).includes(u.hostname.toLowerCase())) return null;
  const path = u.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
  return u.origin + path;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }
  const p = new URL(req.url, "http://x").searchParams;

  const base = validBase(p.get("base") || "", process.env.STREAM_ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS);
  if (!base) { res.status(400).json({ streams: [] }); return; }

  const type = p.get("type") === "tv" ? "series" : "movie";
  const imdb = p.get("imdb") || "";
  if (!/^tt\d+$/.test(imdb)) { res.status(400).json({ streams: [] }); return; }

  let id = imdb;
  if (type === "series") {
    const season = Number(p.get("season")) || 1;
    const episode = Number(p.get("episode")) || 1;
    id = `${imdb}:${season}:${episode}`;
  }

  const target = `${base}/stream/${type}/${encodeURIComponent(id)}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(target, {
      signal: controller.signal,
      headers: { "User-Agent": "MovieBox/1.0 (+Stremio stream client)", Accept: "application/json" },
    });
  } catch {
    res.status(502).json({ streams: [] });
    return;
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) { res.status(200).json({ streams: [] }); return; }

  let data;
  try { data = await upstream.json(); } catch { res.status(200).json({ streams: [] }); return; }

  // fetchUrl is a signed /api/relay link for the same bytes — only the
  // universal (WASM-transcode) player needs it, for when a native <video
  // src> fails: that path needs the raw bytes in JS (via fetch()), which
  // enforces CORS on every hop of a redirect chain, unlike <video>
  // playback itself. `url` stays the plain upstream link for the fast
  // native-<video> path, which has no such requirement.
  //
  // Torrentio (and similar torrent-indexer addons) return raw torrent info
  // — infoHash/fileIdx/sources — instead of a url when no debrid service
  // is configured upstream: there's no server anywhere that's downloaded
  // the file yet, only a swarm to join, which needs a real BitTorrent
  // client (something this relay deliberately isn't — see the player's own
  // docs on why). Rather than drop these silently, they're turned into a
  // plain magnet: link for the browser to hand off to whatever torrent
  // client is installed — not playable here, but not a dead end either.
  // The moment a debrid key is added to the source's own config, Torrentio
  // starts returning a real url for the same titles, which the existing
  // code above already handles with no changes needed.
  function toMagnet(s) {
    const trackers = Array.isArray(s.sources)
      ? s.sources.filter((x) => typeof x === "string" && x.startsWith("tracker:")).map((x) => x.slice("tracker:".length))
      : [];
    const dn = encodeURIComponent(s.behaviorHints?.filename || s.title || s.name || "video");
    const tr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
    return `magnet:?xt=urn:btih:${s.infoHash}&dn=${dn}${tr}`;
  }

  const secret = process.env.RELAY_SECRET;
  const streams = Array.isArray(data?.streams)
    ? data.streams
        .map((s) => {
          if (!s) return null;
          if (typeof s.url === "string" && /^https?:\/\//i.test(s.url)) {
            return {
              url: s.url,
              name: s.name || s.title || "",
              fetchUrl: secret ? `/api/relay?u=${encodeURIComponent(s.url)}&s=${sign(secret, s.url)}` : null,
            };
          }
          if (typeof s.infoHash === "string" && /^[0-9a-f]{40}$/i.test(s.infoHash)) {
            return { magnet: toMagnet(s), name: s.name || s.title || "" };
          }
          return null;
        })
        .filter(Boolean)
        .slice(0, 10)
    : [];

  res.status(200).json({ streams });
};

module.exports.config = { maxDuration: 30 };
