// Renders one track of the edited programme, chunk by chunk.
// The source is the track's own recording at the output sample rate; each kept segment is
// read from the position given by the track's clock map, with the gate applied and short
// fades at every joint.

import { FRAME_RATE } from './vad.js';

/**
 * @param {object} o
 * @param {Float32Array|Int16Array} o.src  source samples (mono, at o.rate)
 * @param {number} o.srcScale  multiply source values by this (1/32768 for Int16)
 * @param {{a:number,b:number}} o.map  fileTime = a * T + b
 * @param {Float32Array|null} o.env  gate gain per frame on the common timeline
 * @param {{segs:Array, totalLen:number, rate:number}} o.layout  from segmentsInSamples()
 * @param {number} o.gain  linear gain
 * @param {number} o.fadeMs  fade length at each joint
 * @param {number} o.chunk  samples per yielded chunk
 */
export function* renderTrack({ src, srcScale = 1, map, env = null, layout, gain = 1, fadeMs = 8, chunk = 1 << 18 }) {
  const rate = layout.rate;
  const segs = layout.segs;
  const F = Math.max(1, Math.round((fadeMs * rate) / 1000));
  const fadeTab = new Float32Array(F);
  for (let i = 0; i < F; i++) fadeTab[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / F);
  const frPerSample = FRAME_RATE / rate;
  const envLen = env ? env.length : 0;
  const srcLen = src.length;
  let buf = new Float32Array(Math.min(chunk, Math.max(1, layout.totalLen)));
  let bp = 0;
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    const len = s.len;
    const srcStart = Math.round((map.a * s.start + map.b) * rate);
    const p0 = s.start * FRAME_RATE;
    const fadeIn = si > 0 ? Math.min(F, len >> 1) : 0;
    const fadeOut = si < segs.length - 1 ? Math.min(F, len >> 1) : 0;
    for (let n = 0; n < len; n++) {
      const idx = srcStart + n;
      let v = idx >= 0 && idx < srcLen ? src[idx] * srcScale : 0;
      if (env) {
        const p = p0 + n * frPerSample;
        let f0 = p | 0;
        if (f0 >= envLen - 1) v *= env[envLen - 1];
        else {
          if (f0 < 0) f0 = 0;
          const fr = p - f0;
          v *= env[f0] + (env[f0 + 1] - env[f0]) * fr;
        }
      }
      if (n < fadeIn) v *= fadeTab[Math.floor((n * F) / fadeIn)];
      else if (n >= len - fadeOut) v *= fadeTab[Math.floor(((len - 1 - n) * F) / fadeOut)];
      buf[bp++] = v * gain;
      if (bp === buf.length) {
        yield buf;
        buf = new Float32Array(buf.length);
        bp = 0;
      }
    }
  }
  if (bp > 0) yield buf.subarray(0, bp);
}

/** Small helper so long loops can let the page repaint. */
export function yieldToUI() {
  return new Promise((r) => setTimeout(r, 0));
}
