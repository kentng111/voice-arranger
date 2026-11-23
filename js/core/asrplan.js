// Which parts of a track are sent to the speech recogniser.
// Only the track owner's own speech is transcribed: speech segments are packed into chunks
// that fit Whisper's 30 s window, and everything outside the owner's speech is turned
// down, so leaked voices and long silences (where Whisper tends to invent text) are skipped.

import { FRAME_RATE } from './vad.js';

/**
 * segments: [[startFrame, endFrame)] speech segments (track-local, from detectSpeech)
 * levels:   frame levels (dB), used to split very long monologues at a quiet point
 * Returns [{ start, end }] in seconds.
 */
export function planAsrChunks(segments, levels, { maxSec = 28, pad = 0.25 } = {}) {
  const fr = FRAME_RATE;
  const maxF = Math.round(maxSec * fr);
  const padF = Math.round(pad * fr);
  const n = levels.length;
  // split segments longer than one chunk at the quietest frame in their second half
  const segs = [];
  for (const [s0, e] of segments) {
    let s = s0;
    while (e - s > maxF - 2 * padF) {
      const lo = s + Math.round((maxF - 2 * padF) * 0.55);
      const hi = s + maxF - 2 * padF;
      let cut = hi;
      let best = Infinity;
      for (let f = lo; f < hi; f++) if (levels[f] < best) { best = levels[f]; cut = f; }
      segs.push([s, cut]);
      s = cut;
    }
    if (e > s) segs.push([s, e]);
  }
  const chunks = [];
  let cur = null;
  for (const [s, e] of segs) {
    const a = Math.max(0, s - padF);
    const b = Math.min(n, e + padF);
    if (cur && b - cur.start <= maxF) {
      cur.end = b;
    } else {
      if (cur) chunks.push(cur);
      cur = { start: a, end: b };
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => ({ start: c.start / fr, end: c.end / fr }));
}

/**
 * Samples of one chunk as Float32 at `rate`, with everything outside `act` (frames where
 * the owner speaks) turned down by `duckDb`, using short ramps.
 */
export function chunkSamples(pcm, rate, chunk, act, { duckDb = -30, scale = pcm instanceof Int16Array ? 1 / 32768 : 1 } = {}) {
  const s0 = Math.max(0, Math.round(chunk.start * rate));
  const s1 = Math.min(pcm.length, Math.round(chunk.end * rate));
  const out = new Float32Array(Math.max(0, s1 - s0));
  const duck = Math.pow(10, duckDb / 20);
  const hop = rate / FRAME_RATE;
  const f0 = Math.floor(s0 / hop);
  const f1 = Math.ceil(s1 / hop) + 1;
  // per-frame gain, smoothed over 2 frames each way
  const g = new Float32Array(f1 - f0 + 1);
  for (let f = f0; f <= f1; f++) {
    let on = 0;
    for (let d = -2; d <= 2; d++) if (act[f + d]) on = 1;
    g[f - f0] = on ? 1 : duck;
  }
  for (let i = 0; i < out.length; i++) {
    const p = (s0 + i) / hop - f0;
    const k = Math.min(g.length - 2, Math.floor(p));
    const fr = p - k;
    out[i] = pcm[s0 + i] * scale * (g[k] + (g[k + 1] - g[k]) * fr);
  }
  return out;
}
