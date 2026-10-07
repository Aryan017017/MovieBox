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

## Platform support

| Platform | How "Open in VLC" works |
|---|---|
| Windows | This companion, running locally (`node server.js`). Auto-detects VLC in Program Files, the per-user install location, or PATH. |
| Linux | This companion, same as Windows. Checks common package manager, snap, and flatpak install paths. |
| macOS | This companion, same as Windows. Checks `/Applications/VLC.app`. |
| Android | No companion possible on a phone — uses Android's `intent://` mechanism to launch VLC for Android directly, with a Play Store fallback if it's not installed. |
| iOS | No companion possible either — VLC for iOS registers the `vlc://` URL scheme itself (`vlc://<stream-url>` is its own documented external-link format), so a plain link handles it with no extra code needed. |

Desktop (Windows/Linux/macOS) without the companion running falls back to a
plain `vlc://` link, which only works if that protocol happens to be
registered with your OS — not guaranteed. Running the companion is what
makes it actually automatic on desktop.

## Run it (Windows, Linux, macOS)

```bash
cd companion
node server.js
```

On Windows, if you don't already have Node.js, install it from
[nodejs.org](https://nodejs.org) first, then run the same command from a
terminal (PowerShell or Command Prompt) in the `companion` folder.

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

On Windows (PowerShell):

```powershell
$env:VLC_PATH="C:\path\to\vlc.exe"; node server.js
```

## Run it automatically at login (optional)

- **macOS/Linux**: add a launch agent / systemd user service that runs
  `node /path/to/companion/server.js`.
- **Windows**: add a shortcut to `node.exe server.js` (with the working
  directory set to this folder) to your Startup folder.

Packaging this into a standalone executable (no Node.js install required)
is a reasonable next step if you want to hand this to someone else, but
isn't done here — run it with Node.js for now.
