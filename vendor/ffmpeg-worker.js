// Our own tiny worker around the raw ffmpeg-core WASM module — deliberately
// NOT using @ffmpeg/ffmpeg's wrapper library, which (as of 0.12.15) has a
// confirmed packaging bug: its own classWorkerURL override is ignored, and
// it falls back to an absolute file:// path baked into the published
// package from the original developer's machine. Calling createFFmpegCore()
// directly, same-origin, in a plain classic worker sidesteps that (and the
// cross-origin Worker-construction restriction) entirely — verified by hand
// against a real failing 4K HEVC stream.
importScripts("./ffmpeg-core.js");

let modulePromise = null;
function getModule() {
  if (!modulePromise) {
    modulePromise = createFFmpegCore({
      locateFile: (path) => (path.endsWith(".wasm") ? "./ffmpeg-core.wasm" : path),
      logger: ({ message }) => postMessage({ type: "log", message }),
    });
  }
  return modulePromise;
}

self.onmessage = async (e) => {
  const { type, id } = e.data;
  try {
    if (type === "load") {
      await getModule();
      postMessage({ type: "loaded", id });
      return;
    }
    if (type === "transcode") {
      const Module = await getModule();
      const { bytes, inputName, args } = e.data;
      Module.FS.writeFile(inputName, bytes);
      const ret = Module.exec(...args);
      if (ret !== 0) throw new Error(`ffmpeg exited with code ${ret}`);
      const data = Module.FS.readFile("output.mp4");
      // Clean up so the virtual FS doesn't grow unbounded across the many
      // growing-prefix re-runs a single long stream does.
      try { Module.FS.unlink(inputName); } catch {}
      try { Module.FS.unlink("output.mp4"); } catch {}
      postMessage({ type: "result", id, data }, [data.buffer]);
      return;
    }
  } catch (err) {
    postMessage({ type: "error", id, message: String(err && err.message || err) });
  }
};
