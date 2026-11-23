// Radix-2 complex FFT and FFT-based cross-correlation.
// Used by the sync step to compare speech-activity sequences of two tracks.

const twiddleCache = new Map();

function getTwiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) {
    const half = n >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / n;
      cos[i] = Math.cos(a);
      sin[i] = Math.sin(a);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place complex FFT. re/im are Float64Array of power-of-two length. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n & (n - 1)) throw new Error('FFT size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const { cos, sin } = getTwiddles(n);
  const sign = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t];
        const wi = sign * sin[t];
        const i = start + k;
        const j = i + half;
        const xr = re[j] * wr - im[j] * wi;
        const xi = re[j] * wi + im[j] * wr;
        re[j] = re[i] - xr;
        im[j] = im[i] - xi;
        re[i] += xr;
        im[i] += xi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Linear cross-correlation r[s] = sum_j a[j + s] * b[j]
 * for s in [-(b.length - 1), a.length - 1].
 * Returns { values, minLag } where values[idx] corresponds to lag idx + minLag.
 */
export function crossCorrelate(a, b) {
  const n = nextPow2(a.length + b.length);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let i = 0; i < a.length; i++) ar[i] = a[i];
  for (let i = 0; i < b.length; i++) br[i] = b[i];
  fft(ar, ai);
  fft(br, bi);
  for (let k = 0; k < n; k++) {
    const r = ar[k] * br[k] + ai[k] * bi[k];
    const i = ai[k] * br[k] - ar[k] * bi[k];
    ar[k] = r;
    ai[k] = i;
  }
  fft(ar, ai, true);
  const len = a.length + b.length - 1;
  const values = new Float64Array(len);
  const minLag = -(b.length - 1);
  for (let idx = 0; idx < len; idx++) {
    const s = idx + minLag;
    values[idx] = s >= 0 ? ar[s] : ar[n + s];
  }
  return { values, minLag };
}
