// =========================================================================
// CONFIG
// =========================================================================
const TMDB_API_KEY = "ebc17fdd2c491ffd1d0cbac7000be592";
const PLAYER_COLOR = "E50914";
// Optional: deploy the Cloudflare Worker in /worker and put its URL here to
// route the player through a popup-shielding proxy. Leave "" to disable.
const PROXY_PLAYER_BASE = "";
// =========================================================================

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const PLAYER_BASE = PROXY_PLAYER_BASE || "https://player.videasy.net";
const YT = "https://www.youtube.com/embed/";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const DEFAULT_PROFILES = [
  { id: "p1", name: "Aryan",  color: "#e50914" },
  { id: "p2", name: "Family", color: "#0080ff" },
  { id: "p3", name: "Kids",   color: "#f5c518" },
  { id: "p4", name: "Guest",  color: "#46d369" },
];
const PROFILE_COLORS = ["#e50914","#0080ff","#f5c518","#46d369","#9333ea","#ec4899","#06b6d4","#f97316","#84cc16","#64748b"];
const STORAGE_PROFILES = "moviebox:profiles";
let PROFILES = []; // populated after storage helpers below
function saveProfiles() { saveJSON(STORAGE_PROFILES, PROFILES); }
function profileInitial(p) { return (p.name || "?").trim().charAt(0).toUpperCase(); }

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
  onboarded: "moviebox:onboarded",
};
const loadJSON = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) || f; } catch { return f; } };
const saveJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
let progressMap = loadJSON(STORAGE.progress, {});
let myList = loadJSON(STORAGE.list, []);
let activeProfile = loadJSON(STORAGE.profile, null);
PROFILES = loadJSON(STORAGE_PROFILES, DEFAULT_PROFILES);
if (!Array.isArray(PROFILES) || PROFILES.length === 0) PROFILES = [...DEFAULT_PROFILES];

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
function normalizeAnilist(m) {
  return {
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
  };
}
const ANILIST_FRAG = `
  id title { romaji english } coverImage { large extraLarge }
  bannerImage description(asHtml: false) format episodes averageScore
  startDate { year } genres trailer { id site }`;
async function anilistQuery(query, variables = {}) {
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await r.json()).data;
}
async function anilistTrending() {
  const d = await anilistQuery(`query { Page(perPage:20){ media(type:ANIME, sort:TRENDING_DESC, format_in:[TV,MOVIE]){${ANILIST_FRAG}} } }`);
  return d.Page.media.map(normalizeAnilist);
}
async function anilistTopRated() {
  const d = await anilistQuery(`query { Page(perPage:20){ media(type:ANIME, sort:SCORE_DESC, format_in:[TV,MOVIE]){${ANILIST_FRAG}} } }`);
  return d.Page.media.map(normalizeAnilist);
}
async function anilistSeasonal() {
  const month = new Date().getMonth() + 1;
  const season = month <= 3 ? "WINTER" : month <= 6 ? "SPRING" : month <= 9 ? "SUMMER" : "FALL";
  const year = new Date().getFullYear();
  const d = await anilistQuery(`query($s:MediaSeason,$y:Int){ Page(perPage:20){ media(type:ANIME, season:$s, seasonYear:$y, sort:POPULARITY_DESC){${ANILIST_FRAG}} } }`, { s: season, y: year });
  return { items: d.Page.media.map(normalizeAnilist), label: `${season[0] + season.slice(1).toLowerCase()} ${year}` };
}
async function anilistByGenre(genre) {
  const d = await anilistQuery(`query($g:String){ Page(perPage:20){ media(type:ANIME, genre:$g, sort:POPULARITY_DESC){${ANILIST_FRAG}} } }`, { g: genre });
  return d.Page.media.map(normalizeAnilist);
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

// ---------- Dominant-color extraction ----------
const colorCache = new Map();
function extractDominantColor(url) {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const W = 64, H = 64;
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, W, H);
        const data = ctx.getImageData(0, 0, W, H).data;
        // Quantize into 4-bit-per-channel buckets, pick the most-vibrant common bucket
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 200) continue;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max - min;
          // Skip near-black, near-white, and grayscale pixels
          if (max < 50 || min > 220 || sat < 35) continue;
          const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
          let bucket = buckets.get(key);
          if (!bucket) { bucket = { r: 0, g: 0, b: 0, n: 0, score: 0 }; buckets.set(key, bucket); }
          bucket.r += r; bucket.g += g; bucket.b += b; bucket.n++;
          // Score favors saturation + count
          bucket.score += sat;
        }
        if (!buckets.size) { colorCache.set(url, null); return resolve(null); }
        let best = null;
        for (const b of buckets.values()) if (!best || b.score > best.score) best = b;
        const color = {
          r: Math.round(best.r / best.n),
          g: Math.round(best.g / best.n),
          b: Math.round(best.b / best.n),
        };
        // Boost saturation a bit & cap luminance so it always reads as a tint
        const tweaked = clampForTint(color);
        colorCache.set(url, tweaked);
        resolve(tweaked);
      } catch (e) {
        colorCache.set(url, null);
        resolve(null);
      }
    };
    img.onerror = () => { colorCache.set(url, null); resolve(null); };
    img.src = url;
  });
}
function clampForTint({ r, g, b }) {
  // Mix with a deep base so the tint is rich but never blown out
  const max = Math.max(r, g, b);
  const scale = max > 200 ? 200 / max : 1;
  return { r: Math.round(r * scale), g: Math.round(g * scale), b: Math.round(b * scale) };
}
function applyHeroTint(color) {
  const rgb = color ? `${color.r}, ${color.g}, ${color.b}` : "10, 10, 10";
  document.documentElement.style.setProperty("--hero-tint-rgb", rgb);
}
function applyModalTint(color) {
  const rgb = color ? `${color.r}, ${color.g}, ${color.b}` : "20, 20, 20";
  document.documentElement.style.setProperty("--modal-tint-rgb", rgb);
}

// ---------- Lazy image loader ----------
const lazyImageObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting && e.target.dataset.bg) {
      e.target.style.backgroundImage = `url("${e.target.dataset.bg}")`;
      e.target.removeAttribute("data-bg");
      lazyImageObserver.unobserve(e.target);
    }
  });
}, { rootMargin: "200px 100px" });

function preloadImage(url) {
  if (!url) return;
  const existing = document.querySelector(`link[rel="preload"][href="${url}"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "preload"; link.as = "image"; link.href = url;
  document.head.appendChild(link);
}

// ---------- Cards & Rows ----------
function makeCard(item, opts = {}) {
  const card = document.createElement("div");
  card.className = "card";
  card.tabIndex = 0;
  card.dataset.itemId = item.id;
  card.dataset.itemType = item.type;
  const bg = item.poster || item.backdropMd || item.backdrop;
  if (bg) { card.dataset.bg = bg; lazyImageObserver.observe(card); }
  const key = progressKey(item);
  const p = progressMap[key];
  let progressBar = "", cwMeta = "";
  if (opts.showProgress && p?.progress) {
    progressBar = `<div class="progress-bar"><div style="width:${Math.min(100, Math.round(p.progress))}%"></div></div>`;
    let epLabel = "";
    if (item.type === "tv" && p.season && p.episode) epLabel = `S${p.season}:E${p.episode}`;
    else if (item.type === "anime" && p.episode) epLabel = `Ep ${p.episode}`;
    let leftLabel = "";
    if (p.duration && p.timestamp) {
      const min = Math.max(1, Math.ceil((p.duration - p.timestamp) / 60));
      leftLabel = `${min}m left`;
    }
    if (epLabel || leftLabel)
      cwMeta = `<div class="cw-meta"><span class="ep">${epLabel}</span><span class="left">${leftLabel}</span></div>`;
  }
  card.innerHTML = `
    ${cwMeta}
    ${progressBar}
    <div class="card-info">
      <div class="row1">
        <div class="play-mini">▶</div>
        <div class="add-mini">+</div>
      </div>
      <div class="row2">
        ${item.rating ? `<span class="rating-star">★ ${item.rating}</span>` : ""}
        <span class="age-mini">${pseudoAge(item)}</span>
        <span>${item.year || ""}</span>
      </div>
      <div class="title">${escapeHTML(item.title || "")}</div>
    </div>`;
  card.addEventListener("click", () => openModal(item));
  card.querySelector(".play-mini")?.addEventListener("click", (e) => { e.stopPropagation(); openTitle(item); });
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
  if (item.backdrop) preloadImage(item.backdrop);
  bg.style.backgroundImage = item.backdrop ? `url("${item.backdrop}")` : "";
  // Reset then extract dominant color for ambient tint
  applyHeroTint(null);
  if (item.poster) extractDominantColor(item.poster).then(c => { if (heroItem === item) applyHeroTint(c); });
  else if (item.backdrop) extractDominantColor(item.backdrop).then(c => { if (heroItem === item) applyHeroTint(c); });
  trailerEl.innerHTML = "";

  const match = pseudoMatch(item);
  const age = pseudoAge(item);
  $("#hero-age").textContent = age;
  $("#hero-content").innerHTML = `
    <div class="hero-title-slot"><h1>${escapeHTML(item.title)}</h1></div>
    <div class="badges">
      ${item.rating ? `<span class="rating-star">★ ${item.rating}</span>` : ""}
      <span>${item.year || ""}</span>
    </div>
    <p>${escapeHTML(item.overview || "")}</p>
    <div class="hero-buttons">
      <button class="btn" id="hero-play">▶ Play</button>
      <button class="btn-secondary" id="hero-info">ⓘ More Info</button>
    </div>`;
  $("#hero-play").addEventListener("click", () => openModal(item));
  $("#hero-info").addEventListener("click", () => openModal(item));

  // Replace H1 with title logo art if available
  fetchTitleLogo(item).then(logo => {
    if (logo && heroItem === item) {
      $("#hero-content .hero-title-slot").innerHTML = `<img class="title-logo" src="${logo}" alt="${escapeHTML(item.title)}" />`;
    }
  });

  // Try to fetch trailer
  try {
    const key = await fetchTrailerKey(item);
    if (key) {
      const muteParam = heroMuted ? 1 : 0;
      trailerEl.innerHTML = `<iframe src="${YT}${key}?autoplay=1&mute=${muteParam}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${key}&disablekb=1&vq=hd1080&hd=1" allow="autoplay; encrypted-media"></iframe>`;
    }
  } catch {}
}

async function fetchTitleLogo(item) {
  if (item.type === "anime") return null;
  try {
    const path = item.type === "tv" ? `/tv/${item.id}/images` : `/movie/${item.id}/images`;
    // override include_image_language so we actually get logos
    const url = new URL(TMDB + path);
    url.searchParams.set("api_key", TMDB_API_KEY);
    url.searchParams.set("include_image_language", "en,null");
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const logos = (data.logos || []).filter(l => l.iso_639_1 === "en" || l.iso_639_1 === null);
    if (!logos.length) return null;
    // Prefer PNG, then highest voted
    logos.sort((a, b) => {
      const af = a.file_path.endsWith(".png") ? 1 : 0;
      const bf = b.file_path.endsWith(".png") ? 1 : 0;
      if (af !== bf) return bf - af;
      return (b.vote_average || 0) - (a.vote_average || 0);
    });
    return `${IMG}/w500${logos[0].file_path}`;
  } catch { return null; }
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

    // Recommended for You (lazy after main content)
    getRecommendedForYou().then(recs => {
      if (recs.length) {
        const row = renderRow("Recommended for You", recs);
        // Insert near the top, just after Continue Watching / My List if present, else first
        const ref = rows.querySelector(".row:nth-child(2)") || rows.querySelector(".row");
        if (ref) rows.insertBefore(row, ref); else rows.appendChild(row);
      }
    }).catch(() => {});

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

let currentCategoryType = null;
let currentGenreId = null;

async function showCategory(type, genreId = null) {
  setActive(type);
  stopHeroTrailer();
  currentCategoryType = type;
  currentGenreId = genreId;
  const rows = $("#rows");
  rows.innerHTML = ""; for (let i = 0; i < 3; i++) rows.appendChild(skeletonRow());
  try {
    if (type === "anime") {
      const [trending, topRated, seasonal] = await Promise.all([
        anilistTrending(),
        anilistTopRated().catch(() => []),
        anilistSeasonal().catch(() => ({ items: [], label: "" })),
      ]);
      renderHero(trending.find(i => i.backdrop) || trending[0]);
      rows.innerHTML = "";
      rows.appendChild(renderRow("Trending Now", trending));
      if (seasonal.items.length) rows.appendChild(renderRow(`This Season · ${seasonal.label}`, seasonal.items));
      rows.appendChild(renderRow(`Top 10 Anime`, topRated.slice(0, 10), { top10: true }));
      rows.appendChild(renderRow("Highest Rated", topRated));
      // Genre rows (lazy)
      for (const g of ["Action", "Romance", "Comedy", "Sci-Fi", "Fantasy"]) {
        anilistByGenre(g).then(items => {
          if (items.length) rows.appendChild(renderRow(g, items));
        }).catch(() => {});
      }
      return;
    }
    // Genre filter mode: show grid of that genre only
    if (genreId) {
      const data = await tmdb(`/discover/${type}`, { with_genres: genreId, sort_by: "popularity.desc" });
      const items = data.results.filter(r => r.backdrop_path && r.poster_path).map(r => normalizeTMDB(r, type));
      renderHero(items.find(i => i.backdrop) || items[0]);
      rows.innerHTML = "";
      rows.appendChild(renderGenreChips(type, genreId));
      const grid = document.createElement("div");
      grid.className = "search-grid";
      items.forEach(it => {
        const cell = document.createElement("div"); cell.className = "search-cell";
        cell.appendChild(makeCard(it));
        const meta = document.createElement("div"); meta.className = "search-meta";
        meta.innerHTML = `<span class="type-pill">${type === "tv" ? "Series" : "Movie"}</span><span>${it.year || ""}</span>`;
        const title = document.createElement("div"); title.className = "search-title";
        title.textContent = it.title;
        cell.appendChild(title); cell.appendChild(meta);
        grid.appendChild(cell);
      });
      rows.appendChild(grid);
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
    rows.appendChild(renderGenreChips(type, null));
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

async function showPerson(personId) {
  setActive(null);
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const [person, credits] = await Promise.all([
      tmdb(`/person/${personId}`),
      tmdb(`/person/${personId}/combined_credits`),
    ]);
    const photo = person.profile_path ? `${IMG}/w300${person.profile_path}` : "";
    const works = (credits.cast || [])
      .filter(c =>
        c.poster_path && c.backdrop_path &&
        (c.media_type === "movie" || c.media_type === "tv") &&
        (c.vote_count || 0) >= 50
      )
      // De-dup: same person can appear multiple times in a TV series
      .filter((c, i, arr) => arr.findIndex(x => x.id === c.id && x.media_type === c.media_type) === i)
      .map(c => ({
        ...normalizeTMDB({
          id: c.id, media_type: c.media_type,
          title: c.title, name: c.name,
          poster_path: c.poster_path, backdrop_path: c.backdrop_path,
          overview: c.overview,
          release_date: c.release_date, first_air_date: c.first_air_date,
          vote_average: c.vote_average, vote_count: c.vote_count,
        }, c.media_type),
        character: c.character,
        popularity: c.popularity || 0,
        voteCount: c.vote_count || 0,
      }))
      .sort((a, b) => b.popularity - a.popularity);

    rows.innerHTML = "";
    const header = document.createElement("div");
    header.className = "person-header";
    const dob = person.birthday ? new Date(person.birthday).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
    const age = person.birthday && !person.deathday
      ? Math.floor((Date.now() - new Date(person.birthday)) / (365.25 * 24 * 3600 * 1000))
      : null;
    header.innerHTML = `
      <div class="person-photo" style="background-image:url('${photo}')"></div>
      <div class="person-info">
        <div class="person-eyebrow">${escapeHTML(person.known_for_department || "Cast")}</div>
        <h1>${escapeHTML(person.name)}</h1>
        <div class="person-meta">
          ${dob ? `<span>${dob}${age ? ` (age ${age})` : ""}</span>` : ""}
          ${person.place_of_birth ? `<span>${escapeHTML(person.place_of_birth)}</span>` : ""}
          <span>${works.length} title${works.length === 1 ? "" : "s"}</span>
        </div>
        ${person.biography ? `<p class="person-bio">${escapeHTML(person.biography)}</p>` : ""}
      </div>`;
    rows.appendChild(header);

    if (!works.length) {
      rows.innerHTML += `<div class="empty">No titles found.</div>`;
      return;
    }
    const sub = document.createElement("div");
    sub.className = "page-subheader";
    sub.innerHTML = `<h2>Known For</h2>`;
    rows.appendChild(sub);

    const grid = document.createElement("div");
    grid.className = "search-grid";
    works.forEach(it => {
      const cell = document.createElement("div"); cell.className = "search-cell";
      cell.appendChild(makeCard(it));
      const meta = document.createElement("div"); meta.className = "search-meta";
      meta.innerHTML = `<span class="type-pill">${it.type === "tv" ? "Series" : "Movie"}</span>${it.rating ? `<span class="rating-star">★ ${it.rating}</span>` : ""}<span>${it.year || ""}</span>`;
      const title = document.createElement("div"); title.className = "search-title";
      title.textContent = it.title;
      cell.appendChild(title); cell.appendChild(meta);
      if (it.character) {
        const chr = document.createElement("div");
        chr.className = "search-character";
        chr.textContent = `as ${it.character}`;
        cell.appendChild(chr);
      }
      grid.appendChild(cell);
    });
    rows.appendChild(grid);
  } catch (e) {
    rows.innerHTML = `<div class="empty">${escapeHTML(e.message)}</div>`;
  }
}

function showMyList() {
  setActive("mylist");
  document.body.classList.add("no-hero");
  stopHeroTrailer();
  const rows = $("#rows");
  rows.innerHTML = `<div class="page-header"><h1>My List</h1></div>`;
  if (!myList.length) {
    rows.innerHTML += `
      <div class="empty-state">
        <div class="empty-icon">+</div>
        <h2>Your list is empty</h2>
        <p>Tap the + button on any title to save it here for later.</p>
        <button class="btn" id="empty-browse">Browse Titles</button>
      </div>`;
    $("#empty-browse")?.addEventListener("click", () => {
      document.body.classList.remove("no-hero");
      showHome();
    });
    return;
  }
  const grid = document.createElement("div");
  grid.className = "search-grid";
  myList.forEach(it => {
    const cell = document.createElement("div");
    cell.className = "search-cell";
    cell.appendChild(makeCard(it));
    const meta = document.createElement("div");
    meta.className = "search-meta";
    meta.innerHTML = `<span class="type-pill">${it.type === "tv" ? "Series" : it.type === "anime" ? "Anime" : "Movie"}</span><span>${it.year || ""}</span>`;
    const title = document.createElement("div");
    title.className = "search-title";
    title.textContent = it.title;
    cell.appendChild(title);
    cell.appendChild(meta);
    grid.appendChild(cell);
  });
  rows.appendChild(grid);
  const c = getContinueWatching();
  if (c.length) {
    const continueHeader = document.createElement("div");
    continueHeader.className = "page-subheader";
    continueHeader.innerHTML = `<h2>Continue Watching</h2>`;
    rows.appendChild(continueHeader);
    rows.appendChild(renderRow("", c, { showProgress: true }));
  }
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
      meta.innerHTML = `<span class="type-pill">${it.type === "tv" ? "Series" : "Movie"}</span>${it.rating ? `<span class="rating-star">★ ${it.rating}</span>` : ""}<span>${it.year || ""}</span>`;
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

// TMDB genre lists (movie + tv)
const GENRES_TV = [
  { id: 10759, name: "Action & Adventure" },
  { id: 16,    name: "Animation" },
  { id: 35,    name: "Comedy" },
  { id: 80,    name: "Crime" },
  { id: 99,    name: "Documentary" },
  { id: 18,    name: "Drama" },
  { id: 10765, name: "Sci-Fi & Fantasy" },
  { id: 9648,  name: "Mystery" },
];

function renderGenreChips(type, activeId) {
  const wrap = document.createElement("div");
  wrap.className = "chips";
  const list = type === "tv" ? GENRES_TV : GENRES_MOVIE;
  const all = document.createElement("button");
  all.className = "chip" + (!activeId ? " active" : "");
  all.textContent = "All";
  all.addEventListener("click", () => { location.hash = `#/${type === "movie" ? "movies" : "tv"}`; });
  wrap.appendChild(all);
  list.forEach(g => {
    const b = document.createElement("button");
    b.className = "chip" + (activeId == g.id ? " active" : "");
    b.textContent = g.name;
    b.addEventListener("click", () => {
      location.hash = `#/${type === "movie" ? "movies" : "tv"}/genre/${g.id}`;
    });
    wrap.appendChild(b);
  });
  return wrap;
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
  applyModalTint(null);
  if (item.poster) extractDominantColor(item.poster).then(c => { if (currentItem === item) applyModalTint(c); });
  else if (bg) extractDominantColor(bg).then(c => { if (currentItem === item) applyModalTint(c); });
  $("#modal-trailer").innerHTML = "";
  $("#player-wrap").innerHTML = ""; $("#player-wrap").classList.remove("active");
  $(".modal-body").classList.remove("playing");
  $("#modal-title").textContent = item.title;
  $("#modal-title").classList.remove("has-logo"); $("#modal-title").style.backgroundImage = "";
  fetchTitleLogo(item).then(logo => {
    if (logo && currentItem === item) {
      $("#modal-title").classList.add("has-logo");
      $("#modal-title").style.backgroundImage = `url("${logo}")`;
    }
  });
  $("#modal-match").textContent = "";
  $("#modal-year").textContent = item.year || "";
  $("#modal-age").textContent = pseudoAge(item);
  $("#modal-runtime").textContent = "";
  $("#modal-overview").textContent = item.overview || "";
  $("#modal-cast").textContent = "Loading…";
  $("#modal-genres").textContent = (item.genres || []).join(", ");
  $("#episode-section").classList.add("hidden");
  $("#similar-section").classList.add("hidden");
  $("#cast-section").classList.add("hidden"); $("#cast-row").innerHTML = "";
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

      // Crew: director, writers, studio
      const sideEl = $(".modal-info-side");
      // Remove any prior dynamic lines
      sideEl.querySelectorAll(".info-line.dynamic").forEach(n => n.remove());
      const crew = credits.crew || [];
      const directors = item.type === "movie"
        ? crew.filter(c => c.job === "Director").map(c => c.name)
        : (details.created_by || []).map(c => c.name);
      const writers = [...new Set(crew.filter(c => c.department === "Writing" || c.job === "Writer" || c.job === "Screenplay").map(c => c.name))];
      const studio = (details.production_companies || [])[0]?.name;
      const directorLabel = item.type === "movie" ? "Director" : "Creator";
      const addLine = (label, val) => {
        if (!val) return;
        const d = document.createElement("div");
        d.className = "info-line dynamic";
        d.innerHTML = `<span class="label">${label}:</span> <span>${escapeHTML(val)}</span>`;
        sideEl.appendChild(d);
      };
      if (directors.length) addLine(directors.length > 1 ? directorLabel + "s" : directorLabel, directors.slice(0, 2).join(", "));
      if (writers.length) addLine(writers.length > 1 ? "Writers" : "Writer", writers.slice(0, 3).join(", "));
      if (studio) addLine("Studio", studio);

      // Cast row with images
      const castRow = $("#cast-row");
      castRow.innerHTML = "";
      const cast = (credits.cast || []).slice(0, 12);
      if (cast.length) {
        $("#cast-section").classList.remove("hidden");
        cast.forEach(c => {
          const card = document.createElement("div");
          card.className = "cast-card";
          const img = c.profile_path ? `${IMG}/w185${c.profile_path}` : "";
          card.innerHTML = `
            <div class="cast-img" style="background-image:url('${img}')"></div>
            <div class="cast-name">${escapeHTML(c.name)}</div>
            ${c.character ? `<div class="cast-char">${escapeHTML(c.character)}</div>` : ""}`;
          card.addEventListener("click", () => {
            const pid = c.id;
            closeModalNav();
            setTimeout(() => navTo(`#/person/${pid}`), 50);
          });
          castRow.appendChild(card);
        });
      } else {
        $("#cast-section").classList.add("hidden");
      }

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
        ${item.rating ? `<span class="rating-star">★ ${item.rating}</span>` : ""}
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
function closeModalNav() {
  // If we're on a title route, navigate away (back) so URL stays in sync
  if (location.hash.startsWith("#/title/")) history.back();
  else closeModal();
}
$(".modal-close").addEventListener("click", closeModalNav);
$(".modal-backdrop").addEventListener("click", closeModalNav);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").classList.contains("hidden")) closeModalNav(); });

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
  if (idx >= 0) {
    myList.splice(idx, 1);
    showToast(`Removed "${item.title}" from My List`);
  } else {
    myList.push({
      id: item.id, type: item.type, title: item.title,
      poster: item.poster, backdrop: item.backdrop, backdropMd: item.backdropMd,
      overview: item.overview, year: item.year, rating: item.rating,
      isMovie: item.isMovie, episodes: item.episodes,
    });
    showToast(`Added "${item.title}" to My List`);
  }
  saveJSON(STORAGE.list, myList);
  updateListButton();
}

// ---------- Toast ----------
let toastTimer;
function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.classList.add("hidden"), 300);
  }, 2500);
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
async function getRecommendedForYou() {
  // Seed from My List + most recent Continue Watching
  const seeds = [];
  const seen = new Set();
  const cw = getContinueWatching().slice(0, 3);
  cw.forEach(it => { const k = `${it.type}:${it.id}`; if (!seen.has(k) && it.type !== "anime") { seen.add(k); seeds.push(it); } });
  myList.slice(-3).forEach(it => { const k = `${it.type}:${it.id}`; if (!seen.has(k) && it.type !== "anime") { seen.add(k); seeds.push(it); } });
  if (!seeds.length) return [];

  const recs = new Map(); // key -> { item, score }
  await Promise.all(seeds.slice(0, 5).map(async (s, i) => {
    try {
      const data = await tmdb(`/${s.type}/${s.id}/recommendations`);
      data.results.forEach((r, j) => {
        if (!r.backdrop_path || !r.poster_path) return;
        const key = `${s.type}:${r.id}`;
        if (seen.has(key)) return;
        const item = normalizeTMDB(r, s.type);
        // Score: higher for earlier seeds and earlier results
        const score = (5 - i) * 10 + (20 - j) + (parseFloat(item.rating) || 0);
        const existing = recs.get(key);
        if (!existing || score > existing.score) recs.set(key, { item, score });
      });
    } catch {}
  }));
  return [...recs.values()].sort((a, b) => b.score - a.score).slice(0, 20).map(x => x.item);
}

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

// ---------- URL routing ----------
function navTo(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
let lastNonModalHash = "#/";
async function route() {
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/?(.*)$/);
  const path = (m?.[1] || "").split("?")[0];
  const queryStr = hash.split("?")[1] || "";
  const params = new URLSearchParams(queryStr);
  const parts = path.split("/").filter(Boolean);

  // Modal route: #/title/{type}/{id} (?back=<encoded-prev-hash>)
  if (parts[0] === "title" && parts[1] && parts[2]) {
    if ($("#modal").classList.contains("hidden")) await openTitleByRoute(parts[1], parts[2]);
    return;
  }
  // Otherwise close any open modal silently
  if (!$("#modal").classList.contains("hidden")) closeModalSilent();

  // Smooth cross-fade between non-modal pages (skip on first paint)
  const c = $("#content");
  if (lastNonModalHash !== hash) {
    c.classList.add("transitioning");
    await new Promise(r => setTimeout(r, 180));
  }
  lastNonModalHash = hash;
  // Run page render synchronously then fade back in next frame
  const finish = () => requestAnimationFrame(() => c.classList.remove("transitioning"));

  $("#search").value = "";
  document.body.classList.remove("no-hero");

  let p;
  if (!parts.length) p = showHome();
  else if (parts[0] === "movies") {
    if (parts[1] === "genre" && parts[2]) p = showCategory("movie", +parts[2]);
    else p = showCategory("movie");
  }
  else if (parts[0] === "tv") {
    if (parts[1] === "genre" && parts[2]) p = showCategory("tv", +parts[2]);
    else p = showCategory("tv");
  }
  else if (parts[0] === "anime") p = showCategory("anime");
  else if (parts[0] === "new") p = showNewPopular();
  else if (parts[0] === "list") { showMyList(); p = Promise.resolve(); }
  else if (parts[0] === "person" && parts[1]) p = showPerson(parts[1]);
  else if (parts[0] === "search") {
    const q = params.get("q") || "";
    $("#search").value = q;
    p = q ? searchAll(q) : showHome();
  }
  else p = showHome();
  Promise.resolve(p).finally(finish);
}

async function openTitleByRoute(type, id) {
  try {
    if (type === "anime") {
      const r = await fetch("https://graphql.anilist.co", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `query($id:Int){Media(id:$id,type:ANIME){id title{romaji english} coverImage{large extraLarge} bannerImage description(asHtml:false) format episodes averageScore startDate{year} genres trailer{id site}}}`, variables: { id: +id } }),
      });
      const d = (await r.json()).data.Media;
      const item = {
        id: d.id, type: "anime",
        title: d.title.english || d.title.romaji,
        poster: d.coverImage.extraLarge || d.coverImage.large,
        backdrop: d.bannerImage || d.coverImage.extraLarge,
        overview: (d.description || "").replace(/<[^>]+>/g, ""),
        year: d.startDate?.year,
        rating: d.averageScore ? (d.averageScore / 10).toFixed(1) : null,
        episodes: d.episodes,
        isMovie: d.format === "MOVIE",
        genres: d.genres,
        trailerKey: d.trailer?.site === "youtube" ? d.trailer.id : null,
      };
      return openModal(item);
    }
    const data = await tmdb(`/${type}/${id}`);
    const item = normalizeTMDB({
      id: data.id, media_type: type,
      title: data.title, name: data.name,
      poster_path: data.poster_path, backdrop_path: data.backdrop_path,
      overview: data.overview,
      release_date: data.release_date, first_air_date: data.first_air_date,
      vote_average: data.vote_average, vote_count: data.vote_count,
    }, type);
    openModal(item);
  } catch (e) { console.warn("Failed to load title", e); showHome(); }
}

function openTitle(item) {
  navTo(`#/title/${item.type}/${item.id}`);
}

function closeModalSilent() {
  $("#modal").classList.add("hidden");
  $("#modal-trailer").innerHTML = "";
  $("#player-wrap").innerHTML = ""; $("#player-wrap").classList.remove("active");
  $(".modal-body").classList.remove("playing");
  document.body.style.overflow = "";
  currentItem = null;
  const heroIframe = $("#hero-trailer iframe");
  if (heroIframe && heroIframe.dataset.src && !heroIframe.src) heroIframe.src = heroIframe.dataset.src;
}

window.addEventListener("hashchange", route);

// ---------- Nav ----------
$$("#navbar [data-nav]").forEach(a => {
  a.addEventListener("click", e => {
    e.preventDefault();
    const nav = a.dataset.nav;
    if (nav === "home") navTo("#/");
    else if (nav === "movies") navTo("#/movies");
    else if (nav === "tv") navTo("#/tv");
    else if (nav === "anime") navTo("#/anime");
    else if (nav === "new") navTo("#/new");
    else if (nav === "mylist") navTo("#/list");
  });
});

let searchTimer;
let suggestItems = [];
let suggestFocusIdx = -1;

async function showSuggestions(q) {
  const box = $("#search-suggest");
  try {
    const data = await tmdb("/search/multi", { query: q });
    suggestItems = data.results
      .filter(r => (r.media_type === "movie" || r.media_type === "tv") && r.poster_path)
      .slice(0, 7)
      .map(r => normalizeTMDB(r));
    if (!suggestItems.length) {
      box.innerHTML = `<div class="suggest-empty">No matches for "${escapeHTML(q)}"</div>`;
      box.classList.remove("hidden");
      return;
    }
    box.innerHTML = suggestItems.map((it, i) => `
      <div class="suggest-item" data-idx="${i}">
        <div class="sug-thumb" style="background-image:url('${it.poster}')"></div>
        <div class="sug-info">
          <div class="sug-title">${escapeHTML(it.title)}</div>
          <div class="sug-meta">
            <span class="type-pill">${it.type === "tv" ? "Series" : "Movie"}</span>
            ${it.rating ? `<span class="rating-star">★ ${it.rating}</span>` : ""}
            <span>${it.year || ""}</span>
          </div>
        </div>
      </div>`).join("");
    suggestFocusIdx = -1;
    box.classList.remove("hidden");
    $$(".suggest-item", box).forEach(el => {
      el.addEventListener("click", () => {
        const idx = +el.dataset.idx;
        const item = suggestItems[idx];
        if (item) { hideSuggestions(); openTitle(item); }
      });
    });
  } catch {
    box.classList.add("hidden");
  }
}
function hideSuggestions() {
  $("#search-suggest").classList.add("hidden");
  suggestFocusIdx = -1;
}

$("#search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { hideSuggestions(); if (location.hash.startsWith("#/search")) navTo("#/"); return; }
  searchTimer = setTimeout(() => showSuggestions(q), 220);
});

$("#search").addEventListener("keydown", e => {
  const box = $("#search-suggest");
  const visible = !box.classList.contains("hidden") && suggestItems.length;
  if (e.key === "Enter") {
    e.preventDefault();
    if (visible && suggestFocusIdx >= 0) {
      hideSuggestions();
      openTitle(suggestItems[suggestFocusIdx]);
    } else {
      const q = $("#search").value.trim();
      if (q) { hideSuggestions(); navTo(`#/search?q=${encodeURIComponent(q)}`); }
    }
  } else if (e.key === "ArrowDown" && visible) {
    e.preventDefault();
    suggestFocusIdx = Math.min(suggestItems.length - 1, suggestFocusIdx + 1);
    $$(".suggest-item", box).forEach((el, i) => el.classList.toggle("focused", i === suggestFocusIdx));
  } else if (e.key === "ArrowUp" && visible) {
    e.preventDefault();
    suggestFocusIdx = Math.max(-1, suggestFocusIdx - 1);
    $$(".suggest-item", box).forEach((el, i) => el.classList.toggle("focused", i === suggestFocusIdx));
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box-wrap")) hideSuggestions();
});
$("#search").addEventListener("focus", () => {
  const q = $("#search").value.trim();
  if (q) showSuggestions(q);
});

// ---------- Keyboard navigation ----------
document.addEventListener("keydown", (e) => {
  // ESC handled in modal; here we focus + arrow navigate cards
  const f = document.activeElement;
  if (!f || !f.classList?.contains("card")) return;
  if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) e.preventDefault();
  if (e.key === "ArrowLeft") f.previousElementSibling?.focus?.();
  else if (e.key === "ArrowRight") f.nextElementSibling?.focus?.();
  else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    // Find the same horizontal index in next/prev row
    const row = f.closest(".row, .search-grid");
    const cards = $$(".card");
    const idx = cards.indexOf(f);
    if (idx < 0) return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    // Step until we leave current row container
    for (let i = idx + dir; i >= 0 && i < cards.length; i += dir) {
      if (cards[i].closest(".row, .search-grid") !== row) {
        cards[i].focus(); cards[i].scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
    }
  }
});

window.addEventListener("scroll", () => {
  $("#navbar").classList.toggle("scrolled", window.scrollY > 20);
});

// ---------- Profile ----------
let manageMode = false;
let editingProfileId = null;

function renderProfileScreen() {
  const list = $("#profile-list"); list.innerHTML = "";
  PROFILES.forEach(p => {
    const card = document.createElement("div");
    card.className = "profile-card";
    card.innerHTML = `
      <div class="avatar" style="background:${p.color}">${escapeHTML(profileInitial(p))}</div>
      <div class="name">${escapeHTML(p.name)}</div>
      <button class="edit-pencil" title="Edit">✎</button>`;
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("edit-pencil") || manageMode) {
        openProfileEdit(p);
      } else {
        selectProfile(p);
      }
    });
    list.appendChild(card);
  });
  // Add-profile tile (max 6)
  if (PROFILES.length < 6) {
    const add = document.createElement("div");
    add.className = "profile-card add-card";
    add.innerHTML = `<div class="avatar">+</div><div class="name">Add Profile</div>`;
    add.addEventListener("click", () => openProfileEdit(null));
    list.appendChild(add);
  }
}

function openProfileEdit(profile) {
  editingProfileId = profile?.id || null;
  $("#profile-edit-title").textContent = profile ? "Edit Profile" : "Create Profile";
  $("#profile-name-input").value = profile?.name || "";
  $("#profile-edit-delete").style.display = (profile && PROFILES.length > 1) ? "" : "none";
  // Color picker
  const picker = $("#color-picker");
  picker.innerHTML = "";
  const currentColor = profile?.color || PROFILE_COLORS[0];
  PROFILE_COLORS.forEach(c => {
    const sw = document.createElement("div");
    sw.className = "color-swatch" + (c === currentColor ? " active" : "");
    sw.style.background = c;
    sw.dataset.color = c;
    sw.addEventListener("click", () => {
      $$(".color-swatch", picker).forEach(s => s.classList.remove("active"));
      sw.classList.add("active");
    });
    picker.appendChild(sw);
  });
  $("#profile-edit-modal").classList.remove("hidden");
  setTimeout(() => $("#profile-name-input").focus(), 50);
}

function closeProfileEdit() {
  $("#profile-edit-modal").classList.add("hidden");
  editingProfileId = null;
}

$("#profile-edit-save").addEventListener("click", () => {
  const name = $("#profile-name-input").value.trim();
  if (!name) { showToast("Name required"); return; }
  const color = $(".color-swatch.active")?.dataset.color || PROFILE_COLORS[0];
  if (editingProfileId) {
    const p = PROFILES.find(x => x.id === editingProfileId);
    if (p) { p.name = name; p.color = color; }
  } else {
    PROFILES.push({ id: "p" + Date.now(), name, color });
  }
  saveProfiles();
  renderProfileScreen();
  closeProfileEdit();
});

$("#profile-edit-delete").addEventListener("click", () => {
  if (!editingProfileId || PROFILES.length <= 1) return;
  if (!confirm("Delete this profile? Watch history and list won't be removed.")) return;
  PROFILES = PROFILES.filter(p => p.id !== editingProfileId);
  saveProfiles();
  if (activeProfile?.id === editingProfileId) {
    activeProfile = null;
    localStorage.removeItem(STORAGE.profile);
  }
  renderProfileScreen();
  closeProfileEdit();
});

$("#profile-edit-cancel").addEventListener("click", closeProfileEdit);
$(".profile-edit-backdrop").addEventListener("click", closeProfileEdit);
$("#profile-name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#profile-edit-save").click();
  if (e.key === "Escape") closeProfileEdit();
});

$("#manage-profiles").addEventListener("click", () => {
  manageMode = !manageMode;
  document.body.classList.toggle("profile-manage-mode", manageMode);
  $("#manage-profiles").textContent = manageMode ? "Done" : "Manage Profiles";
});
function selectProfile(p) {
  activeProfile = p; saveJSON(STORAGE.profile, p);
  manageMode = false; document.body.classList.remove("profile-manage-mode");
  $("#manage-profiles").textContent = "Manage Profiles";
  $("#profile-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#profile-avatar-mini").style.background = p.color;
  $("#profile-avatar-mini").textContent = profileInitial(p);
  $("#profile-avatar-mini").style.cssText += `display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;`;
  route();
  maybeShowOnboarding();
}

function maybeShowOnboarding() {
  if (localStorage.getItem(STORAGE.onboarded)) return;
  setTimeout(() => {
    showToast("Tip: hover a poster to preview · type to search · Esc closes any modal");
    localStorage.setItem(STORAGE.onboarded, "1");
  }, 1200);
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
  activeProfile = null;
  localStorage.removeItem(STORAGE.profile);
});
$("#clear-data").addEventListener("click", e => {
  e.preventDefault();
  if (confirm("Clear continue-watching and My List for this profile?")) {
    progressMap = {}; myList = [];
    saveJSON(STORAGE.progress, progressMap); saveJSON(STORAGE.list, myList);
    route();
  }
  $("#profile-pill").classList.remove("open");
});

// ---------- Boot ----------
renderProfileScreen();
if (activeProfile) selectProfile(activeProfile);

// PWA: register service worker (best effort) and self-update
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then(reg => {
      reg.update?.();
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "activated") location.reload();
        });
      });
    }).catch(() => {});
  });
}
