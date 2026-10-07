// GET /api/iptv/api?server=&username=&password=&action=...  — Xtream player_api.php passthrough.
const { ACTIONS, PASS_PARAMS, validServer, upstreamHeaders, fetchUpstream } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }
  const p = new URL(req.url, "http://x").searchParams;

  const base = validServer(p.get("server") || "", process.env.ALLOWED_HOSTS);
  if (!base) { res.status(400).send("Server not allowed"); return; }
  const username = p.get("username") || "";
  const password = p.get("password") || "";
  const action = p.get("action") || "";
  if (!username || !password) { res.status(400).send("Missing username or password"); return; }
  if (!ACTIONS.has(action)) { res.status(400).send("Action not allowed"); return; }

  const up = new URL(`${base}/player_api.php`);
  up.searchParams.set("username", username);
  up.searchParams.set("password", password);
  if (action) up.searchParams.set("action", action);
  for (const k of PASS_PARAMS) {
    const v = p.get(k);
    if (v && /^\d+$/.test(v)) up.searchParams.set(k, v);
  }

  const upstream = await fetchUpstream(up.href, upstreamHeaders());
  if (!upstream) { res.status(502).send("Couldn't reach the IPTV server"); return; }
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(upstream.status).send(await upstream.text());
};
