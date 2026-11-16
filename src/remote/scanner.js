// Phone camera QR scanner for pairing (camera + jsQR). No UI of its own beyond
// the <video> element: the pairing screen (pairing.js) draws the viewfinder and
// every state's copy from `state()`.
// Exposes window.OMP_REMOTE_SCANNER = { createScanner({ onPair, installed }) } returning
//   { video, state(), onChange(fn) -> off, start(), stop() }.
// state: idle | starting | scanning | denied | unavailable | wrong
//   (`denied`: camera permission refused; `unavailable`: no camera API;
//    `wrong`: a QR for another server, scanning stopped). `onPair(code)` gets
//    the code of a QR for this origin, after the scan was stopped.
(function () {
  const C = window.OMP_REMOTE_CLIENT;

  function createScanner({ onPair, installed }) {
    const video = document.createElement("video");
    video.muted = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("autoplay", "");
    video.hidden = true;
    const canvas = document.createElement("canvas");
    const listeners = new Set();
    let current = "idle";
    // Every stop bumps the generation; an await that resumes under an older one
    // belongs to a cancelled scan and must release what it got and stop.
    let stream = null, timer = null, gen = 0;

    function set(next) {
      current = next;
      video.hidden = next !== "scanning" && next !== "starting";
      for (const fn of [...listeners]) fn(next);
    }

    function release() {
      gen++;
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { for (const track of stream.getTracks()) track.stop(); stream = null; }
      video.pause(); video.srcObject = null;
    }
    function stop() {
      release();
      if (current === "scanning" || current === "starting") set("idle");
    }

    document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
    window.addEventListener("pagehide", stop);

    function poll() {
      if (video.readyState !== video.HAVE_ENOUGH_DATA || !window.jsQR) return;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      if (!result?.data) return;
      const parsed = C.pairCodeFromScan(result.data, location.origin);
      if (parsed?.code) {
        release(); set("idle");
        onPair(parsed.code);
      } else if (parsed?.other) {
        release(); set("wrong");
      }
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) { set("unavailable"); return; }
      release(); // a second tap replaces the running scan instead of leaking it
      const mine = gen;
      set("starting");
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (mine !== gen) { for (const track of media.getTracks()) track.stop(); return; }
        stream = media;
        video.srcObject = media;
        await video.play();
        if (mine !== gen) return; // release already stopped the stream
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        set("scanning");
        timer = setInterval(poll, 125);
      } catch {
        if (mine !== gen) return; // cancelled: not a denial
        release();
        set("denied");
      }
    }

    return {
      video, start, stop,
      state: () => current,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      installed,
    };
  }

  window.OMP_REMOTE_SCANNER = { createScanner };
})();
