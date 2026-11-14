// GET /api/relay?u=<url>&s=<signature> — generic signed byte-proxy.
//
// Exists for the universal (WASM-transcode) player path: unlike a native
// <video src>, which can play a cross-origin URL with no CORS cooperation
// at all, feeding raw bytes into ffmpeg-core's WASM module requires
// fetch()-ing them into JS, and fetch() enforces CORS on every hop of a
// redirect chain. PenguPlay's links in particular 307-redirect to FebBox's
// backend (shegu.net), which sends no CORS headers at all — verified by
// hand — so the browser blocks the fetch outright even though pengu.uk's
// own redirector is permissive. Routing the byte-fetch through this
// same-origin relay sidesteps that entirely.
//
// Also fixes a second, distinct problem for HLS sources: some upstream
// CDNs behind these addons (e.g. Cinejoy's streams, proxied through
// nebula.bright67.online) do Referer-based anti-hotlink checks — verified
// by hand: the exact same request 404s with our site's real Referer but
// returns 200 with no Referer at all (or the provider's own expected one).
// A real browser always sends its own page as Referer on a cross-origin
// request; this server-side fetch sends none, which already passes. For
// that fix to actually take effect the BROWSER must never talk to the
// upstream CDN directly at all — so playlist responses get every nested
// URI (sub-playlists, segments, init segments) rewritten to route back
// through this same relay too (pipeUpstream/rewritePlaylist, shared with
// api/iptv/relay.js), not just the top-level request.
//
// Only ever serves URLs this project itself signed (api/stream.js, same
// RELAY_SECRET/sign() as api/iptv/relay.js) — never an arbitrary URL a
// client hands it, so this can't become an open SSRF proxy.
const { verify, fetchUpstream, pipeUpstream, originOf } = require("./iptv/_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }
  const secret = process.env.RELAY_SECRET;
  if (!secret) { res.status(500).send("RELAY_SECRET is not set on the project"); return; }

  const p = new URL(req.url, "http://x").searchParams;
  const target = p.get("u") || "";
  if (!verify(secret, target, p.get("s") || "")) { res.status(403).send("Bad signature"); return; }
  let t;
  try { t = new URL(target); } catch { res.status(400).send("Bad url"); return; }
  if (t.protocol !== "http:" && t.protocol !== "https:") { res.status(400).send("Bad url"); return; }

  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetchUpstream(t.href, headers);
  if (!upstream) { res.status(502).send("Couldn't reach upstream"); return; }

  // Permissive — the real access control is the signature check above, not
  // Origin (this always runs same-origin from the deployed app anyway, but
  // CORS costs nothing to allow and keeps this usable from a preview/dev
  // origin too).
  res.setHeader("Access-Control-Allow-Origin", "*");
  await pipeUpstream(res, upstream, upstream.url || t.href, originOf(req), secret, "/api/relay");
};

module.exports.config = { maxDuration: 60 };
