// =========================================================================
// LIVE TV — IPTV (Xtream Codes) channel browser + player
//
// Loaded before app.js. app.js's router calls window.showLivePage() for #/live.
// The user's IPTV login lives only in this browser's localStorage and is sent
// to YOUR proxy Worker (see worker-iptv/) with each request.
// =========================================================================
(function () {
  "use strict";

  // By default the proxy is this same site's own /api/iptv/* serverless
  // functions (see api/iptv/). Only needed if you want to point at a
  // separately hosted proxy (e.g. the Cloudflare Worker in worker-iptv/,
  // for a provider that blocks Vercel's IPs instead of Cloudflare's).

  const CFG_KEY = "moviebox_live_cfg_v1";
  const HLS_SRC = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
  const MPEGTS_SRC = "https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js";
  const PAGE_SIZE = 120;
  const START_TIMEOUT_MS = 12000;

  const q = (s, root = document) => root.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const state = {
    cfg: null,
    categories: [],
    streams: [],
    cat: "all",
    term: "",
    shown: PAGE_SIZE,
    current: null,
    player: null,
    playToken: 0,
  };

  // ---------- storage ----------
  function loadCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
      return c && c.server && c.username && c.password ? c : null;
    } catch { return null; }
  }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch {} }
  function clearCfg() { try { localStorage.removeItem(CFG_KEY); } catch {} }

  // ---------- helpers ----------
  const scriptCache = {};
  function loadScript(src) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => { delete scriptCache[src]; reject(new Error("Couldn't load " + src)); };
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }

  function normServer(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    try { return new URL(s).origin; } catch { return ""; }
  }
  function normProxy(raw) {
    let s = String(raw || "").trim().replace(/\/+$/, "");
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try { const u = new URL(s); return u.origin + u.pathname.replace(/\/+$/, ""); } catch { return ""; }
  }
  function proxyBase(cfg) {
    return cfg.proxy ? normProxy(cfg.proxy) : location.origin + "/api/iptv";
  }

  function apiURL(cfg, action, extra) {
    const p = new URLSearchParams({
      server: cfg.server, username: cfg.username, password: cfg.password,
      ...(action ? { action } : {}), ...(extra || {}),
    });
    return `${proxyBase(cfg)}/api?${p}`;
  }
  async function apiGet(cfg, action, extra) {
    let res;
    try { res = await fetch(apiURL(cfg, action, extra), { cache: "no-store" }); }
    catch { throw new Error("Couldn't reach the proxy. Check the Proxy URL and that the Worker is deployed."); }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(t ? t.slice(0, 160) : `The proxy answered ${res.status}`);
    }
    try { return await res.json(); }
    catch { throw new Error("The IPTV server sent an unexpected reply."); }
  }
  function streamURL(cfg, id, ext) {
    const p = new URLSearchParams({
      server: cfg.server, username: cfg.username, password: cfg.password,
      stream_id: String(id), ext,
    });
    return `${proxyBase(cfg)}/live?${p}`;
  }

  function toast(msg) {
    if (typeof showToast === "function") showToast(msg);
    else alert(msg);
  }

  // ---------- player ----------
  function teardownPlayer() {
    const p = state.player;
    state.player = null;
    try {
      if (p && p.type === "hls") p.inst.destroy();
      else if (p && p.type === "ts") {
        p.inst.pause(); p.inst.unload(); p.inst.detachMediaElement(); p.inst.destroy();
      }
    } catch {}
    const v = q("#live-video");
    if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch {} }
  }

  function setOverlay(html, opts = {}) {
    const o = q("#live-overlay");
    if (!o) return;
    if (!html) { o.classList.add("hidden"); o.innerHTML = ""; return; }
    o.classList.remove("hidden");
    o.innerHTML = html;
    if (opts.retry) {
      const b = o.querySelector("[data-retry]");
      if (b) b.addEventListener("click", opts.retry);
    }
  }

  function waitForPlaying(video, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("playing", onPlaying);
        resolve(ok);
      };
      const onPlaying = () => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      video.addEventListener("playing", onPlaying);
      video._liveFail = () => finish(false);
    });
  }

  async function startHls(url, video) {
    await loadScript(HLS_SRC);
    if (!window.Hls || !window.Hls.isSupported()) return false;
    const hls = new window.Hls({ lowLatencyMode: false, maxBufferLength: 30 });
    state.player = { type: "hls", inst: hls };
    let started = false;
    hls.on(window.Hls.Events.ERROR, (_, d) => {
      if (!d || !d.fatal) return;
      if (!started) { if (video._liveFail) video._liveFail(); return; }
      if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else setOverlay(`<div class="live-msg">The stream stopped.<br><button class="btn-secondary" data-retry>Retry</button></div>`,
        { retry: () => state.current && playChannel(state.current) });
    });
    const playing = waitForPlaying(video, START_TIMEOUT_MS);
    hls.loadSource(url);
    hls.attachMedia(video);
    video.play().catch(() => {});
    const ok = await playing;
    started = ok;
    return ok;
  }

  async function startTs(url, video) {
    await loadScript(MPEGTS_SRC);
    const lib = window.mpegts;
    if (!lib || !lib.isSupported()) return false;
    const inst = lib.createPlayer(
      { type: "mpegts", isLive: true, url },
      { enableWorker: true, liveBufferLatencyChasing: true },
    );
    state.player = { type: "ts", inst };
    let started = false;
    inst.on(lib.Events.ERROR, () => {
      if (!started) { if (video._liveFail) video._liveFail(); return; }
      setOverlay(`<div class="live-msg">The stream stopped.<br><button class="btn-secondary" data-retry>Retry</button></div>`,
        { retry: () => state.current && playChannel(state.current) });
    });
    inst.attachMediaElement(video);
    const playing = waitForPlaying(video, START_TIMEOUT_MS);
    inst.load();
    try { const r = inst.play(); if (r && r.catch) r.catch(() => {}); } catch {}
    const ok = await playing;
    started = ok;
    return ok;
  }

  async function playChannel(ch) {
    const cfg = state.cfg;
    const video = q("#live-video");
    if (!cfg || !video) return;
    const token = ++state.playToken;
    teardownPlayer();
    state.current = ch;
    markPlaying();
    const now = q("#live-now");
    if (now) now.textContent = ch.name || "";
    setOverlay(`<div class="live-msg"><div class="boot-spinner"></div>Loading ${esc(ch.name)}…</div>`);

    // Try the format that worked last time first; fall back to the other one.
    const order = cfg.fmt === "ts" ? ["ts", "hls"] : ["hls", "ts"];
    for (const fmt of order) {
      if (token !== state.playToken) return; // user picked another channel
      let ok = false;
      try {
        ok = fmt === "hls"
          ? await startHls(streamURL(cfg, ch.stream_id, "m3u8"), video)
          : await startTs(streamURL(cfg, ch.stream_id, "ts"), video);
      } catch { ok = false; }
      if (token !== state.playToken) { teardownPlayer(); return; }
      if (ok) {
        setOverlay("");
        if (cfg.fmt !== fmt) { cfg.fmt = fmt; saveCfg(cfg); }
        return;
      }
      teardownPlayer();
    }
    setOverlay(
      `<div class="live-msg">Couldn't play this channel.<br>
       <span class="live-sub">It may be offline, use a format your browser can't decode, or your plan may allow only one connection at a time.</span><br>
       <button class="btn-secondary" data-retry>Try again</button></div>`,
      { retry: () => playChannel(ch) },
    );
  }

  // ---------- channel list ----------
  function matches(s) {
    if (state.cat !== "all" && String(s.category_id) !== state.cat) return false;
    if (!state.term) return true;
    const name = (s.name || "").toLowerCase();
    return state.term.every((w) => name.includes(w));
  }

  function markPlaying() {
    const list = q("#live-list");
    if (!list) return;
    list.querySelectorAll(".live-ch").forEach((b) => {
      b.classList.toggle("playing", state.current && b.dataset.id === String(state.current.stream_id));
    });
  }

  function renderList() {
    const list = q("#live-list");
    if (!list) return;
    const all = state.streams.filter(matches);
    const slice = all.slice(0, state.shown);
    if (!all.length) {
      list.innerHTML = `<div class="empty">No channels match.</div>`;
      return;
    }
    list.innerHTML = slice.map((s) => `
      <button type="button" class="live-ch" data-id="${esc(s.stream_id)}">
        <span class="live-ch-icon">${s.stream_icon ? `<img src="${esc(s.stream_icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>
        <span class="live-ch-name">${esc(s.name)}</span>
      </button>`).join("")
      + (all.length > slice.length
        ? `<button type="button" class="btn-secondary live-more" id="live-more">Show ${Math.min(PAGE_SIZE, all.length - slice.length)} more (${all.length - slice.length} left)</button>`
        : "");
    markPlaying();
  }

  function fillCategories() {
    const sel = q("#live-cat");
    if (!sel) return;
    const counts = new Map();
    state.streams.forEach((s) => counts.set(String(s.category_id), (counts.get(String(s.category_id)) || 0) + 1));
    const opts = [`<option value="all">All channels (${state.streams.length})</option>`];
    state.categories.forEach((c) => {
      const n = counts.get(String(c.category_id));
      if (n) opts.push(`<option value="${esc(c.category_id)}">${esc(c.category_name)} (${n})</option>`);
    });
    sel.innerHTML = opts.join("");
    sel.value = state.cat;
  }

  async function loadChannels(cfg) {
    const list = q("#live-list");
    try {
      const [cats, streams] = await Promise.all([
        apiGet(cfg, "get_live_categories"),
        apiGet(cfg, "get_live_streams"),
      ]);
      if (!Array.isArray(streams)) throw new Error("No channel list came back. The account may be expired or not active yet.");
      state.categories = Array.isArray(cats) ? cats : [];
      state.streams = streams;
      state.cat = "all";
      state.shown = PAGE_SIZE;
      if (!q("#live-list")) return; // user navigated away
      fillCategories();
      renderList();
    } catch (e) {
      if (list) list.innerHTML = `<div class="empty">${esc(e.message || "Couldn't load channels.")}</div>`;
    }
  }

  // ---------- pages ----------
  function renderSetup(rows, prefill, errorMsg) {
    const p = prefill || {};
    rows.innerHTML = `
      <div class="page-header"><h1>Live TV</h1>
        <div class="page-header-actions"><a href="#/" class="page-action-btn">← Home</a></div></div>
      <form id="live-form" class="live-form" autocomplete="off">
        <h2>Connect your IPTV</h2>
        <p class="live-note">Enter the login from your provider. It's saved only in this browser and sent only to your own proxy — never stored on GitHub or Vercel.</p>
        ${errorMsg ? `<div class="live-err">${esc(errorMsg)}</div>` : ""}
        <label>Server URL<input class="yt-search-input" id="live-f-server" placeholder="http://your-provider.example" value="${esc(p.server || "")}" required></label>
        <label>Username<input class="yt-search-input" id="live-f-user" value="${esc(p.username || "")}" required></label>
        <label>Password<input class="yt-search-input" id="live-f-pass" type="password" required></label>
        <label>Proxy URL <span class="live-sub">(optional — leave blank to use this site)</span><input class="yt-search-input" id="live-f-proxy" placeholder="https://your-own-proxy.example" value="${esc(p.proxy || "")}"></label>
        <button type="submit" class="btn" id="live-f-submit">Connect</button>
      </form>`;
    q("#live-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const cfg = {
        server: normServer(q("#live-f-server").value),
        username: q("#live-f-user").value.trim(),
        password: q("#live-f-pass").value.trim(),
        proxy: normProxy(q("#live-f-proxy").value),
      };
      if (!cfg.server || !cfg.username || !cfg.password) {
        renderSetup(rows, cfg, "Please fill in every field with a valid address.");
        return;
      }
      const btn = q("#live-f-submit");
      btn.disabled = true; btn.textContent = "Checking…";
      try {
        const info = await apiGet(cfg);
        const ui = info && info.user_info;
        if (!ui || String(ui.auth) !== "1") throw new Error("The provider rejected this login. Check the username and password.");
        if (ui.status && String(ui.status).toLowerCase() !== "active") throw new Error(`Account status: ${ui.status}.`);
        saveCfg(cfg);
        showLivePage();
      } catch (err) {
        renderSetup(rows, cfg, err.message || "Couldn't connect.");
      }
    });
  }

  function renderMain(rows, cfg) {
    state.cfg = cfg;
    state.cat = "all"; state.term = ""; state.shown = PAGE_SIZE; state.current = null;
    rows.innerHTML = `
      <div class="page-header"><h1>Live TV</h1>
        <div class="page-header-actions">
          <button type="button" class="page-action-btn" id="live-account">Account</button>
          <button type="button" class="page-action-btn" id="live-logout">Change login</button>
        </div></div>
      <div class="live-wrap">
        <div class="live-player">
          <video id="live-video" controls playsinline autoplay></video>
          <div class="live-overlay" id="live-overlay"><div class="live-msg">Pick a channel to start watching</div></div>
        </div>
        <div class="live-now" id="live-now"></div>
        <div class="live-controls">
          <input type="search" id="live-search" class="yt-search-input" placeholder="Search channels…" autocomplete="off">
          <select id="live-cat" class="live-select"><option>Loading…</option></select>
        </div>
        <div id="live-list" class="live-list"><div class="empty">Loading channels…</div></div>
      </div>`;

    q("#live-list").addEventListener("click", (e) => {
      if (e.target.closest("#live-more")) { state.shown += PAGE_SIZE; renderList(); return; }
      const b = e.target.closest(".live-ch");
      if (!b) return;
      const ch = state.streams.find((s) => String(s.stream_id) === b.dataset.id);
      if (ch) {
        playChannel(ch);
        const pl = q(".live-player");
        if (pl && pl.scrollIntoView) pl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
    q("#live-list").addEventListener("error", (e) => {
      if (e.target && e.target.tagName === "IMG") e.target.remove();
    }, true);

    let t;
    q("#live-search").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => {
        const v = e.target.value.trim().toLowerCase();
        state.term = v ? v.split(/\s+/) : "";
        state.shown = PAGE_SIZE;
        renderList();
      }, 150);
    });
    q("#live-cat").addEventListener("change", (e) => {
      state.cat = e.target.value; state.shown = PAGE_SIZE; renderList();
    });
    q("#live-logout").addEventListener("click", () => {
      teardownPlayer();
      const old = loadCfg() || {};
      clearCfg();
      renderSetup(q("#rows"), { server: old.server, username: old.username, proxy: old.proxy });
    });
    q("#live-account").addEventListener("click", async () => {
      try {
        const info = await apiGet(cfg);
        const ui = info && info.user_info;
        if (!ui) throw new Error("No account info returned.");
        const exp = ui.exp_date && Number(ui.exp_date) > 0
          ? new Date(Number(ui.exp_date) * 1000).toLocaleString() : "no expiry listed";
        toast(`Account ${ui.status || "?"} · expires ${exp} · connections ${ui.active_cons || 0}/${ui.max_connections || "?"}`);
      } catch (e) { toast(e.message || "Couldn't read account info."); }
    });

    loadChannels(cfg);
  }

  async function showLivePage() {
    try { if (typeof setActive === "function") setActive("live"); } catch {}
    document.body.classList.add("no-hero");
    try { if (typeof stopHeroTrailer === "function") stopHeroTrailer(); } catch {}
    const rows = q("#rows");
    teardownPlayer();
    const cfg = loadCfg();
    if (!cfg) renderSetup(rows);
    else renderMain(rows, cfg);
  }
  window.showLivePage = showLivePage;

  // Stop playback (and the provider connection) when leaving the Live TV page.
  window.addEventListener("hashchange", () => {
    if (!/^#\/?live(\/|\?|$)/.test(location.hash)) {
      state.playToken++;
      teardownPlayer();
    }
  });
})();
