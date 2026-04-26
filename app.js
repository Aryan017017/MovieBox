// =========================================================================
// CONFIG
// =========================================================================
const TMDB_API_KEY = "ebc17fdd2c491ffd1d0cbac7000be592";
const PLAYER_COLOR = "E50914";
// =========================================================================

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const PLAYER_BASE = "https://player.videasy.net";
const YT = "https://www.youtube.com/embed/";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const PROFILES = [
  { name: "Aryan",  color: "#e50914", initial: "A" },
  { name: "Family", color: "#0080ff", initial: "F" },
  { name: "Kids",   color: "#f5c518", initial: "K" },
  { name: "Guest",  color: "#46d369", initial: "G" },
];

const GENRES_MOVIE = [
  { id: 28,    name: "Action" },
  { id: 35,    name: "Comedy" },
  { id: 27,    name: "Horror" },
  { id: 878,   name: "Sci-Fi" },
  { id: 10749, name: "Romance" },
  { id: 99,    name: "Documentaries" },
  { id: 53,    name: "Thrillers" },
  { id: 16,    name: "Animated Films" },
];

// ---------- Storage ----------
const STORAGE = {
  progress: "moviebox:progress",
  list: "moviebox:mylist",
  profile: "moviebox:profile",
};
const loadJSON = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) || f; } catch { return f; } };
const saveJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
let progressMap = loadJSON(STORAGE.progress, {});
let myList = loadJSON(STORAGE.list, []);
let activeProfile = loadJSON(STORAGE.profile, null);

// ---------- TMDB ----------
const tmdbCache = new Map();
async function tmdb(path, params = {}) {
  const key = path + JSON.stringify(params);
  if (tmdbCache.has(key)) return tmdbCache.get(key);
  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "en-US");
  url.searchParams.set("include_image_language", "en,null");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  const json = await r.json();
  tmdbCache.set(key, json);
  return json;
}

// ---------- AniList ----------
async function anilistTrending() {
  const query = `
    query {
      Page(perPage: 20) {
        media(type: ANIME, sort: TRENDING_DESC, format_in: [TV, MOVIE]) {
          id title { romaji english } coverImage { large extraLarge }
          bannerImage description(asHtml: false) format episodes averageScore startDate { year }
          genres trailer { id site }
        }
      }
    }`;
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = await r.json();
  return data.data.Page.media.map(m => ({
    id: m.id, type: "anime",
    title: m.title.english || m.title.romaji,
    poster: m.coverImage.extraLarge || m.coverImage.large,
    backdrop: m.bannerImage || m.coverImage.extraLarge,
    overview: (m.description || "").replace(/<[^>]+>/g, ""),
    year: m.startDate?.year,
    rating: m.averageScore ? (m.averageScore / 10).toFixed(1) : null,
    episodes: m.episodes,
    isMovie: m.format === "MOVIE",
    genres: m.genres,
    trailerKey: m.trailer?.site === "youtube" ? m.trailer.id : null,
  }));
}

// ---------- Normalizers ----------
function normalizeTMDB(item, forcedType) {
  const type = forcedType || (item.media_type === "tv" ? "tv" : item.media_type === "movie" ? "movie" : "movie");
  return {
    id: item.id,
    type,
    title: item.title || item.name,
    poster: item.poster_path ? `${IMG}/w500${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${IMG}/original${item.backdrop_path}` : null,
    backdropMd: item.backdrop_path ? `${IMG}/w780${item.backdrop_path}` : null,
    overview: item.overview,
    year: (item.release_date || item.first_air_date || "").slice(0, 4),
    rating: item.vote_average ? item.vote_average.toFixed(1) : null,
    voteCount: item.vote_count,
  };
}

function pseudoMatch(item) {
  const r = parseFloat(item.rating || 0);
  return Math.min(98, Math.max(60, Math.round(r * 10)));
}

function pseudoAge(item) {
  const r = parseFloat(item.rating || 0);
  if (r >= 8) return "16+";
  if (r >= 7) return "13+";
  if (r >= 6) return "PG";
  return "All";
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// ---------- Cards & Rows ----------
function makeCard(item, opts = {}) {
  const card = document.createElement("div");
  card.className = "card";
  const bg = item.backdropMd || item.backdrop || item.poster;
  if (bg) card.style.backgroundImage = `url("${bg}")`;
  const key = progressKey(item);
  const p = progressMap[key];
  const progressBar = (opts.showProgress && p?.progress)
    ? `<div class="progress-bar"><div style="width:${Math.min(100, Math.round(p.progress))}%"></div></div>` : "";
  card.innerHTML = `
    ${progressBar}
    <div class="card-info">
      <div class="row1">
        <div class="play-mini">▶</div>
        <div class="add-mini">+</div>
      </div>
      <div class="row2">
        <span class="match">${pseudoMatch(item)}% Match</span>
        <span class="age-mini">${pseudoAge(item)}</span>
        <span>${item.year || ""}</span>
      </div>
      <div class="title">${escapeHTML(item.title || "")}</div>
    </div>`;
  card.addEventListener("click", () => openModal(item));
  card.querySelector(".play-mini")?.addEventListener("click", (e) => { e.stopPropagation(); openModal(item); });
  card.querySelector(".add-mini")?.addEventListener("click", (e) => { e.stopPropagation(); toggleList(item); });

  let hoverTimer;
  card.addEventListener("mouseenter", () => {
    hoverTimer = setTimeout(async () => {
      try {
        const key = await fetchTrailerKey(item);
        if (!key || !card.matches(":hover")) return;
        if (card.querySelector(".card-trailer")) return;
        const wrap = document.createElement("div");
        wrap.className = "card-trailer";
        const renderTrailer = () => {
          wrap.innerHTML = `
            <iframe src="${YT}${key}?autoplay=1&mute=${cardMuted ? 1 : 0}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${key}&disablekb=1&vq=hd1080&hd=1" allow="autoplay; encrypted-media"></iframe>
            <button class="card-mute" title="${cardMuted ? "Unmute" : "Mute"}">${cardMuted ? "🔇" : "🔊"}</button>`;
          wrap.querySelector(".card-mute").addEventListener("click", (e) => {
            e.stopPropagation();
            cardMuted = !cardMuted;
            renderTrailer();
          });
        };
        renderTrailer();
        card.appendChild(wrap);
      } catch {}
    }, 600);
  });
  card.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    card.querySelector(".card-trailer")?.remove();
  });
  return card;
}

function makeTop10Card(item, rank) {
  const card = document.createElement("div");
  card.className = "top10-card";
  const bg = item.poster || item.backdrop;
  card.innerHTML = `
    <div class="top10-number">${rank}</div>
    <div class="top10-poster" style="background-image:url('${bg}')"></div>`;
  card.addEventListener("click", () => openModal(item));
  return card;
}

function renderRow(title, items, opts = {}) {
  const row = document.createElement("section");
  row.className = "row" + (opts.top10 ? " top10" : "");
  row.innerHTML = `<h2>${escapeHTML(title)}</h2><div class="row-wrap"></div>`;
  const wrap = $(".row-wrap", row);
  if (!items || items.length === 0) {
    wrap.innerHTML = `<div class="empty">Nothing here yet.</div>`;
    return row;
  }
  const scroll = document.createElement("div");
  scroll.className = "row-scroll";
  items.forEach((it, i) => {
    if (!it) return;
    if (opts.top10) scroll.appendChild(makeTop10Card(it, i + 1));
    else if (it.poster || it.backdrop) scroll.appendChild(makeCard(it, opts));
  });
  wrap.appendChild(scroll);

  const left = document.createElement("button"); left.className = "row-arrow left"; left.innerHTML = "‹";
  const right = document.createElement("button"); right.className = "row-arrow right"; right.innerHTML = "›";
  left.addEventListener("click", () => scroll.scrollBy({ left: -scroll.clientWidth * 0.85, behavior: "smooth" }));
  right.addEventListener("click", () => scroll.scrollBy({ left: scroll.clientWidth * 0.85, behavior: "smooth" }));
  wrap.appendChild(left); wrap.appendChild(right);
  return row;
}

function skeletonRow() {
  const div = document.createElement("div");
  div.className = "skeleton-row";
  div.innerHTML = `<div class="sk-title"></div><div class="sk-cards">${"<div class='sk-card'></div>".repeat(7)}</div>`;
  return div;
}

// ---------- Hero (with auto-trailer) ----------
let heroMuted = true;
let heroItem = null;
let cardMuted = true;

async function renderHero(item) {
  heroItem = item;
  const bg = $("#hero-bg");
  const trailerEl = $("#hero-trailer");
  bg.style.backgroundImage = item.backdrop ? `url("${item.backdrop}")` : "";
  trailerEl.innerHTML = "";

  const match = pseudoMatch(item);
  const age = pseudoAge(item);
  $("#hero-age").textContent = age;
  $("#hero-content").innerHTML = `
    <h1>${escapeHTML(item.title)}</h1>
    <div class="badges">
      <span class="match">${match}% Match</span>
      <span>${item.year || ""}</span>
    </div>
    <p>${escapeHTML(item.overview || "")}</p>
    <div class="hero-buttons">
      <button class="btn" id="hero-play">▶ Play</button>
      <button class="btn-secondary" id="hero-info">ⓘ More Info</button>
    </div>`;
  $("#hero-play").addEventListener("click", () => openModal(item));
  $("#hero-info").addEventListener("click", () => openModal(item));

  // Try to fetch trailer
  try {
    const key = await fetchTrailerKey(item);
    if (key) {
      const muteParam = heroMuted ? 1 : 0;
      trailerEl.innerHTML = `<iframe src="${YT}${key}?autoplay=1&mute=${muteParam}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${key}&disablekb=1&vq=hd1080&hd=1" allow="autoplay; encrypted-media"></iframe>`;
    }
  } catch {}
}

async function fetchTrailerKey(item) {
  if (item.type === "anime") return item.trailerKey;
  const path = item.type === "tv" ? `/tv/${item.id}/videos` : `/movie/${item.id}/videos`;
  const data = await tmdb(path);
  const trailer = data.results.find(v => v.site === "YouTube" && v.type === "Trailer") ||
                  data.results.find(v => v.site === "YouTube");
  return trailer?.key;
}

$("#mute-btn").addEventListener("click", () => {
  heroMuted = !heroMuted;
  $("#mute-btn").textContent = heroMuted ? "🔇" : "🔊";
  if (heroItem) renderHero(heroItem);
});

function stopHeroTrailer() {
  $("#hero-trailer").innerHTML = "";
  heroItem = null;
}

// Pause hero audio when scrolled out of view
const heroObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!heroItem) return;
    const iframe = $("#hero-trailer iframe");
    if (!iframe) return;
    if (!e.isIntersecting) {
      iframe.dataset.src = iframe.src;
      iframe.src = "";
    } else if (iframe.dataset.src && !iframe.src) {
      iframe.src = iframe.dataset.src;
    }
  });
}, { threshold: 0.2 });
heroObserver.observe($("#hero"));

// ---------- Pages ----------
async function showHome() {
  setActive("home");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = ""; for (let i = 0; i < 4; i++) rows.appendChild(skeletonRow());
  try {
    const [trending, popMovies, popTV, topMovies, anime, trendingDay] = await Promise.all([
      tmdb("/trending/all/week"),
      tmdb("/movie/popular"),
      tmdb("/tv/popular"),
      tmdb("/movie/top_rated"),
      anilistTrending().catch(() => []),
      tmdb("/trending/all/day"),
    ]);
    const trendingItems = trending.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r));
    const heroPick = trendingItems.find(t => t.backdrop && t.overview) || trendingItems[0];
    renderHero(heroPick);

    rows.innerHTML = "";

    const continueItems = getContinueWatching();
    if (continueItems.length) rows.appendChild(renderRow("Continue Watching", continueItems, { showProgress: true }));
    if (myList.length) rows.appendChild(renderRow("My List", myList));

    rows.appendChild(renderRow("Trending Now", trendingItems));
    rows.appendChild(renderRow(`Top 10 Today`, trendingDay.results.slice(0, 10).map(r => normalizeTMDB(r)), { top10: true }));
    rows.appendChild(renderRow("Popular Movies", popMovies.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie"))));
    rows.appendChild(renderRow("Popular TV Shows", popTV.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "tv"))));
    rows.appendChild(renderRow("Trending Anime", anime));
    rows.appendChild(renderRow("Critically Acclaimed Movies", topMovies.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie"))));

    // Genre rows (lazy after main content)
    for (const g of GENRES_MOVIE.slice(0, 5)) {
      const data = await tmdb("/discover/movie", { with_genres: g.id, sort_by: "popularity.desc" });
      rows.appendChild(renderRow(g.name, data.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie"))));
    }
  } catch (e) {
    rows.innerHTML = `<div class="empty">${escapeHTML(e.message)}</div>`;
  }
}

async function showCategory(type) {
  setActive(type);
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = ""; for (let i = 0; i < 3; i++) rows.appendChild(skeletonRow());
  try {
    if (type === "anime") {
      const items = await anilistTrending();
      renderHero(items.find(i => i.backdrop) || items[0]);
      rows.innerHTML = "";
      rows.appendChild(renderRow("Trending Anime", items));
      return;
    }
    const [popular, topRated, nowOrAir, trending] = await Promise.all([
      tmdb(`/${type}/popular`),
      tmdb(`/${type}/top_rated`),
      tmdb(type === "movie" ? "/movie/now_playing" : "/tv/on_the_air"),
      tmdb(`/trending/${type}/week`),
    ]);
    const trendItems = trending.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type));
    renderHero(trendItems.find(i => i.backdrop) || trendItems[0]);
    rows.innerHTML = "";
    rows.appendChild(renderRow("Trending This Week", trendItems));
    rows.appendChild(renderRow("Top 10 in " + (type === "tv" ? "TV" : "Movies"), trendItems.slice(0, 10), { top10: true }));
    rows.appendChild(renderRow(type === "movie" ? "Now Playing" : "Currently Airing", nowOrAir.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type))));
    rows.appendChild(renderRow("Popular", popular.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type))));
    rows.appendChild(renderRow("Top Rated", topRated.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type))));

    if (type === "movie") {
      for (const g of GENRES_MOVIE) {
        const data = await tmdb("/discover/movie", { with_genres: g.id, sort_by: "popularity.desc" });
        rows.appendChild(renderRow(g.name, data.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie"))));
      }
    }
  } catch (e) {
    rows.innerHTML = `<div class="empty">${escapeHTML(e.message)}</div>`;
  }
}

async function showNewPopular() {
  setActive("new");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = ""; for (let i = 0; i < 3; i++) rows.appendChild(skeletonRow());
  try {
    const [upMovies, upTV, trending, latestMovies] = await Promise.all([
      tmdb("/movie/upcoming"),
      tmdb("/tv/airing_today"),
      tmdb("/trending/all/day"),
      tmdb("/discover/movie", { sort_by: "primary_release_date.desc", "primary_release_date.lte": new Date().toISOString().slice(0,10), "vote_count.gte": 50 }),
    ]);
    const trendItems = trending.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r));
    renderHero(trendItems.find(i => i.backdrop) || trendItems[0]);
    rows.innerHTML = "";
    rows.appendChild(renderRow("🔥 Trending Today", trendItems));
    rows.appendChild(renderRow("Top 10 Today", trendItems.slice(0, 10), { top10: true }));
    rows.appendChild(renderRow("Coming Soon (Movies)", upMovies.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie"))));
    rows.appendChild(renderRow("Airing Today (TV)", upTV.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "tv"))));
    rows.appendChild(renderRow("Newly Released", latestMovies.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, "movie"))));
  } catch (e) { rows.innerHTML = `<div class="empty">${escapeHTML(e.message)}</div>`; }
}

function showMyList() {
  setActive("mylist");
  $("#hero-bg").style.backgroundImage = ""; $("#hero-content").innerHTML = "";
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = "";
  if (!myList.length) {
    rows.innerHTML = `<div class="empty" style="padding:120px 4%; text-align:center;">Your list is empty. Tap the + button on any title to save it here.</div>`;
    return;
  }
  rows.appendChild(renderRow("My List", myList));
  const c = getContinueWatching();
  if (c.length) rows.appendChild(renderRow("Continue Watching", c, { showProgress: true }));
}

async function searchAll(query) {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="search-header">Searching for <strong>"${escapeHTML(query)}"</strong>…</div>`;
  try {
    const data = await tmdb("/search/multi", { query });
    const items = data.results
      .filter(r => (r.media_type === "movie" || r.media_type === "tv") && r.backdrop_path && r.poster_path)
      .map(r => normalizeTMDB(r));
    rows.innerHTML = "";
    if (!items.length) {
      rows.innerHTML = `
        <div class="search-header">Your search for <strong>"${escapeHTML(query)}"</strong> did not have any matches.</div>
        <div class="empty" style="text-align:center; padding:40px 4%;">Suggestions:<br><br>· Try different keywords<br>· Look for a movie, TV show or person<br>· Try a more general keyword</div>`;
      return;
    }
    rows.innerHTML = `<div class="search-header">Top results for <strong>"${escapeHTML(query)}"</strong></div>`;
    const grid = document.createElement("div");
    grid.className = "search-grid";
    items.forEach(it => {
      const cell = document.createElement("div");
      cell.className = "search-cell";
      cell.appendChild(makeCard(it));
      const meta = document.createElement("div");
      meta.className = "search-meta";
      meta.innerHTML = `<span class="type-pill">${it.type === "tv" ? "Series" : "Movie"}</span><span>${it.year || ""}</span><span>${pseudoMatch(it)}% Match</span>`;
      const title = document.createElement("div");
      title.className = "search-title";
      title.textContent = it.title;
      cell.appendChild(title);
      cell.appendChild(meta);
      grid.appendChild(cell);
    });
    rows.appendChild(grid);
  } catch (e) { rows.innerHTML = `<div class="empty">${escapeHTML(e.message)}</div>`; }
}

function setActive(nav) {
  $$("#navbar nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === nav));
}

// ---------- Modal ----------
let currentItem = null;
let modalMuted = true;
let currentSeason = null;
let modalDetails = null;

async function openModal(item, opts = {}) {
  currentItem = item;
  modalDetails = null;
  $("#modal").classList.remove("hidden");
  $("#modal").scrollTop = 0;
  document.body.style.overflow = "hidden";
  // Pause hero audio so it doesn't fight the modal trailer
  const heroIframe = $("#hero-trailer iframe");
  if (heroIframe) { heroIframe.dataset.src = heroIframe.src; heroIframe.src = ""; }

  const bg = item.backdrop || item.poster;
  $("#modal-bg").style.backgroundImage = bg ? `url("${bg}")` : "";
  $("#modal-trailer").innerHTML = "";
  $("#player-wrap").innerHTML = ""; $("#player-wrap").classList.remove("active");
  $(".modal-body").classList.remove("playing");
  $("#modal-title").textContent = item.title;
  $("#modal-match").textContent = `${pseudoMatch(item)}% Match`;
  $("#modal-year").textContent = item.year || "";
  $("#modal-age").textContent = pseudoAge(item);
  $("#modal-runtime").textContent = "";
  $("#modal-overview").textContent = item.overview || "";
  $("#modal-cast").textContent = "Loading…";
  $("#modal-genres").textContent = (item.genres || []).join(", ");
  $("#episode-section").classList.add("hidden");
  $("#similar-section").classList.add("hidden");
  $("#similar-grid").innerHTML = "";
  updateListButton();

  // Trailer in modal hero
  try {
    const key = await fetchTrailerKey(item);
    if (key) {
      $("#modal-trailer").innerHTML = `<iframe src="${YT}${key}?autoplay=1&mute=${modalMuted ? 1 : 0}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${key}&disablekb=1&vq=hd1080&hd=1" allow="autoplay; encrypted-media"></iframe>`;
    }
  } catch {}

  // Details: cast, runtime, genres, similar
  if (item.type === "movie" || item.type === "tv") {
    try {
      const detailsPath = item.type === "movie" ? `/movie/${item.id}` : `/tv/${item.id}`;
      const [details, credits, similar] = await Promise.all([
        tmdb(detailsPath),
        tmdb(detailsPath + "/credits").catch(() => ({ cast: [] })),
        tmdb(detailsPath + "/similar").catch(() => ({ results: [] })),
      ]);
      modalDetails = details;
      if (details.runtime) $("#modal-runtime").textContent = `${details.runtime} min`;
      else if (details.episode_run_time?.[0]) $("#modal-runtime").textContent = `${details.episode_run_time[0]} min`;
      else if (details.number_of_seasons) $("#modal-runtime").textContent = `${details.number_of_seasons} Season${details.number_of_seasons > 1 ? "s" : ""}`;
      $("#modal-cast").textContent = credits.cast.slice(0, 4).map(c => c.name).join(", ") || "—";
      $("#modal-genres").textContent = (details.genres || []).map(g => g.name).join(", ");

      // Similar
      const simItems = similar.results.slice(0, 9).map(r => normalizeTMDB(r, item.type));
      if (simItems.length) {
        $("#similar-section").classList.remove("hidden");
        const grid = $("#similar-grid"); grid.innerHTML = "";
        simItems.forEach(s => grid.appendChild(makeSimilarCard(s)));
      }

      // Episodes for TV
      if (item.type === "tv") {
        $("#episode-section").classList.remove("hidden");
        const seasons = details.seasons.filter(s => s.season_number > 0 && s.episode_count > 0);
        const sel = $("#season-select");
        sel.innerHTML = seasons.map(s => `<option value="${s.season_number}">Season ${s.season_number}</option>`).join("");
        const last = progressMap[progressKey(item)];
        if (last?.season) sel.value = last.season;
        sel.onchange = () => loadEpisodes(item.id, +sel.value);
        await loadEpisodes(item.id, +sel.value);
      }
    } catch {}
  } else if (item.type === "anime") {
    if (!item.isMovie && item.episodes && item.episodes > 1) {
      $("#episode-section").classList.remove("hidden");
      const sel = $("#season-select");
      sel.innerHTML = `<option value="1">Episodes</option>`;
      sel.disabled = true;
      const list = $("#episode-list"); list.innerHTML = "";
      const last = progressMap[progressKey(item)];
      for (let i = 1; i <= item.episodes; i++) {
        const ep = document.createElement("div");
        ep.className = "episode-item";
        const isCurrent = last?.episode === i;
        ep.innerHTML = `
          <div class="episode-num">${i}</div>
          <div class="episode-thumb" style="background-image:url('${item.poster || ""}')">${isCurrent && last.progress ? `<div class="ep-progress"><div style="width:${Math.min(100, Math.round(last.progress))}%"></div></div>` : ""}</div>
          <div class="episode-info">
            <div class="ep-head"><span class="ep-title">Episode ${i}</span></div>
            <div class="ep-overview"></div>
          </div>`;
        ep.addEventListener("click", () => startPlayer(item, { episode: i }));
        list.appendChild(ep);
      }
    }
  }

  if (opts.autoplay) startPlayer(item);
}

async function loadEpisodes(tvId, seasonNum) {
  currentSeason = seasonNum;
  const list = $("#episode-list");
  list.innerHTML = `<div class="empty" style="padding:24px 0">Loading episodes…</div>`;
  try {
    const sd = await tmdb(`/tv/${tvId}/season/${seasonNum}`);
    list.innerHTML = "";
    const last = progressMap[progressKey(currentItem)];
    sd.episodes.forEach(ep => {
      const isCurrent = last?.season === seasonNum && last.episode === ep.episode_number;
      const div = document.createElement("div");
      div.className = "episode-item";
      const thumb = ep.still_path ? `${IMG}/w300${ep.still_path}` : (currentItem.backdrop || "");
      div.innerHTML = `
        <div class="episode-num">${ep.episode_number}</div>
        <div class="episode-thumb" style="background-image:url('${thumb}')">${isCurrent && last.progress ? `<div class="ep-progress"><div style="width:${Math.min(100, Math.round(last.progress))}%"></div></div>` : ""}</div>
        <div class="episode-info">
          <div class="ep-head">
            <span class="ep-title">${escapeHTML(ep.name || "Episode " + ep.episode_number)}</span>
            <span class="ep-runtime">${ep.runtime ? ep.runtime + "m" : ""}</span>
          </div>
          <div class="ep-overview">${escapeHTML(ep.overview || "")}</div>
        </div>`;
      div.addEventListener("click", () => startPlayer(currentItem, { season: seasonNum, episode: ep.episode_number }));
      list.appendChild(div);
    });
  } catch {
    list.innerHTML = `<div class="empty">Could not load episodes.</div>`;
  }
}

function makeSimilarCard(item) {
  const div = document.createElement("div");
  div.className = "similar-card";
  const bg = item.backdropMd || item.backdrop || item.poster;
  div.innerHTML = `
    <div class="sim-img" style="background-image:url('${bg || ""}')"></div>
    <div class="sim-body">
      <div class="sim-meta">
        <span class="match">${pseudoMatch(item)}% Match</span>
        <span>${item.year || ""}</span>
      </div>
      <div class="sim-title">${escapeHTML(item.title)}</div>
      <div class="sim-overview">${escapeHTML(item.overview || "")}</div>
    </div>`;
  div.addEventListener("click", () => openModal(item));
  return div;
}

function startPlayer(item, ctx = {}) {
  const url = buildPlayerURL(item, ctx);
  $("#modal-trailer").innerHTML = ""; // stop trailer audio
  $(".modal-body").classList.add("playing");
  $("#player-wrap").classList.add("active");
  $("#player-wrap").innerHTML = `<iframe src="${url}"
    allow="encrypted-media; autoplay; fullscreen; picture-in-picture"
    allowfullscreen referrerpolicy="no-referrer"></iframe>`;
  $("#modal").scrollTop = 0;
}

function buildPlayerURL(item, ctx = {}) {
  const params = new URLSearchParams();
  params.set("color", PLAYER_COLOR);
  params.set("nextEpisode", "true");
  params.set("episodeSelector", "true");
  params.set("autoplayNextEpisode", "true");
  params.set("overlay", "true");

  const last = progressMap[progressKey(item)];
  if (last?.timestamp) params.set("progress", Math.floor(last.timestamp));

  let path;
  if (item.type === "movie") path = `/movie/${item.id}`;
  else if (item.type === "tv") path = `/tv/${item.id}/${ctx.season || 1}/${ctx.episode || 1}`;
  else if (item.type === "anime") path = item.isMovie ? `/anime/${item.id}` : `/anime/${item.id}/${ctx.episode || 1}`;
  return `${PLAYER_BASE}${path}?${params.toString()}`;
}

function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modal-trailer").innerHTML = "";
  $("#player-wrap").innerHTML = ""; $("#player-wrap").classList.remove("active");
  $(".modal-body").classList.remove("playing");
  document.body.style.overflow = "";
  currentItem = null;
  // Restore hero trailer if it was paused
  const heroIframe = $("#hero-trailer iframe");
  if (heroIframe && heroIframe.dataset.src && !heroIframe.src) heroIframe.src = heroIframe.dataset.src;
}
$(".modal-close").addEventListener("click", closeModal);
$(".modal-backdrop").addEventListener("click", closeModal);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

$("#hero-play-btn").addEventListener("click", () => {
  if (!currentItem) return;
  if (currentItem.type === "tv") {
    const last = progressMap[progressKey(currentItem)];
    startPlayer(currentItem, { season: last?.season || 1, episode: last?.episode || 1 });
  } else if (currentItem.type === "anime" && !currentItem.isMovie) {
    const last = progressMap[progressKey(currentItem)];
    startPlayer(currentItem, { episode: last?.episode || 1 });
  } else startPlayer(currentItem);
});

$("#modal-mute-btn").addEventListener("click", () => {
  modalMuted = !modalMuted;
  $("#modal-mute-btn").textContent = modalMuted ? "🔇" : "🔊";
  if (currentItem && !$("#player-wrap").classList.contains("active")) {
    fetchTrailerKey(currentItem).then(key => {
      if (key) $("#modal-trailer").innerHTML = `<iframe src="${YT}${key}?autoplay=1&mute=${modalMuted ? 1 : 0}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${key}&disablekb=1&vq=hd1080&hd=1" allow="autoplay; encrypted-media"></iframe>`;
    });
  }
});

// ---------- My List ----------
function toggleList(item) {
  const idx = myList.findIndex(x => x.id === item.id && x.type === item.type);
  if (idx >= 0) myList.splice(idx, 1);
  else myList.push({
    id: item.id, type: item.type, title: item.title,
    poster: item.poster, backdrop: item.backdrop, backdropMd: item.backdropMd,
    overview: item.overview, year: item.year, rating: item.rating,
    isMovie: item.isMovie, episodes: item.episodes,
  });
  saveJSON(STORAGE.list, myList);
  updateListButton();
}
function updateListButton() {
  if (!currentItem) return;
  const inList = myList.some(x => x.id === currentItem.id && x.type === currentItem.type);
  $("#add-list").textContent = inList ? "✓" : "+";
  $("#add-list").title = inList ? "Remove from My List" : "Add to My List";
}
$("#add-list").addEventListener("click", () => { if (currentItem) toggleList(currentItem); });

// ---------- Watch Progress ----------
window.addEventListener("message", (event) => {
  let data = event.data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
  if (!data || typeof data !== "object" || data.id == null || !data.type) return;
  if (!currentItem) return;
  progressMap[progressKey(currentItem)] = {
    progress: data.progress, timestamp: data.timestamp, duration: data.duration,
    season: data.season, episode: data.episode, updatedAt: Date.now(),
    title: currentItem.title, poster: currentItem.poster, backdrop: currentItem.backdrop, backdropMd: currentItem.backdropMd,
    overview: currentItem.overview, year: currentItem.year, rating: currentItem.rating,
    itemType: currentItem.type, itemId: currentItem.id,
    isMovie: currentItem.isMovie, episodes: currentItem.episodes,
  };
  saveJSON(STORAGE.progress, progressMap);
});
function progressKey(item) { return `${item.type}:${item.id}`; }
function getContinueWatching() {
  return Object.entries(progressMap)
    .filter(([, v]) => v.progress > 1 && v.progress < 95)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, 20)
    .map(([, v]) => ({
      id: v.itemId, type: v.itemType, title: v.title,
      poster: v.poster, backdrop: v.backdrop, backdropMd: v.backdropMd,
      overview: v.overview, year: v.year, rating: v.rating,
      isMovie: v.isMovie, episodes: v.episodes,
    }));
}

// ---------- Nav ----------
$$("#navbar [data-nav]").forEach(a => {
  a.addEventListener("click", e => {
    e.preventDefault();
    const nav = a.dataset.nav;
    $("#search").value = "";
    document.body.classList.remove("no-hero");
    if (nav === "home") showHome();
    else if (nav === "movies") showCategory("movie");
    else if (nav === "tv") showCategory("tv");
    else if (nav === "anime") showCategory("anime");
    else if (nav === "new") showNewPopular();
    else if (nav === "mylist") showMyList();
  });
});

let searchTimer;
$("#search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { document.body.classList.remove("no-hero"); showHome(); return; }
  searchTimer = setTimeout(() => searchAll(q), 350);
});

window.addEventListener("scroll", () => {
  $("#navbar").classList.toggle("scrolled", window.scrollY > 20);
});

// ---------- Profile ----------
function renderProfileScreen() {
  const list = $("#profile-list"); list.innerHTML = "";
  PROFILES.forEach(p => {
    const card = document.createElement("div");
    card.className = "profile-card";
    card.innerHTML = `
      <div class="avatar" style="background:${p.color}">${p.initial}</div>
      <div class="name">${p.name}</div>`;
    card.addEventListener("click", () => selectProfile(p));
    list.appendChild(card);
  });
}
function selectProfile(p) {
  activeProfile = p; saveJSON(STORAGE.profile, p);
  $("#profile-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#profile-avatar-mini").style.background = p.color;
  $("#profile-avatar-mini").textContent = p.initial;
  $("#profile-avatar-mini").style.cssText += `display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;`;
  showHome();
}
$("#profile-pill").addEventListener("click", e => {
  if (e.target.closest(".profile-menu")) return;
  $("#profile-pill").classList.toggle("open");
});
document.addEventListener("click", e => {
  if (!e.target.closest("#profile-pill")) $("#profile-pill").classList.remove("open");
});
$("#switch-profile").addEventListener("click", e => {
  e.preventDefault();
  $("#profile-pill").classList.remove("open");
  $("#app").classList.add("hidden");
  $("#profile-screen").classList.remove("hidden");
});
$("#clear-data").addEventListener("click", e => {
  e.preventDefault();
  if (confirm("Clear continue-watching and My List for this profile?")) {
    progressMap = {}; myList = [];
    saveJSON(STORAGE.progress, progressMap); saveJSON(STORAGE.list, myList);
    showHome();
  }
  $("#profile-pill").classList.remove("open");
});

// ---------- Boot ----------
renderProfileScreen();
if (activeProfile) selectProfile(activeProfile);
