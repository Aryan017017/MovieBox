# MovieBox VLC Companion

A tiny local background process (plain Node.js, no dependencies) that lets
the MovieBox website launch your own installed VLC directly, with the
stream already loaded — no download, no `vlc://` protocol-registration
guesswork.

## Why this exists

A website can never launch a desktop app on its own — browsers deliberately
block that. The only browser-side workarounds (a `vlc://` link, or
downloading a tiny `.m3u` file for you to open) depend on your OS having
that already wired up, which isn't reliable everywhere. This companion
sidesteps all of that: it's a normal local process, so it can just run
`vlc <url>` directly, the same way opening a terminal and typing that
command would.

## Run it

```bash
cd companion
node server.js
```

Leave it running in the background while you use MovieBox. It listens on
`http://127.0.0.1:53218` and does nothing until the website asks it to
launch something.

## Security model

- Only requests whose `Origin` matches MovieBox's own deployed domain (or
  `localhost` during development) are accepted — not just any webpage that
  happens to know the port.
- It will only ever launch VLC pointed at this project's own `/api/iptv/vod`
  or `/api/iptv/live` proxy endpoints, or a direct Xtream Codes stream URL
  (`/movie|series|live/USER/PASS/ID.ext`) — never an arbitrary URL a page
  might send it. The real protection is the Origin check above; this is a
  secondary sanity check, not the security boundary.
- It only ever runs the single command `vlc <url>`. It does not execute
  arbitrary shell input.

## VLC not found?

It checks the common install locations for your OS, then falls back to
whatever `vlc` resolves to on your `PATH`. If none of that finds it, set the
`VLC_PATH` environment variable to VLC's executable:

```bash
VLC_PATH="/path/to/vlc" node server.js
```

## Run it automatically at login (optional)

- **macOS/Linux**: add a launch agent / systemd user service that runs
  `node /path/to/companion/server.js`.
- **Windows**: add a shortcut to `node.exe server.js` (with the working
  directory set to this folder) to your Startup folder.

Packaging this into a standalone executable (no Node.js install required)
is a reasonable next step if you want to hand this to someone else, but
isn't done here — run it with Node.js for now.
