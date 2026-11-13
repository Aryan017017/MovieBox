// =========================================================================
// Universal player — our own in-browser "VLC": when the native <video>
// element can't play a stream (wrong codec — HEVC, AC3, etc. — regardless
// of container), this transcodes it to H.264/AAC using a real build of
// FFmpeg compiled to WebAssembly, running in a dedicated worker so the
// page stays responsive, and feeds the result into <video> via
// MediaSource as it goes. Verified by hand against a real PenguPlay 4K
// HEVC stream that was completely unplayable natively.
//
// Deliberately NOT using the official @ffmpeg/ffmpeg wrapper library — as
// of 0.12.15 it has a confirmed packaging bug (its classWorkerURL override
// is ignored; it falls back to an absolute file:// path baked into the
// published package from the original developer's machine) that makes it
// unusable outside a bundler-managed build. vendor/ffmpeg-worker.js calls
// the raw ffmpeg-core WASM module directly instead — same underlying
// engine, none of the wrapper's bugs.
//
// Known v1 limits:
//  - No seeking yet — scrubbing ahead of what's been transcoded snaps back.
//  - Software transcode only, no WebCodecs/hardware fast path yet.
//  - "Growing prefix" strategy: every new chunk re-transcodes from the
//    start (ffmpeg-core has no true incremental/streaming input in its
//    public API), so this gets slower deeper into a long stream. Measured
//    ~54x slower than real-time for a 4K HEVC stream in one environment —
//    expect dramatically better for 1080p/lower-bitrate content, and
//    better still on real desktop hardware. This is why it's only used as
//    a last resort after native <video> has already failed.
// =========================================================================

(function () {
  "use strict";

  const CHUNK_BYTES = 6 * 1024 * 1024; // how much new source data triggers the next transcode round
  const TRIM_MARGIN_BYTES = 600 * 1024; // see trimSafeOutput() below
  const MAX_LEAD_SECONDS = 45; // don't bother transcoding further ahead than this of currentTime

  let worker = null;
  let workerReady = null;
  let msgId = 0;
  const pending = new Map();

  function getWorker() {
    if (!worker) {
      worker = new Worker("/vendor/ffmpeg-worker.js");
      worker.onmessage = (e) => {
        const { type, id, message, data } = e.data;
        const p = pending.get(id);
        if (!p) return;
        if (type === "error") { pending.delete(id); p.reject(new Error(message)); }
        else if (type === "result") { pending.delete(id); p.resolve(data); }
        // type "log" is informational only, no pending entry to resolve.
      };
      worker.onerror = (e) => {
        // Rejects every in-flight call — a worker-level error means the
        // whole worker is in an unknown state, not just the current call.
        for (const [, p] of pending) p.reject(new Error("Worker error: " + e.message));
        pending.clear();
      };
    }
    if (!workerReady) {
      workerReady = send({ type: "load" });
    }
    return workerReady;
  }

  function send(msg, transfer) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  // Fragmented-MP4 output ("frag_keyframe+empty_moov"): re-running ffmpeg
  // on a longer prefix of the same source reproduces the earlier fragments
  // byte-for-byte (single-threaded, deterministic encode) EXCEPT the very
  // last fragment, which ffmpeg writes differently depending on whether
  // more input follows it or not (end-of-stream flush vs. a normal
  // mid-stream fragment boundary). Trimming a safety margin off the end of
  // each round's output avoids ever feeding MediaSource a fragment that
  // might not match what the next round produces for that same span —
  // the trimmed tail simply gets included (correctly) on the next round.
  function trimSafeOutput(output) {
    if (output.length <= TRIM_MARGIN_BYTES) return 0;
    return output.length - TRIM_MARGIN_BYTES;
  }

  function extFromUrl(url) {
    const path = url.split("?")[0].split("#")[0];
    const m = /\.([a-z0-9]{2,5})$/i.exec(path);
    return m ? m[1].toLowerCase() : "bin";
  }

  const TRANSCODE_ARGS = (inputName) => [
    "-i", inputName,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-c:a", "aac",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "output.mp4",
  ];

  // Resolves once playback has actually started, or rejects if it never
  // manages to. The download+transcode loop keeps running in the
  // background after that — not awaited by this function — until the
  // source is exhausted, `signal` aborts, or it hits an error (silently
  // stalling playback at whatever got buffered, same as a network drop
  // would on a plain <video>).
  function play(video, fetchUrl, { onStatus, signal } = {}) {
    const status = (s) => { try { onStatus && onStatus(s); } catch {} };
    let stopped = false;
    const cleanup = () => { stopped = true; };
    if (signal) signal.addEventListener("abort", cleanup);

    return new Promise((resolveStart, rejectStart) => {
      let settled = false;
      const started = () => { if (!settled) { settled = true; resolveStart(); } };
      const failed = (e) => { if (!settled) { settled = true; rejectStart(e); } };

      (async () => {
        status("Loading the in-browser converter…");
        await getWorker();
        if (stopped) throw new Error("aborted");

        const inputName = "input." + extFromUrl(fetchUrl);
        const mediaSource = new MediaSource();
        const srcUrl = URL.createObjectURL(mediaSource);
        video.src = srcUrl;
        video.controls = true;

        let sourceBuffer = null;
        let fedBytes = 0; // how much of the latest full output has been appended so far
        let seekBlocked = false;

        const onSeeking = () => {
          if (seekBlocked) return;
          const buffered = video.buffered;
          let ok = false;
          for (let i = 0; i < buffered.length; i++) {
            if (video.currentTime >= buffered.start(i) - 0.5 && video.currentTime <= buffered.end(i) + 0.5) { ok = true; break; }
          }
          if (!ok && buffered.length) {
            seekBlocked = true;
            video.currentTime = buffered.end(buffered.length - 1);
            status("Can't seek ahead of what's been converted yet.");
            setTimeout(() => { seekBlocked = false; }, 50);
          }
        };
        video.addEventListener("seeking", onSeeking);
        if (signal) signal.addEventListener("abort", () => {
          video.removeEventListener("seeking", onSeeking);
          try { URL.revokeObjectURL(srcUrl); } catch {}
        });

        await new Promise((resolve) => {
          mediaSource.addEventListener("sourceopen", () => {
            sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
            resolve();
          }, { once: true });
        });
        if (stopped) throw new Error("aborted");

        function appendToSourceBuffer(bytes) {
          return new Promise((resolve, reject) => {
            const onUpdateEnd = () => { sourceBuffer.removeEventListener("updateend", onUpdateEnd); resolve(); };
            sourceBuffer.addEventListener("updateend", onUpdateEnd);
            try { sourceBuffer.appendBuffer(bytes); }
            catch (e) { sourceBuffer.removeEventListener("updateend", onUpdateEnd); reject(e); }
          });
        }

        // Fetches the whole source progressively (one connection, not
        // repeated Range requests — we already have everything fetched so
        // far in memory, so there's no reason to re-download it) and
        // triggers a transcode round every CHUNK_BYTES of new data.
        const res = await fetch(fetchUrl, signal ? { signal } : undefined);
        if (!res.ok || !res.body) throw new Error(`Couldn't fetch the stream (${res.status})`);
        const reader = res.body.getReader();

        let buffer = new Uint8Array(0);
        function appendSource(chunk) {
          const next = new Uint8Array(buffer.length + chunk.length);
          next.set(buffer, 0);
          next.set(chunk, buffer.length);
          buffer = next;
        }

        async function transcodeAndFeed(isFinal) {
          status(`Converting for your browser… (${(buffer.length / 1048576).toFixed(0)}MB so far)`);
          const copy = buffer.slice(); // the worker call transfers its buffer; keep our own copy for the next round
          const output = await send({ type: "transcode", inputName, bytes: copy, args: TRANSCODE_ARGS(inputName) }, [copy.buffer]);
          // See trimSafeOutput()'s comment — a non-final round's trailing
          // fragment may not match how that same span is encoded once more
          // input follows it, so only the final round is safe to feed whole.
          const safeEnd = isFinal ? output.length : trimSafeOutput(output);
          if (safeEnd > fedBytes) {
            await appendToSourceBuffer(output.subarray(fedBytes, safeEnd));
            fedBytes = safeEnd;
          }
          if (fedBytes > 0) {
            status("");
            video.play().catch(() => {});
            started();
          }
        }

        let lastRoundAt = 0;
        for (;;) {
          if (stopped) return;
          const { done, value } = await reader.read();
          if (done) break;
          appendSource(value);

          // Heavy content transcodes slower than it plays — no point
          // piling more rounds on top of one another faster than they
          // resolve, and no point getting far ahead of where the viewer
          // actually is.
          const lead = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
          if (buffer.length - lastRoundAt >= CHUNK_BYTES && lead < MAX_LEAD_SECONDS) {
            lastRoundAt = buffer.length;
            await transcodeAndFeed(false);
          }
        }
        if (stopped) return;
        if (buffer.length > lastRoundAt) await transcodeAndFeed(true);
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
        if (fedBytes === 0) throw new Error("Never produced enough output to start playback");
      })().catch((e) => { cleanup(); failed(e); });
    });
  }

  window.UniversalPlayer = {
    isSupported() {
      return typeof MediaSource !== "undefined" && typeof Worker !== "undefined";
    },
    play,
  };
})();
