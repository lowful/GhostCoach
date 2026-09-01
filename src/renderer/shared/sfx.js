/**
 * The two sounds the app makes: coaching armed, and coaching stood down.
 *
 * Synthesised rather than shipped as files, for three reasons that all matter
 * here. The overlay's CSP is `default-src 'self'` with no media-src, and Web
 * Audio needs no source at all, so this cannot be blocked. Nothing is added to
 * the installer. And the shape of the sound is in the code, where it can be
 * tuned by ear against the game rather than by opening an audio editor.
 *
 * The brief was "cool, and fits the vibe", and the vibe is a tactical shooter,
 * so these are not notification chimes. Arming is a mechanical latch and a
 * rising perfect fifth: something engaging. Standing down is the same interval
 * falling, with a low body under it: something releasing. Both are under a
 * third of a second, because this plays over a game somebody is concentrating
 * on and a sound that outstays its welcome once will be muted forever.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.occlaraSfx = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

/** Quiet on purpose. This sits under game audio, it does not compete with it. */
const GAIN = 0.16;

/**
 * A perfect fifth, up to arm and down to stand down.
 *
 * C5 and G5. Consonant enough that it never reads as an error, and far enough
 * apart that the direction is unmistakable at a glance, which is the entire
 * job: without looking, was that on or off.
 */
const LOW = 523.25;
const HIGH = 783.99;

let ctx = null;

/**
 * Made on first use and kept.
 *
 * A context per sound leaks them, and browsers cap how many a page may have,
 * so the tenth round of a match would fall silent. Creating it lazily also
 * keeps a suspended context out of the way until something actually plays.
 */
function audio() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { ctx = null; }
  return ctx;
}

/** One voice: an oscillator through its own envelope. */
function tone(at, freq, dur, type, peak) {
  const c = audio();
  if (!c) return;

  const osc = c.createOscillator();
  const gain = c.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);

  /*
   * A four millisecond attack rather than an instant one.
   *
   * Starting a gain at full value steps the waveform from silence, and a step
   * is a click at every frequency at once. It is heard as a spit rather than
   * as the start of a note, and on cheap speakers it is the loudest part of
   * the sound.
   */
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);

  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/**
 * The mechanical part: a very short burst of filtered noise.
 *
 * What separates a tactical interface sound from a doorbell. The tones say
 * which direction, this says the thing is a piece of equipment.
 */
function latch(at, freq, level) {
  const c = audio();
  if (!c) return;

  const frames = Math.floor(c.sampleRate * 0.05);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  // Decaying white noise. The exponent is steep so this reads as a click with
  // body rather than as a hiss.
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 6);
  }

  const src = c.createBufferSource();
  src.buffer = buf;

  // Bandpassed, so it sits with the tones instead of spraying across the
  // spectrum and sounding like static.
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(freq, at);
  band.Q.setValueAtTime(1.1, at);

  const gain = c.createGain();
  gain.gain.setValueAtTime(level, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);

  src.connect(band).connect(gain).connect(c.destination);
  src.start(at);
}

/**
 * Play one of the two sounds.
 *
 * `kind` is 'start' or 'stop'. Anything else is ignored rather than throwing:
 * this is a sound effect, and a surface that crashes because it could not
 * make a noise is a far worse bug than silence.
 */
function play(kind, volume) {
  const c = audio();
  if (!c) return;

  /*
   * A context created before any gesture starts suspended, and a suspended
   * context schedules everything and plays nothing. Resuming is a promise
   * nobody needs to wait for: by the time the notes are due it has resolved,
   * and if it has not there was no gesture and the sound was never going to
   * play anyway.
   */
  if (c.state === 'suspended') { try { void c.resume(); } catch { /* no gesture yet */ } }

  const level = GAIN * (typeof volume === 'number' ? Math.max(0, Math.min(1, volume)) : 1);
  if (level <= 0) return;

  const t = c.currentTime + 0.01;

  if (kind === 'start') {
    // Latch, then the fifth rising. The second note overlaps the first
    // slightly so it reads as one gesture rather than as two beeps.
    latch(t, 2200, level * 0.5);
    tone(t + 0.005, LOW, 0.09, 'triangle', level);
    tone(t + 0.065, HIGH, 0.16, 'triangle', level);
    // A quiet octave above the top note, which is what makes it sound
    // engineered rather than plucked.
    tone(t + 0.065, HIGH * 2, 0.1, 'sine', level * 0.28);
    return;
  }

  if (kind === 'stop') {
    // The same interval falling, and a low sine underneath for weight, so
    // standing down lands rather than trails off.
    latch(t, 1400, level * 0.4);
    tone(t + 0.005, HIGH, 0.08, 'triangle', level * 0.9);
    tone(t + 0.06, LOW, 0.2, 'triangle', level * 0.9);
    tone(t + 0.06, LOW / 4, 0.24, 'sine', level * 0.5);
  }
}

  return { play };
}));
