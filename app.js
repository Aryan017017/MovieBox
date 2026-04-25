// =========================================================================
// CONFIG — paste your free TMDB API key below (get one: themoviedb.org/settings/api)
// =========================================================================
const TMDB_API_KEY = "ebc17fdd2c491ffd1d0cbac7000be592";
const PLAYER_COLOR = "E50914"; // accent color sent to Videasy player (no #)
// =========================================================================

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const PLAYER_BASE = "https://player.videasy.net";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ---------- localStorage helpers ----------
const STORAGE = {
  progress: "streamly:progress",
  list: "streamly:mylist",
};
const loadJSON = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) || fallback; }
  catch { return fallback; }
};
const saveJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let progressMap = loadJSON(STORAGE.progress, {}); // { "movie:299534": {progress, timestamp, duration, title, poster, ...} }
let myList = loadJSON(STORAGE.list, []);          // [{id, type, title, poster, backdrop}]

// ---------- TMDB fetch ----------
async function tmdb(path, params = {}) {
  if (!TMDB_API_KEY || TMDB_API_KEY === "YOUR_TMDB_API_KEY_HERE") {
    throw new Error("Missing TMDB API key. Edit app.js and set TMDB_API_KEY.");
  }
  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

// ---------- AniList (no key needed) ----------
async function anilistTrending() {
  const query = `
    query {
      Page(perPage: 20) {
        media(type: ANIME, sort: TRENDING_DESC, format_in: [TV, MOVIE]) {
          id title { romaji english } coverImage { large }
          bannerImage description(asHtml: false) format episodes averageScore startDate { year }
        }
      }
    }`;
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = await r.json();
  return data.data.Page.media.map(m => ({
    id: m.id,
    type: "anime",
    title: m.title.english || m.title.romaji,
    poster: m.coverImage.large,
    backdrop: m.bannerImage || m.coverImage.large,
    overview: (m.description || "").replace(/<[^>]+>/g, ""),
    year: m.startDate?.year,
    rating: m.averageScore ? (m.averageScore / 10).toFixed(1) : null,
    episodes: m.episodes,
    isMovie: m.format === "MOVIE",
  }));
}

// ---------- Normalizers ----------
function normalizeTMDB(item, forcedType) {
  const type = forcedType || (item.media_type === "tv" ? "tv" : "movie");
  return {
    id: item.id,
    type,
    title: item.title || item.name,
    poster: item.poster_path ? `${IMG}/w342${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${IMG}/original${item.backdrop_path}` : null,
    overview: item.overview,
    year: (item.release_date || item.first_air_date || "").slice(0, 4),
    rating: item.vote_average ? item.vote_average.toFixed(1) : null,
  };
}

// ---------- Rendering ----------
function makeCard(item, opts = {}) {
  const card = document.createElement("div");
  card.className = "card";
  if (item.poster) card.style.backgroundImage = `url("${item.poster}")`;
  card.innerHTML = `
    <div class="card-overlay">${escapeHTML(item.title || "Untitled")}</div>
    ${opts.progress ? `<div class="progress-bar"><div style="width:${opts.progress}%"></div></div>` : ""}
  `;
  card.addEventListener("click", () => openModal(item));
  return card;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function renderRow(title, items, opts = {}) {
  const row = document.createElement("section");
  row.className = "row";
  row.innerHTML = `<h2>${escapeHTML(title)}</h2>`;
  if (!items || items.length === 0) {
    row.innerHTML += `<div class="empty">Nothing here yet.</div>`;
    return row;
  }
  const scroll = document.createElement("div");
  scroll.className = "row-scroll";
  items.forEach(it => {
    const cardOpts = {};
    if (opts.showProgress) {
      const key = progressKey(it);
      const p = progressMap[key];
      if (p?.progress) cardOpts.progress = Math.min(100, Math.round(p.progress));
    }
    if (it.poster) scroll.appendChild(makeCard(it, cardOpts));
  });
  row.appendChild(scroll);
  return row;
}

function renderHero(item) {
  const hero = $("#hero");
  if (!item || !item.backdrop) { hero.innerHTML = ""; return; }
  hero.style.backgroundImage = `url("${item.backdrop}")`;
  hero.innerHTML = `
    <div class="hero-content">
      <h1>${escapeHTML(item.title)}</h1>
      <p>${escapeHTML(item.overview || "")}</p>
      <div class="hero-buttons">
        <button class="btn" id="hero-play">▶ Play</button>
        <button class="btn-secondary" id="hero-info">More Info</button>
      </div>
    </div>`;
  $("#hero-play").addEventListener("click", () => openModal(item, { autoplay: true }));
  $("#hero-info").addEventListener("click", () => openModal(item));
}

// ---------- Pages ----------
async function showHome() {
  setActive("home");
  $("#rows").innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const [trending, popMovies, popTV, topMovies, topTV, anime] = await Promise.all([
      tmdb("/trending/all/week"),
      tmdb("/movie/popular"),
      tmdb("/tv/popular"),
      tmdb("/movie/top_rated"),
      tmdb("/tv/top_rated"),
      anilistTrending().catch(() => []),
    ]);
    const trendingItems = trending.results.map(r => normalizeTMDB(r));
    renderHero(trendingItems.find(t => t.backdrop) || trendingItems[0]);

    const rows = $("#rows");
    rows.innerHTML = "";

    const continueItems = getContinueWatching();
    if (continueItems.length) rows.appendChild(renderRow("Continue Watching", continueItems, { showProgress: true }));
    if (myList.length) rows.appendChild(renderRow("My List", myList));

    rows.appendChild(renderRow("Trending This Week", trendingItems));
    rows.appendChild(renderRow("Popular Movies", popMovies.results.map(r => normalizeTMDB(r, "movie"))));
    rows.appendChild(renderRow("Popular TV Shows", popTV.results.map(r => normalizeTMDB(r, "tv"))));
    rows.appendChild(renderRow("Trending Anime", anime));
    rows.appendChild(renderRow("Top Rated Movies", topMovies.results.map(r => normalizeTMDB(r, "movie"))));
    rows.appendChild(renderRow("Top Rated TV Shows", topTV.results.map(r => normalizeTMDB(r, "tv"))));
  } catch (e) {
    $("#rows").innerHTML = `<div class="empty" style="padding:40px 48px">${escapeHTML(e.message)}</div>`;
  }
}

async function showCategory(type) {
  setActive(type);
  $("#hero").innerHTML = ""; $("#hero").style.backgroundImage = "";
  $("#rows").innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    if (type === "anime") {
      const items = await anilistTrending();
      $("#rows").innerHTML = "";
      $("#rows").appendChild(renderRow("Trending Anime", items));
      return;
    }
    const [popular, topRated, nowOrAir] = await Promise.all([
      tmdb(`/${type}/popular`),
      tmdb(`/${type}/top_rated`),
      tmdb(type === "movie" ? "/movie/now_playing" : "/tv/on_the_air"),
    ]);
    $("#rows").innerHTML = "";
    $("#rows").appendChild(renderRow(type === "movie" ? "Now Playing" : "On The Air",
      nowOrAir.results.map(r => normalizeTMDB(r, type))));
    $("#rows").appendChild(renderRow("Popular", popular.results.map(r => normalizeTMDB(r, type))));
    $("#rows").appendChild(renderRow("Top Rated", topRated.results.map(r => normalizeTMDB(r, type))));
  } catch (e) {
    $("#rows").innerHTML = `<div class="empty" style="padding:40px 48px">${escapeHTML(e.message)}</div>`;
  }
}

function showMyList() {
  setActive("mylist");
  $("#hero").innerHTML = ""; $("#hero").style.backgroundImage = "";
  $("#rows").innerHTML = "";
  if (!myList.length) {
    $("#rows").innerHTML = `<div class="empty" style="padding:60px 48px">Your list is empty. Tap "+ My List" on any title to save it here.</div>`;
    return;
  }
  $("#rows").appendChild(renderRow("My List", myList));
  const continueItems = getContinueWatching();
  if (continueItems.length) $("#rows").appendChild(renderRow("Continue Watching", continueItems, { showProgress: true }));
}

async function searchAll(query) {
  setActive(null);
  $("#hero").innerHTML = ""; $("#hero").style.backgroundImage = "";
  $("#rows").innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const data = await tmdb("/search/multi", { query });
    const items = data.results
      .filter(r => r.media_type === "movie" || r.media_type === "tv")
      .map(r => normalizeTMDB(r));
    $("#rows").innerHTML = "";
    $("#rows").appendChild(renderRow(`Search: "${query}"`, items));
  } catch (e) {
    $("#rows").innerHTML = `<div class="empty" style="padding:40px 48px">${escapeHTML(e.message)}</div>`;
  }
}

function setActive(nav) {
  $$("#navbar nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === nav));
}

// ---------- Modal / Player ----------
let currentItem = null;
let currentSeasonData = null;

async function openModal(item, opts = {}) {
  currentItem = item;
  $("#modal").classList.remove("hidden");
  $("#modal-title").textContent = item.title;
  $("#modal-year").textContent = item.year || "";
  $("#modal-rating").textContent = item.rating ? `★ ${item.rating}` : "";
  $("#modal-runtime").textContent = "";
  $("#modal-overview").textContent = item.overview || "";
  $("#player-wrap").innerHTML = "";
  $("#episode-picker").classList.add("hidden");
  document.body.style.overflow = "hidden";
  updateListButton();

  if (item.type === "movie" || (item.type === "anime" && item.isMovie)) {
    if (opts.autoplay) startPlayer(item);
    else {
      $("#player-wrap").innerHTML = posterPlayButton(item);
      $("#player-wrap .play-btn").addEventListener("click", () => startPlayer(item));
    }
    if (item.type === "movie") {
      try {
        const details = await tmdb(`/movie/${item.id}`);
        if (details.runtime) $("#modal-runtime").textContent = `${details.runtime} min`;
      } catch {}
    }
  } else if (item.type === "tv") {
    await setupTVPicker(item);
    $("#player-wrap").innerHTML = posterPlayButton(item);
    $("#player-wrap .play-btn").addEventListener("click", () => playEpisode());
    if (opts.autoplay) playEpisode();
  } else if (item.type === "anime") {
    await setupAnimePicker(item);
    $("#player-wrap").innerHTML = posterPlayButton(item);
    $("#player-wrap .play-btn").addEventListener("click", () => playEpisode());
    if (opts.autoplay) playEpisode();
  }
}

function posterPlayButton(item) {
  const bg = item.backdrop || item.poster || "";
  return `
    <div style="position:absolute;inset:0;background:#000 url('${bg}') center/cover;display:flex;align-items:center;justify-content:center;">
      <button class="btn play-btn" style="font-size:18px;padding:14px 28px;">▶ Play</button>
    </div>`;
}

async function setupTVPicker(item) {
  $("#episode-picker").classList.remove("hidden");
  const seasonSel = $("#season-select");
  const epSel = $("#episode-select");
  seasonSel.innerHTML = `<option>Loading…</option>`;
  epSel.innerHTML = "";
  try {
    const details = await tmdb(`/tv/${item.id}`);
    const seasons = details.seasons.filter(s => s.season_number > 0 && s.episode_count > 0);
    seasonSel.innerHTML = seasons.map(s => `<option value="${s.season_number}">Season ${s.season_number}</option>`).join("");

    const last = progressMap[progressKey(item)];
    if (last?.season) seasonSel.value = last.season;

    const loadEpisodes = async () => {
      const sNum = +seasonSel.value;
      const sd = await tmdb(`/tv/${item.id}/season/${sNum}`);
      currentSeasonData = sd;
      epSel.innerHTML = sd.episodes.map(ep =>
        `<option value="${ep.episode_number}">E${ep.episode_number} — ${escapeHTML(ep.name || "")}</option>`).join("");
      if (last?.season === sNum && last.episode) epSel.value = last.episode;
    };
    seasonSel.addEventListener("change", loadEpisodes);
    await loadEpisodes();
  } catch (e) {
    seasonSel.innerHTML = `<option>Error</option>`;
  }
}

async function setupAnimePicker(item) {
  if (!item.episodes || item.episodes <= 1) return;
  $("#episode-picker").classList.remove("hidden");
  const seasonSel = $("#season-select");
  const epSel = $("#episode-select");
  seasonSel.innerHTML = `<option value="1">All Episodes</option>`;
  seasonSel.disabled = true;
  epSel.innerHTML = "";
  for (let i = 1; i <= item.episodes; i++) epSel.innerHTML += `<option value="${i}">Episode ${i}</option>`;
  const last = progressMap[progressKey(item)];
  if (last?.episode) epSel.value = last.episode;
}

$("#play-episode").addEventListener("click", () => playEpisode());

function playEpisode() {
  if (!currentItem) return;
  const ep = +$("#episode-select").value;
  const season = +$("#season-select").value;
  startPlayer(currentItem, { season, episode: ep });
}

function startPlayer(item, ctx = {}) {
  const url = buildPlayerURL(item, ctx);
  $("#player-wrap").innerHTML = `<iframe src="${url}"
    allow="encrypted-media; autoplay; fullscreen; picture-in-picture"
    allowfullscreen
    referrerpolicy="no-referrer"></iframe>`;
}

function buildPlayerURL(item, ctx = {}) {
  const params = new URLSearchParams();
  params.set("color", PLAYER_COLOR);
  params.set("nextEpisode", "true");
  params.set("episodeSelector", "true");
  params.set("autoplayNextEpisode", "true");
  params.set("overlay", "true");

  const last = progressMap[progressKey(item, ctx)];
  if (last?.timestamp) params.set("progress", Math.floor(last.timestamp));

  let path;
  if (item.type === "movie") path = `/movie/${item.id}`;
  else if (item.type === "tv") path = `/tv/${item.id}/${ctx.season || 1}/${ctx.episode || 1}`;
  else if (item.type === "anime") {
    path = item.isMovie ? `/anime/${item.id}` : `/anime/${item.id}/${ctx.episode || 1}`;
  }
  return `${PLAYER_BASE}${path}?${params.toString()}`;
}

function closeModal() {
  $("#modal").classList.add("hidden");
  $("#player-wrap").innerHTML = "";
  document.body.style.overflow = "";
  currentItem = null;
}
$(".modal-close").addEventListener("click", closeModal);
$(".modal-backdrop").addEventListener("click", closeModal);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

// ---------- My List ----------
function updateListButton() {
  if (!currentItem) return;
  const inList = myList.some(x => x.id === currentItem.id && x.type === currentItem.type);
  $("#add-list").textContent = inList ? "✓ In My List" : "+ My List";
}
$("#add-list").addEventListener("click", () => {
  if (!currentItem) return;
  const idx = myList.findIndex(x => x.id === currentItem.id && x.type === currentItem.type);
  if (idx >= 0) myList.splice(idx, 1);
  else myList.push({
    id: currentItem.id, type: currentItem.type, title: currentItem.title,
    poster: currentItem.poster, backdrop: currentItem.backdrop, overview: currentItem.overview,
    year: currentItem.year, rating: currentItem.rating,
    isMovie: currentItem.isMovie, episodes: currentItem.episodes,
  });
  saveJSON(STORAGE.list, myList);
  updateListButton();
});

// ---------- Watch Progress (postMessage from Videasy) ----------
window.addEventListener("message", (event) => {
  let data = event.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return; }
  }
  if (!data || typeof data !== "object") return;
  if (data.id == null || !data.type) return;
  if (!currentItem) return;

  const key = progressKey(currentItem, { season: data.season, episode: data.episode });
  progressMap[key] = {
    progress: data.progress,
    timestamp: data.timestamp,
    duration: data.duration,
    season: data.season,
    episode: data.episode,
    updatedAt: Date.now(),
    title: currentItem.title,
    poster: currentItem.poster,
    backdrop: currentItem.backdrop,
    overview: currentItem.overview,
    year: currentItem.year,
    rating: currentItem.rating,
    itemType: currentItem.type,
    itemId: currentItem.id,
    isMovie: currentItem.isMovie,
    episodes: currentItem.episodes,
  };
  saveJSON(STORAGE.progress, progressMap);
});

function progressKey(item, ctx = {}) {
  // For TV/anime episodes, store progress per-episode key but also a "latest" pointer
  return `${item.type}:${item.id}`;
}

function getContinueWatching() {
  return Object.entries(progressMap)
    .filter(([, v]) => v.progress > 1 && v.progress < 95)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, 20)
    .map(([, v]) => ({
      id: v.itemId, type: v.itemType, title: v.title,
      poster: v.poster, backdrop: v.backdrop, overview: v.overview,
      year: v.year, rating: v.rating, isMovie: v.isMovie, episodes: v.episodes,
    }));
}

// ---------- Nav wiring ----------
$$("#navbar [data-nav]").forEach(a => {
  a.addEventListener("click", e => {
    e.preventDefault();
    const nav = a.dataset.nav;
    if (nav === "home") showHome();
    else if (nav === "movies") showCategory("movie");
    else if (nav === "tv") showCategory("tv");
    else if (nav === "anime") showCategory("anime");
    else if (nav === "mylist") showMyList();
  });
});

let searchTimer;
$("#search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { showHome(); return; }
  searchTimer = setTimeout(() => searchAll(q), 350);
});

window.addEventListener("scroll", () => {
  $("#navbar").classList.toggle("scrolled", window.scrollY > 20);
});

// ---------- Boot ----------
showHome();
