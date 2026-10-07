#!/usr/bin/env node
// MovieBox VLC Companion — a tiny local background process the MovieBox
// website talks to over localhost HTTP, purely so it can launch the user's
// own installed VLC directly (child_process.spawn), something a website can
// never do on its own — browsers sandbox that away deliberately. No browser
// workaround (vlc:// protocol links, downloaded .m3u files) is as reliable
// as this, because a local process isn't sandboxed the way a page is.
//
// Run: node server.js   (or: npm start)
// Stop: Ctrl+C
"use strict";

const http = require("http");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");

const PORT = Number(process.env.MOVIEBOX_COMPANION_PORT) || 53218;

// Only these sites may ask this companion to launch anything — otherwise
// any random webpage you happen to visit could probe localhost and trigger
// VLC launches of its own choosing. Add your own deployed domain here if
// you host MovieBox somewhere other than the default.
const ALLOWED_ORIGINS = new Set([
  "https://moviebox-peach-chi.vercel.app",
  "http://localhost:3000",
  "http://localhost:8813",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:8813",
]);

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Any Vercel preview deployment of this same project (moviebox-<hash>-avc24.vercel.app).
  return /^https:\/\/moviebox-[a-z0-9]+-avc24\.vercel\.app$/.test(origin);
}

// Only ever launch VLC pointed at either our own proxy's stream endpoints,
// or a direct Xtream Codes stream URL (/movie|series|live/USER/PASS/ID.ext)
// — never an arbitrary URL a page might ask for. The direct-URL shape is
// what VLC hand-off actually uses (see app.js iptvDirectURL): routing VLC
// through Vercel hit two real problems — this provider's CDN edges
// inconsistently block Vercel's IPs per-title, and Vercel functions hard-cap
// execution at 60s, well under a movie's runtime — so VLC connects straight
// to the provider from this machine's own network instead. The real access
// control here is the Origin allowlist above, not this path shape; this is
// just a sanity check against being used as a generic URL launcher.
function urlAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (/^\/api\/iptv\/(vod|live)$/.test(u.pathname)) return true;
  return /^\/(movie|series|live)\/[^/]+\/[^/]+\/\d+\.[a-z0-9]+$/i.test(u.pathname);
}

// Built from env vars rather than a hardcoded "C:\" — Program Files can
// live on a different drive, and %ProgramFiles(x86)% doesn't exist at all
// on 32-bit Windows, hence the fallback to %ProgramFiles%.
const PROGRAM_FILES = process.env["ProgramFiles"] || "C:\\Program Files";
const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] || PROGRAM_FILES;
const LOCAL_APPDATA = process.env.LOCALAPPDATA || (os.homedir() + "\\AppData\\Local");

const VLC_CANDIDATES = {
  win32: [
    `${PROGRAM_FILES}\\VideoLAN\\VLC\\vlc.exe`,
    `${PROGRAM_FILES_X86}\\VideoLAN\\VLC\\vlc.exe`,
    // The official installer also offers a per-user install (no admin
    // rights needed) that lands here instead of Program Files.
    `${LOCAL_APPDATA}\\Programs\\VideoLAN\\VLC\\vlc.exe`,
  ],
  darwin: [
    "/Applications/VLC.app/Contents/MacOS/VLC",
    `${os.homedir()}/Applications/VLC.app/Contents/MacOS/VLC`,
  ],
  linux: [
    "/usr/bin/vlc",
    "/usr/local/bin/vlc",
    "/snap/bin/vlc",
    "/var/lib/flatpak/exports/bin/org.videolan.VLC",
  ],
};

let cachedVlcPath = null;
function findVlc(cb) {
  if (process.env.VLC_PATH) return cb(fs.existsSync(process.env.VLC_PATH) ? process.env.VLC_PATH : null);
  if (cachedVlcPath) return cb(cachedVlcPath);
  const candidates = VLC_CANDIDATES[process.platform] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) { cachedVlcPath = p; return cb(p); }
  }
  // Fall back to whatever "vlc" resolves to on PATH (common on Linux/macOS
  // installs via package manager / brew rather than the .app bundle).
  const probe = process.platform === "win32" ? "where" : "which";
  execFile(probe, ["vlc"], (err, stdout) => {
    const found = !err && stdout.trim() ? stdout.trim().split(/\r?\n/)[0] : null;
    cachedVlcPath = found;
    cb(found);
  });
}

function send(res, status, body, origin) {
  const headers = { "Content-Type": "application/json" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const allowed = originAllowed(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(allowed ? 204 : 403, {
      "Access-Control-Allow-Origin": allowed ? origin : "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/ping") {
    send(res, 200, { ok: true, name: "moviebox-vlc-companion" }, allowed ? origin : null);
    return;
  }

  if (req.method === "POST" && req.url === "/play") {
    if (!allowed) { send(res, 403, { ok: false, error: "Origin not allowed" }, null); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on("end", () => {
      let data;
      try { data = JSON.parse(body); } catch { send(res, 400, { ok: false, error: "Bad JSON" }, origin); return; }
      if (!urlAllowed(data.url)) { send(res, 400, { ok: false, error: "URL not allowed" }, origin); return; }

      findVlc((vlcPath) => {
        if (!vlcPath) { send(res, 500, { ok: false, error: "VLC not found. Set VLC_PATH env var to its executable." }, origin); return; }
        const args = [data.url];
        if (data.title) args.push(`--meta-title=${data.title}`);
        let responded = false;
        let child;
        try {
          child = spawn(vlcPath, args, { detached: true, stdio: "ignore" });
        } catch (e) {
          send(res, 500, { ok: false, error: String(e && e.message || e) }, origin);
          return;
        }
        // spawn() doesn't throw for a bad executable path — it emits an
        // *async* "error" event instead. Leaving that unhandled crashes the
        // whole Node process (verified by hand: this took the companion
        // down entirely after VLC got uninstalled mid-session), so every
        // spawn needs a listener even though we don't use it to report back
        // most of the time. Also clears the cached VLC path on failure, so
        // a reinstalled/moved VLC gets re-detected on the next request
        // instead of the companion repeating the same stale path forever.
        child.on("error", (e) => {
          cachedVlcPath = null;
          if (!responded) { responded = true; send(res, 500, { ok: false, error: `Couldn't launch VLC: ${e.message}` }, origin); }
        });
        child.on("spawn", () => {
          child.unref();
          if (!responded) { responded = true; send(res, 200, { ok: true }, origin); }
        });
      });
    });
    return;
  }

  send(res, 404, { ok: false, error: "Not found" }, allowed ? origin : null);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MovieBox VLC companion listening on http://127.0.0.1:${PORT}`);
  findVlc((p) => console.log(p ? `Found VLC at: ${p}` : "VLC not found yet — set VLC_PATH env var if auto-detect fails."));
});
