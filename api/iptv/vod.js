// GET /api/iptv/vod?server=&username=&password=&kind=movie|series&stream_id=&ext= — VOD/series stream.
const { validServer, upstreamHeaders, fetchUpstream, originOf, pipeUpstream } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }
  const p = new URL(req.url, "http://x").searchParams;

  const base = validServer(p.get("server") || "", process.env.ALLOWED_HOSTS);
  if (!base) { res.status(400).send("Server not allowed"); return; }
  const username = p.get("username") || "";
  const password = p.get("password") || "";
  const kind = p.get("kind") === "series" ? "series" : "movie";
  const id = p.get("stream_id") || "";
  const ext = /^[a-z0-9]{2,5}$/i.test(p.get("ext") || "") ? p.get("ext") : "mp4";
  if (!username || !password) { res.status(400).send("Missing username or password"); return; }
  if (!/^\d+$/.test(id)) { res.status(400).send("Bad stream id"); return; }

  const target = `${base}/${kind}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${ext}`;
  const upstream = await fetchUpstream(target, upstreamHeaders(req.headers.range, true));
  if (!upstream) { res.status(502).send("Couldn't reach the IPTV server"); return; }
  if (!upstream.ok) { res.status(upstream.status).send(`IPTV server answered ${upstream.status}`); return; }

  await pipeUpstream(res, upstream, upstream.url || target, originOf(req), process.env.RELAY_SECRET);
};

module.exports.config = { maxDuration: 60 };
