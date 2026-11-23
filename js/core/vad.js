// Voice activity detection on 10 ms frames.
// Thresholds are relative to each track's own noise floor and speech level, so the
// quieter voices of the other people leaking into a phone ("bleed") are mostly ignored.

export const FRAME_RATE = 100; // frames per second (10 ms)
export const PAD_PRE = 5; // padding before speech (50 ms)
export const PAD_POST = 15; // padding after speech (150 ms)

/** core activity -> activity with padding (same rule as detectSpeech). */
export function padActivity(core, pre = PAD_PRE, post = PAD_POST) {
  const n = core.length;
  const act = new Uint8Array(n);
  let f = 0;
  while (f < n) {
    if (!core[f]) { f++; continue; }
    const s = f;
    while (f < n && core[f]) f++;
    act.fill(1, Math.max(0, s - pre), Math.min(n, f + post));
  }
  return act;
}

function highPass(fc, fs, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: -(1 + cosw) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Level of each 10 ms frame in dBFS (after an 80 Hz high-pass to ignore rumble and hum). */
export function frameLevels(pcm, sampleRate) {
  const hop = Math.round(sampleRate / FRAME_RATE);
  const nFrames = Math.floor(pcm.length / hop);
  const out = new Float32Array(nFrames);
  const c = highPass(80, sampleRate);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let idx = 0;
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    for (let i = 0; i < hop; i++, idx++) {
      const x = pcm[idx];
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      sum += y * y;
    }
    out[f] = 10 * Math.log10(sum / hop + 1e-12);
  }
  return out;
}

function percentile(sorted, q) {
  const n = sorted.length;
  if (!n) return -120;
  const i = Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))));
  return sorted[i];
}

/**
 * Detect speech frames.
 * sensitivity: dB, positive = more sensitive (picks up softer speech).
 * Returns:
 *   core: Uint8Array, 1 while the person is actually speaking (used for sync)
 *   act:  Uint8Array, core plus a little padding before/after (used for editing and gating)
 */
export function detectSpeech(levels, { sensitivity = 0 } = {}) {
  const n = levels.length;
  const power = new Float64Array(n);
  for (let i = 0; i < n; i++) power[i] = Math.pow(10, levels[i] / 10);
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = power[i];
    let c = 1;
    if (i > 0) { p += power[i - 1]; c++; }
    if (i + 1 < n) { p += power[i + 1]; c++; }
    sm[i] = 10 * Math.log10(p / c + 1e-12);
  }

  const sorted = Float32Array.from(sm).sort();
  const noise = percentile(sorted, 0.1);
  const peak = percentile(sorted, 0.99);
  const startThr = Math.max(noise + 10, peak - 24) - sensitivity;
  let contThr = Math.max(noise + 5, peak - 34) - sensitivity;
  if (contThr > startThr - 3) contThr = startThr - 3;

  const HANG = 25; // a dip shorter than 250 ms does not end a phrase
  const MAX_BACK = 20; // soft onsets: look back up to 200 ms
  const MIN_LEN = 6; // drop clicks shorter than 60 ms
  const PRE = PAD_PRE;
  const POST = PAD_POST;

  const segments = [];
  let i = 0;
  while (i < n - 1) {
    if (sm[i] >= startThr && sm[i + 1] >= startThr) {
      let s = i;
      let back = 0;
      while (s > 0 && back < MAX_BACK && sm[s - 1] >= contThr) { s--; back++; }
      if (segments.length && s < segments[segments.length - 1][1]) s = segments[segments.length - 1][1];
      let last = i;
      let j = i;
      while (j < n) {
        if (sm[j] >= contThr) { last = j; j++; }
        else if (j - last <= HANG) j++;
        else break;
      }
      if (last + 1 - s >= MIN_LEN) segments.push([s, last + 1]);
      i = last + 1;
    } else {
      i++;
    }
  }

  const core = new Uint8Array(n);
  const act = new Uint8Array(n);
  let activeFrames = 0;
  for (const [s, e] of segments) {
    core.fill(1, s, e);
    activeFrames += e - s;
    act.fill(1, Math.max(0, s - PRE), Math.min(n, e + POST));
  }
  return {
    core,
    act,
    segments,
    noiseDb: noise,
    speechDb: peak,
    startThr,
    contThr,
    activeRatio: n ? activeFrames / n : 0,
  };
}
