# IPTV proxy (Live TV tab)

A small Cloudflare Worker that lets the MovieBox website (https) play an IPTV
provider's streams (usually plain http, no CORS headers).

Your provider login is **not** stored here or in the repo. You type it into the
Live TV page; it is saved in your browser only and sent with each request.

## Deploy (free)

```
cd worker-iptv
wrangler login
wrangler secret put RELAY_SECRET     # paste any long random string
wrangler deploy
```

Copy the URL it prints (like `https://moviebox-iptv-proxy.<handle>.workers.dev`).
Paste it into the **Proxy URL** box on the Live TV page, or set
`LIVE_PROXY_BASE` at the top of `live.js`.

`RELAY_SECRET` is only needed for HLS (`.m3u8`) streams. Raw `.ts` streams work
without it, but set it anyway.

## Settings (wrangler.toml)

- `ALLOWED_HOSTS` – provider hostnames the proxy may contact (no ports, no http://).
- `ALLOWED_ORIGINS` – websites allowed to call the proxy. localhost is always allowed.
- Optional `UPSTREAM_UA` – User-Agent sent to the provider (default: VLC).

## Notes

- Free plan: 100k requests/day. HLS uses one request per few seconds of video,
  so it's plenty for personal use.
- Trials and cheap plans often allow **1 connection at a time**. Don't watch on
  two devices at once, and close the tab when you're done.
- Cloudflare Workers can only reach standard provider ports. If your provider
  uses an unusual port, streams will fail through this Worker.
- Browsers play H.264 video with AAC audio. Channels with AC3/other audio may
  show video with no sound, or not play at all.
