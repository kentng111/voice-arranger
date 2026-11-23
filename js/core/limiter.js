// Look-ahead peak limiter (streaming). Guarantees |output| <= ceiling for every sample.
// Gain = moving average (length L) of a release-smoothed sliding minimum (window L + 1)
// of the required per-sample gain, so the gain reaches its target before each peak.

export class Limiter {
  constructor(sampleRate, { ceilingDb = -1.0, lookaheadMs = 5, releaseMs = 80 } = {}) {
    this.c = Math.pow(10, ceilingDb / 20);
    this.L = Math.max(1, Math.round((lookaheadMs * sampleRate) / 1000));
    this.rel = Math.exp(-1 / ((releaseMs * sampleRate) / 1000));
    this.delay = new Float32Array(this.L);
    this.dPos = 0;
    const cap = this.L + 2;
    this.cap = cap;
    this.dqIdx = new Float64Array(cap);
    this.dqVal = new Float64Array(cap);
    this.dqHead = 0;
    this.dqTail = 0;
    this.hBuf = new Float64Array(this.L).fill(1);
    this.hPos = 0;
    this.hSum = this.L;
    this.h = 1;
    this.n = 0;
    this.minGain = 1;
  }

  _run(input, out) {
    const L = this.L;
    const cap = this.cap;
    const c = this.c;
    const rel = this.rel;
    const dqIdx = this.dqIdx;
    const dqVal = this.dqVal;
    const hBuf = this.hBuf;
    const delay = this.delay;
    let { dqHead, dqTail, hPos, hSum, h, n, dPos, minGain } = this;
    for (let i = 0; i < input.length; i++) {
      const x = input ? input[i] : 0;
      const ax = x < 0 ? -x : x;
      const r = ax > c ? c / ax : 1;
      while (dqTail !== dqHead) {
        const lastI = dqTail === 0 ? cap - 1 : dqTail - 1;
        if (dqVal[lastI] >= r) dqTail = lastI;
        else break;
      }
      dqIdx[dqTail] = n;
      dqVal[dqTail] = r;
      dqTail = dqTail + 1 === cap ? 0 : dqTail + 1;
      while (dqIdx[dqHead] < n - L) dqHead = dqHead + 1 === cap ? 0 : dqHead + 1;
      const m = dqVal[dqHead];
      const hr = rel * h + (1 - rel);
      h = m < hr ? m : hr;
      hSum += h - hBuf[hPos];
      hBuf[hPos] = h;
      hPos = hPos + 1 === L ? 0 : hPos + 1;
      if ((n & 0xffff) === 0) {
        hSum = 0;
        for (let k = 0; k < L; k++) hSum += hBuf[k];
      }
      const g = hSum / L;
      if (g < minGain) minGain = g;
      out[i] = delay[dPos] * g;
      delay[dPos] = x;
      dPos = dPos + 1 === L ? 0 : dPos + 1;
      n++;
    }
    Object.assign(this, { dqHead, dqTail, hPos, hSum, h, n, dPos, minGain });
  }
}

/**
 * Wraps the limiter so the output has exactly the same length and timing as the input:
 * push() returns processed samples (the first call returns L fewer), end() returns the rest.
 */
export function createLimiterStream(sampleRate, opts) {
  const lim = new Limiter(sampleRate, opts);
  let toDrop = lim.L;
  const take = (out) => {
    if (toDrop > 0) {
      const d = Math.min(toDrop, out.length);
      toDrop -= d;
      return out.subarray(d);
    }
    return out;
  };
  return {
    limiter: lim,
    push(chunk) {
      const out = new Float32Array(chunk.length);
      lim._run(chunk, out);
      return take(out);
    },
    end() {
      const zeros = new Float32Array(lim.L);
      const out = new Float32Array(lim.L);
      lim._run(zeros, out);
      return take(out);
    },
    get reductionDb() {
      return 20 * Math.log10(lim.minGain);
    },
  };
}
