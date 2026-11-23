// Filler candidates ("えー", "あのー", ...) for one track.
// Three sources are combined:
//   text  - filler words that the recogniser did write down
//   gap   - speech that the recogniser left without any text (Whisper drops most fillers)
//   sound - a drawn-out, steady voiced sound (えー / あー / うーん / んー)
// Times are seconds in the track's own file. No browser APIs here.

import { fft } from './fft.js';
import { FRAME_RATE } from './vad.js';
import { findTextFillers, isPunct } from './transcript.js';

// ---------------------------------------------------------------- acoustic features

const WIN = 512; // 32 ms at 16 kHz
const NFFT = 1024; // zero-padded so the autocorrelation does not wrap around
const NBANDS = 20;

/**
 * Per 10 ms frame: voicing strength (0..1), pitch (Hz, 0 = unvoiced) and spectral change
 * (mean absolute change of band levels from the previous frame, dB).
 * Only frames where mask[f] is set are analysed (others get voicing 0).
 * pcm: Int16Array (scale 1/32768) or Float32Array at 16 kHz.
 * from/to/out: analyse a slice of frames into an existing result (to keep a page responsive).
 */
export function acousticFeatures(pcm, rate, mask = null, { from = 0, to = Infinity, out = null } = {}) {
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  const hop = Math.round(rate / FRAME_RATE);
  const n = Math.floor(pcm.length / hop);
  const res = out || { voicing: new Float32Array(n), pitch: new Float32Array(n), flux: new Float32Array(n).fill(99), n };
  const { voicing, pitch, flux } = res;
  const win = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / WIN);
  // autocorrelation of the window itself, to undo its taper
  const wac = autocorr(win);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.min(Math.ceil(rate / 70), WIN - 64);
  // band edges (log-spaced 100 Hz .. 4 kHz)
  const edges = [];
  for (let b = 0; b <= NBANDS; b++) edges.push(Math.round((100 * Math.pow(40, b / NBANDS) * NFFT) / rate));
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  let prevBands = null;
  let prevF = -2;
  const bands = new Float64Array(NBANDS);
  for (let f = Math.max(0, from); f < Math.min(n, to); f++) {
    if (mask && !mask[f]) continue;
    const c = f * hop + (hop >> 1) - (WIN >> 1);
    re.fill(0);
    im.fill(0);
    let e = 0;
    for (let i = 0; i < WIN; i++) {
      const idx = c + i;
      const v = idx >= 0 && idx < pcm.length ? pcm[idx] * scale * win[i] : 0;
      re[i] = v;
      e += v * v;
    }
    if (e < 1e-9) continue;
    fft(re, im);
    for (let b = 0; b < NBANDS; b++) {
      let s = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) s += re[k] * re[k] + im[k] * im[k];
      bands[b] = 10 * Math.log10(s + 1e-12);
    }
    if (prevBands && prevF === f - 1) {
      let d = 0;
      for (let b = 0; b < NBANDS; b++) d += Math.abs(bands[b] - prevBands[b]);
      flux[f] = d / NBANDS;
    }
    prevBands = Float64Array.from(bands);
    prevF = f;
    // autocorrelation = inverse FFT of the power spectrum
    for (let k = 0; k < NFFT; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
      im[k] = 0;
    }
    fft(re, im, true);
    const r0 = re[0];
    let best = 0;
    let bl = 0;
    for (let l = minLag; l <= maxLag; l++) {
      const v = re[l] / (r0 * wac[l]);
      if (v > best) { best = v; bl = l; }
    }
    // prefer the shortest lag that is almost as good (avoids octave errors)
    for (let m = 2; m <= 4; m++) {
      const l = Math.round(bl / m);
      if (l < minLag) break;
      let v = 0;
      for (let d = -1; d <= 1; d++) v = Math.max(v, re[l + d] / (r0 * wac[l + d]));
      if (v > 0.9 * best) { bl = l; best = Math.max(best * 0.98, v); }
    }
    voicing[f] = Math.min(1, best);
    pitch[f] = best > 0.45 ? rate / bl : 0;
  }
  return res;
}

function autocorr(x) {
  const r = new Float64Array(x.length);
  for (let l = 0; l < x.length; l++) {
    let s = 0;
    for (let i = 0; i + l < x.length; i++) s += x[i] * x[i + l];
    r[l] = s;
  }
  const r0 = r[0];
  for (let l = 0; l < x.length; l++) r[l] = Math.max(r[l] / r0, 1e-3);
  return r;
}

/**
 * Runs of steady voiced sound ("えーー", "うーん"): voiced, pitch nearly flat and the
 * spectrum (vowel colour) hardly changing, for at least minSec.
 * Returns [{ start, end, score }] in seconds.
 */
export function steadyVoicedRuns(feat, active, { minSec = 0.28, maxSec = 3, fluxMax = 3.0, pitchStep = 0.05, voiceMin = 0.5, allowGap = 3 } = {}) {
  const { voicing, pitch, flux, n } = feat;
  const ok = new Uint8Array(n);
  for (let f = 1; f < n; f++) {
    if (active && !active[f]) continue;
    if (voicing[f] < voiceMin || !pitch[f] || !pitch[f - 1]) continue;
    if (flux[f] > fluxMax) continue;
    if (Math.abs(Math.log2(pitch[f] / pitch[f - 1])) > pitchStep) continue;
    ok[f] = 1;
  }
  const runs = [];
  let f = 0;
  while (f < n) {
    if (!ok[f]) { f++; continue; }
    const s = f;
    let last = f;
    while (f < n && (ok[f] || f - last <= allowGap)) {
      if (ok[f]) last = f;
      f++;
    }
    const len = last + 1 - s;
    if (len >= minSec * FRAME_RATE && len <= maxSec * FRAME_RATE) {
      let fl = 0;
      let p0 = Infinity, p1 = 0;
      for (let i = s; i <= last; i++) {
        fl += Math.min(flux[i], 10);
        if (pitch[i]) { p0 = Math.min(p0, pitch[i]); p1 = Math.max(p1, pitch[i]); }
      }
      fl /= len;
      // a filler stays on one pitch; a sung or exclaimed vowel glides
      const range = p1 > 0 ? Math.log2(p1 / p0) : 1;
      if (range > 0.5) { f = last + 1; continue; }
      const score = Math.min(1, (len / FRAME_RATE - minSec) / 0.4 + 0.3) * Math.max(0, 1 - fl / (fluxMax * 1.5));
      runs.push({ start: s / FRAME_RATE, end: (last + 1) / FRAME_RATE, score: +score.toFixed(2) });
    }
    f = last + 1;
  }
  return runs;
}

// ---------------------------------------------------------------- boundaries

/**
 * Move a boundary to the quietest 10 ms frame nearby, so a cut lands between sounds.
 * levels: track-local frame levels (dB).
 */
export function snapToValley(levels, t, before, after) {
  const f = Math.round(t * FRAME_RATE);
  const a = Math.max(0, f - Math.round(before * FRAME_RATE));
  const b = Math.min(levels.length - 1, f + Math.round(after * FRAME_RATE));
  let best = f;
  let bv = Infinity;
  for (let i = a; i <= b; i++) {
    // small preference for staying close to the original position
    const v = levels[i] + 0.05 * Math.abs(i - f);
    if (v < bv) { bv = v; best = i; }
  }
  return best / FRAME_RATE;
}

// ---------------------------------------------------------------- candidates

/**
 * The stretch of speech frames (gaps up to 0.1 s bridged) that best matches [c.start, c.end].
 * Whisper's times are often 0.1-0.2 s late and run on into silences, so the search starts a
 * little earlier and the stretch overlapping the candidate most is kept.
 */
function trimToSpeech(c, core, { bridge = 10, maxSec = 2.5, early = 0.25, late = 0.1 } = {}) {
  const fr = FRAME_RATE;
  const a = Math.max(0, Math.floor((c.start - early) * fr));
  const b = Math.min(core.length, Math.ceil((c.end + late) * fr));
  const ca = c.start * fr - 0.15 * fr;
  const cb = c.end * fr;
  let best = null;
  let bestScore = -1;
  let f = a;
  while (f < b) {
    if (!core[f]) { f++; continue; }
    const s = f;
    let last = f;
    while (f < b && (core[f] || f - last <= bridge)) {
      if (core[f]) last = f;
      f++;
    }
    const e = last + 1;
    const score = Math.max(0, Math.min(e, cb) - Math.max(s, ca)) + 0.01 * (e - s);
    if (score > bestScore) { bestScore = score; best = [s, e]; }
    f = e;
  }
  if (!best || bestScore < 3) return null;
  let [s, e] = best;
  // do not swallow neighbouring words: stay within a little of the candidate
  s = Math.max(s, Math.floor(ca - 0.1 * fr));
  e = Math.min(e, Math.ceil(cb + late * fr));
  if (e - s > maxSec * fr) e = s + Math.round(maxSec * fr);
  if (e - s < 0.08 * fr) return null;
  return { ...c, start: s / fr, end: e / fr };
}

function mergeTextSpan(a, b) {
  if (b.textStart == null) return;
  a.textStart = a.textStart == null ? b.textStart : Math.min(a.textStart, b.textStart);
  a.textEnd = a.textEnd == null ? b.textEnd : Math.max(a.textEnd, b.textEnd);
}

const SOUND_TEXT = '（伸ばす音）';
const GAP_TEXT = '（文字にならない声）';

/**
 * @param {object} o
 *  units:  transcript units for this track (track time)
 *  core:   Uint8Array speech frames (track-local, from detectSpeech)
 *  levels: Float32Array frame levels (track-local)
 *  feat:   acousticFeatures() result or null
 *  foreign: frames where another person's voice is leaking in (from foreignFrames) or null
 * @returns [{ start, end, text, cls: 'auto'|'review', sources: [...], score }]
 */
export function findFillerCandidates({ units, core: core0, levels, feat = null, foreign = null }, opts = {}) {
  // speech that is really someone else's voice leaking in is not this person's filler
  let core = core0;
  if (foreign) {
    core = Uint8Array.from(core0);
    for (let f = 0; f < core.length; f++) if (foreign[f]) core[f] = 0;
  }
  const { gapMin = 0.2, gapMax = 1.6, margin = 0.06 } = opts;
  const cands = [];
  const nF = core.length;

  // 1. text
  for (const t of findTextFillers(units)) {
    // textStart/textEnd: where the words are in the transcript (kept when the sound boundaries move)
    cands.push({ start: t.start, end: t.end, textStart: t.start, textEnd: t.end, text: t.text, cls: t.cls, sources: ['text'], score: t.cls === 'auto' ? 0.9 : 0.5 });
  }

  // frames explained by recognised text
  const covered = new Uint8Array(nF);
  for (const u of units) {
    if (isPunct(u.text)) continue;
    const a = Math.max(0, Math.floor((u.start - margin) * FRAME_RATE));
    const b = Math.min(nF, Math.ceil((u.end + margin) * FRAME_RATE));
    covered.fill(1, a, b);
  }

  // 2. speech without text
  const gaps = [];
  let f = 0;
  while (f < nF) {
    if (!core[f] || covered[f]) { f++; continue; }
    const s = f;
    while (f < nF && core[f] && !covered[f]) f++;
    const len = (f - s) / FRAME_RATE;
    if (len >= gapMin && len <= gapMax) gaps.push({ start: s / FRAME_RATE, end: f / FRAME_RATE });
  }

  // 3. steady voiced sounds
  const runs = feat ? steadyVoicedRuns(feat, core) : [];

  const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const usedGap = new Set();
  for (const r of runs) {
    const textHit = cands.find((c) => c.sources.includes('text') && overlap(c, r) > 0);
    if (textHit) {
      textHit.sources.push('sound');
      textHit.start = Math.min(textHit.start, r.start);
      textHit.end = Math.max(textHit.end, r.end);
      textHit.score = Math.min(1, textHit.score + 0.1);
      continue;
    }
    const gi = gaps.findIndex((g) => overlap(g, r) > 0.5 * (r.end - r.start));
    if (gi >= 0) {
      usedGap.add(gi);
      const g = gaps[gi];
      cands.push({ start: Math.min(g.start, r.start), end: Math.max(g.end, r.end), text: SOUND_TEXT, cls: 'auto', sources: ['gap', 'sound'], score: Math.min(1, 0.6 + 0.4 * r.score) });
      continue;
    }
    // inside recognised words: a drawn-out sound at the end of a phrase ("そうですねー")
    // is normal speech; elsewhere it may be a filler that was swallowed into a word.
    const inside = units.filter((u) => !isPunct(u.text) && overlap(u, r) > 0);
    if (!inside.length) {
      // no text here, but not a short isolated sound either (e.g. before the first word)
      cands.push({ start: r.start, end: r.end, text: SOUND_TEXT, cls: 'review', sources: ['sound'], score: 0.3 + 0.3 * r.score });
      continue;
    }
    const lastIdx = units.indexOf(inside[inside.length - 1]);
    const next = units[lastIdx + 1];
    const phraseEnd = !next || isPunct(next.text) || next.start - units[lastIdx].end > 0.3 || r.end >= units[lastIdx].end - 0.05;
    if (phraseEnd) continue;
    cands.push({ start: r.start, end: r.end, text: inside.map((u) => u.text).join('') + SOUND_TEXT, cls: 'review', sources: ['sound'], score: 0.3 * r.score + 0.2 });
  }
  gaps.forEach((g, i) => {
    if (usedGap.has(i)) return;
    if (cands.some((c) => overlap(c, g) > 0.5 * (g.end - g.start))) return;
    cands.push({ start: g.start, end: g.end, text: GAP_TEXT, cls: 'review', sources: ['gap'], score: 0.3 });
  });

  // merge overlaps, snap to quiet points
  cands.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of cands) {
    const last = merged[merged.length - 1];
    if (last && c.start < last.end - 0.02) {
      last.end = Math.max(last.end, c.end);
      mergeTextSpan(last, c);
      last.sources = [...new Set([...last.sources, ...c.sources])];
      if (last.sources.includes('text') === false && c.sources.includes('text')) last.text = c.text;
      if (c.cls === 'auto' && c.score >= last.score) last.cls = 'auto';
      last.score = Math.max(last.score, c.score);
      continue;
    }
    merged.push({ ...c, sources: [...c.sources] });
  }
  const out = [];
  for (const c0 of merged) {
    // Whisper's token times run on through silences, so keep only the part where the person
    // actually makes a sound (the longest stretch of detected speech inside the candidate).
    const c = trimToSpeech(c0, core);
    if (!c) continue;
    const s = snapToValley(levels, c.start, 0.08, Math.min(0.05, (c.end - c.start) / 3));
    const e = snapToValley(levels, c.end, Math.min(0.05, (c.end - c.start) / 3), 0.08);
    if (e - s < 0.1) continue;
    out.push({ ...c, start: +s.toFixed(2), end: +e.toFixed(2) });
  }
  // trimming can make neighbours overlap ("まあ" + "なんか"): join them into one candidate
  out.sort((a, b) => a.start - b.start);
  const joined = [];
  for (const c of out) {
    const last = joined[joined.length - 1];
    if (last && c.start < last.end + 0.03) {
      last.end = Math.max(last.end, c.end);
      mergeTextSpan(last, c);
      last.text = last.text === c.text ? last.text : last.text + c.text;
      last.sources = [...new Set([...last.sources, ...c.sources])];
      last.cls = last.cls === 'auto' && c.cls === 'auto' ? 'auto' : 'review';
      last.score = Math.max(last.score, c.score);
      continue;
    }
    joined.push(c);
  }
  return joined;
}

/**
 * A filler added by hand while listening: the user pressed a key at time t (track time),
 * usually a little after the sound. The stretch of speech that ends closest before t (or
 * contains it) is taken, limited to the last 1.2 s, and snapped to quiet points.
 */
export function manualFillerAt(t, core, levels, { reaction = 0.35, maxSec = 1.2 } = {}) {
  const fr = FRAME_RATE;
  const target = Math.round((t - reaction) * fr);
  const a = Math.max(0, target - Math.round(1.5 * fr));
  const b = Math.min(core.length, target + Math.round(0.6 * fr));
  let best = null;
  let bestD = Infinity;
  let f = a;
  while (f < b) {
    if (!core[f]) { f++; continue; }
    const s = f;
    while (f < b && core[f]) f++;
    const d = target < s ? s - target : target >= f ? target - f + 1 : 0;
    if (d < bestD) { bestD = d; best = [s, f]; }
  }
  let s;
  let e;
  if (best && bestD < 0.5 * fr) {
    [s, e] = best;
    // a long stretch: keep the part around the key press
    if (e - s > maxSec * fr) {
      const c = Math.min(Math.max(target, s), e);
      s = Math.max(s, c - Math.round(0.7 * fr));
      e = Math.min(e, s + Math.round(maxSec * fr));
    }
  } else {
    s = target - Math.round(0.3 * fr);
    e = target + Math.round(0.1 * fr);
  }
  const start = snapToValley(levels, s / fr, 0.06, 0.04);
  const end = snapToValley(levels, e / fr, 0.04, 0.06);
  return { start: +start.toFixed(2), end: +Math.max(end, start + 0.12).toFixed(2), text: '（追加）', cls: 'auto', sources: ['manual'], score: 1 };
}
