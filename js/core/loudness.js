// Integrated loudness (ITU-R BS.1770-4 / EBU R128), streaming, mono.
// K-weighting coefficients are derived for any sample rate (same method as libebur128).

export class LoudnessMeter {
  constructor(sampleRate) {
    this.sr = sampleRate;
    let f0 = 1681.974450955533;
    let G = 3.999843853973347;
    let Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / sampleRate);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    this.s1 = {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / sampleRate);
    a0 = 1 + K / Q + K * K;
    this.s2 = { a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
    this.z = new Float64Array(8); // filter states
    this.subLen = Math.round(sampleRate * 0.1);
    this.acc = 0;
    this.cnt = 0;
    this.subs = [];
  }

  push(x) {
    const p = this.s1;
    const r = this.s2;
    let [x1, x2, y1, y2, u1, u2, v1, v2] = this.z;
    let acc = this.acc;
    let cnt = this.cnt;
    const subLen = this.subLen;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const y = p.b0 * xi + p.b1 * x1 + p.b2 * x2 - p.a1 * y1 - p.a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = y;
      const v = y - 2 * u1 + u2 - r.a1 * v1 - r.a2 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      acc += v * v;
      if (++cnt === subLen) {
        this.subs.push(acc / subLen);
        acc = 0;
        cnt = 0;
      }
    }
    this.z.set([x1, x2, y1, y2, u1, u2, v1, v2]);
    this.acc = acc;
    this.cnt = cnt;
  }

  /** Gated integrated loudness in LUFS (mono). */
  integrated() {
    const subs = this.subs;
    const nb = subs.length - 3;
    if (nb <= 0) return -Infinity;
    const absThr = Math.pow(10, (-70 + 0.691) / 10);
    let sum = 0;
    let c = 0;
    const z = new Float64Array(nb);
    for (let j = 0; j < nb; j++) {
      z[j] = (subs[j] + subs[j + 1] + subs[j + 2] + subs[j + 3]) / 4;
      if (z[j] > absThr) { sum += z[j]; c++; }
    }
    if (!c) return -Infinity;
    const relThr = (sum / c) * 0.1;
    let sum2 = 0;
    let c2 = 0;
    for (let j = 0; j < nb; j++) {
      if (z[j] > absThr && z[j] > relThr) { sum2 += z[j]; c2++; }
    }
    return c2 ? -0.691 + 10 * Math.log10(sum2 / c2) : -Infinity;
  }
}
