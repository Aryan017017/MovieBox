// GET /api/iptv/match?server=&username=&password=&kind=movie|tv&title=&year=&poster=[&season=&episode=]
//
// The provider has no text-search API, so finding "this TMDB title" means
// fetching its *entire* VOD or series catalog (134k movies / 33k series on
// this provider) and matching in memory. That full fetch is cached per
// (server, kind) for CACHE_TTL_MS in this module's memory — cheap on a warm
// serverless instance, ~20s again on a cold one. Never sends the catalog
// itself to the client, only the one matched result.
const { validServer, upstreamHeaders, fetchUpstream } = require("./_lib");
const { posterFile, findMatch } = require("./_match");

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // `${base}|${kind}` -> { at, items }

// A plain <video> element plays these reliably; mkv/avi/etc. are excluded
// even though the provider serves them — Chrome's native mkv support is
// unreliable enough in practice that it's not worth the 12s failed attempt
// (verified by hand: an .mkv match never started playback before falling
// back to an iframe provider anyway).
const SAFE_EXTS = new Set(["mp4", "m4v", "mov", "webm", "m3u8"]);

function stripMovie(x) {
  const ext = (x.container_extension || "mp4").toLowerCase();
  if (!SAFE_EXTS.has(ext)) return null;
  return { id: x.stream_id, title: x.title || x.name, year: x.year, poster: posterFile(x.stream_icon), ext };
}
function stripSeries(x) {
  // Series ext isn't known until the per-episode get_series_info lookup —
  // filtered there instead (see the handler below).
  return { id: x.series_id, title: x.title || x.name, year: x.year, poster: posterFile(x.cover) };
}

function apiURL(base, username, password, action) {
  const u = new URL(`${base}/player_api.php`);
  u.searchParams.set("username", username);
  u.searchParams.set("password", password);
  u.searchParams.set("action", action);
  return u.href;
}

async function loadCatalog(base, username, password, kind) {
  const key = `${base}|${kind}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;

  const action = kind === "tv" ? "get_series" : "get_vod_streams";
  const res = await fetchUpstream(apiURL(base, username, password, action), upstreamHeaders());
  if (!res || !res.ok) return hit ? hit.items : null; // serve stale on a transient upstream failure
  let raw;
  try { raw = await res.json(); } catch { return hit ? hit.items : null; }
  if (!Array.isArray(raw)) return hit ? hit.items : null;

  const items = raw.map(kind === "tv" ? stripSeries : stripMovie).filter(Boolean);
  cache.set(key, { at: Date.now(), items });
  return items;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }
  const p = new URL(req.url, "http://x").searchParams;

  const base = validServer(p.get("server") || "", process.env.ALLOWED_HOSTS);
  if (!base) { res.status(400).json({ found: false, error: "Server not allowed" }); return; }
  const username = p.get("username") || "";
  const password = p.get("password") || "";
  const kind = p.get("kind") === "tv" ? "tv" : "movie";
  const title = p.get("title") || "";
  const year = p.get("year") || "";
  const poster = p.get("poster") || "";
  if (!username || !password || !title) { res.status(400).json({ found: false, error: "Missing params" }); return; }

  const catalog = await loadCatalog(base, username, password, kind);
  if (!catalog) { res.status(502).json({ found: false, error: "Couldn't load the IPTV catalog" }); return; }

  const match = findMatch(catalog, { title, year, poster });
  if (!match) { res.status(200).json({ found: false }); return; }

  if (kind === "movie") {
    res.status(200).json({ found: true, streamId: match.id, ext: match.ext || "mp4" });
    return;
  }

  // TV: the matched entry is the *series* — resolve the actual episode's own
  // stream id via a single live (uncached) get_series_info call.
  const season = Number(p.get("season")) || 1;
  const episode = Number(p.get("episode")) || 1;
  const infoRes = await fetchUpstream(
    apiURL(base, username, password, "get_series_info") + `&series_id=${encodeURIComponent(match.id)}`,
    upstreamHeaders(),
  );
  if (!infoRes || !infoRes.ok) { res.status(200).json({ found: false }); return; }
  let info;
  try { info = await infoRes.json(); } catch { res.status(200).json({ found: false }); return; }
  const allEpisodes = Object.values(info?.episodes || {}).flat();
  const ep = allEpisodes.find((e) => Number(e.season) === season && Number(e.episode_num) === episode);
  const ext = (ep?.container_extension || "mp4").toLowerCase();
  if (!ep || !SAFE_EXTS.has(ext)) { res.status(200).json({ found: false }); return; }

  res.status(200).json({ found: true, streamId: Number(ep.id), ext });
};

module.exports.config = { maxDuration: 60 };
