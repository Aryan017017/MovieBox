// GET /api/iptv/relay?u=<signed upstream url>&s=<signature> — HLS segments/keys/sub-playlists.
// Only ever serves URLs this project itself produced (HMAC-signed in _lib.rewritePlaylist).
const { verify, upstreamHeaders, fetchUpstream, originOf, pipeUpstream } = require("./_lib");

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

  const upstream = await fetchUpstream(t.href, upstreamHeaders(req.headers.range, true));
  if (!upstream) { res.status(502).send("Couldn't reach the IPTV server"); return; }

  await pipeUpstream(res, upstream, upstream.url || t.href, originOf(req), secret);
};

module.exports.config = { maxDuration: 60 };
