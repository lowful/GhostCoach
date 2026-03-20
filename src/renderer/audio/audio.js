(async function () {
  'use strict';

  // ─── Thresholds ────────────────────────────────────────────────────────────────
  // RMS amplitude 0–1.0
  // Valorant gunshots spike to ~0.3–0.5 RMS; quiet gameplay ~0.01–0.05
  const COMBAT_THRESHOLD = 0.30;   // above → combat
  const QUIET_THRESHOLD  = 0.06;   // below → quiet
  const CHECK_INTERVAL   = 500;    // ms

  let currentState = 'quiet';

  try {
    // Get the screen source ID (needed for desktop audio capture)
    const sourceId = await window.audioAPI.getDesktopSourceId();
    if (!sourceId) {
      console.warn('[audio] No desktop source found');
      window.audioAPI.sendAudioEvent('unavailable');
      return;
    }

    // Capture system audio via desktop loopback
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        }
      },
      video: false,
    });

    const ctx      = new AudioContext();
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize               = 2048;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    const data = new Float32Array(analyser.fftSize);

    function analyze() {
      analyser.getFloatTimeDomainData(data);

      let rms = 0;
      for (let i = 0; i < data.length; i++) rms += data[i] * data[i];
      rms = Math.sqrt(rms / data.length);

      const newState = rms > COMBAT_THRESHOLD ? 'combat' : 'quiet';

      if (newState !== currentState) {
        currentState = newState;
        window.audioAPI.sendAudioEvent(currentState);
      }
    }

    setInterval(analyze, CHECK_INTERVAL);
    window.audioAPI.sendAudioEvent('ready');

  } catch (err) {
    console.warn('[audio] Capture failed:', err.message);
    window.audioAPI.sendAudioEvent('unavailable');
  }
})();
