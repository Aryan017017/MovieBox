// GET /api/iptv/live?server=&username=&password=&stream_id=&ext=ts|m3u8 — live channel stream.
const { validServer, upstreamHeaders, fetchUpstream, originOf, pipeUpstream } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }
  const p = new URL(req.url, "http://x").searchParams;

  const base = validServer(p.get("server") || "", process.env.ALLOWED_HOSTS);
  if (!base) { res.status(400).send("Server not allowed"); return; }
  const username = p.get("username") || "";
  const password = p.get("password") || "";
  const id = p.get("stream_id") || "";
  const ext = p.get("ext") === "m3u8" ? "m3u8" : "ts";
  if (!username || !password) { res.status(400).send("Missing username or password"); return; }
  if (!/^\d+$/.test(id)) { res.status(400).send("Bad stream id"); return; }

  const target = `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${ext}`;
  const upstream = await fetchUpstream(target, upstreamHeaders(req.headers.range, true));
  if (!upstream) { res.status(502).send("Couldn't reach the IPTV server"); return; }
  if (!upstream.ok) { res.status(upstream.status).send(`IPTV server answered ${upstream.status}`); return; }

  await pipeUpstream(res, upstream, upstream.url || target, originOf(req), process.env.RELAY_SECRET);
};

module.exports.config = { maxDuration: 60 };
