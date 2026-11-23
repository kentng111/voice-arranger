// Plays a few seconds around a point, from the 16 kHz analysis copies kept in memory:
// either the original sound of all tracks (synced) or the edited result.

import { renderTrack } from '../core/render.js';

let ctx = null;
let current = null;

function audioContext() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export function stopSnippet() {
  if (current) {
    try { current.stop(); } catch { /* already stopped */ }
    current = null;
  }
}

function play(samples, rate, onEnd) {
  stopSnippet();
  const ac = audioContext();
  if (ac.state === 'suspended') ac.resume();
  const buf = ac.createBuffer(1, Math.max(1, samples.length), rate);
  buf.copyToChannel(samples, 0);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(ac.destination);
  src.onended = () => { if (current === src) current = null; if (onEnd) onEnd(); };
  src.start();
  current = src;
  return { startedAt: ac.currentTime, ctx: ac, duration: samples.length / rate, src };
}

/** Is this playback (returned by playRaw / playEdited) still the one playing? */
export function isCurrent(handle) {
  return !!handle && current === handle.src;
}

/** Per-track gain that brings each voice to a similar level (from the detected speech level). */
function trackGain(t) {
  const sp = t.vad ? t.vad.speechDb : -20;
  return Math.pow(10, Math.max(-12, Math.min(18, -18 - sp)) / 20);
}

function limit(x) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0.95) {
    const g = 0.95 / peak;
    for (let i = 0; i < x.length; i++) x[i] *= g;
  }
  return x;
}

/**
 * Extra gain per track to pick one voice out of overlapping speech.
 * focus: track index or null; mode: 'all' | 'emphasis' (others -18 dB) | 'solo' (others silent)
 */
export function focusGains(K, focus, mode) {
  const g = new Array(K).fill(1);
  if (focus == null || mode === 'all') return g;
  const other = mode === 'solo' ? 0 : Math.pow(10, -18 / 20);
  for (let k = 0; k < K; k++) if (k !== focus) g[k] = other;
  return g;
}

/** Original sound of every track between T0 and T1 on the common timeline. */
export function playRaw({ tracks, maps, T0, T1, onEnd, gains = null }) {
  const rate = tracks[0].rate;
  const n = Math.max(1, Math.round((T1 - T0) * rate));
  const out = new Float32Array(n);
  tracks.forEach((t, k) => {
    const m = maps[k];
    const g = (trackGain(t) * (gains ? gains[k] : 1)) / 32768;
    if (!g) return;
    const src = t.pcm16;
    for (let i = 0; i < n; i++) {
      const idx = Math.round((m.a * (T0 + i / rate) + m.b) * rate);
      if (idx >= 0 && idx < src.length) out[i] += src[idx] * g;
    }
  });
  return play(limit(out), rate, onEnd);
}

/** Edited result for the part of the programme that came from T0..T1 (cuts, gate and mutes applied). */
export function playEdited({ tracks, maps, gates, plan, T0, T1, onEnd, gains = null }) {
  const rate = tracks[0].rate;
  const segs = [];
  let out = 0;
  for (const s of plan.segments) {
    const a = Math.max(s.start, T0);
    const b = Math.min(s.end, T1);
    if (b <= a) continue;
    const len = Math.round((b - a) * rate);
    segs.push({ start: a, end: b, outStart: out, len });
    out += len;
  }
  const mix = new Float32Array(Math.max(1, out));
  if (out > 0) {
    const layout = { segs, totalLen: out, rate };
    tracks.forEach((t, k) => {
      const gk = gains ? gains[k] : 1;
      if (!gk) return;
      let pos = 0;
      for (const ch of renderTrack({ src: t.pcm16, srcScale: 1 / 32768, map: maps[k], env: gates[k], layout, gain: trackGain(t) * gk, fadeMs: 8 })) {
        for (let i = 0; i < ch.length; i++) mix[pos + i] += ch[i];
        pos += ch.length;
      }
    });
  }
  const handle = play(limit(mix), rate, onEnd);
  handle.segs = segs; // output samples -> common timeline, for following the playhead
  return handle;
}
