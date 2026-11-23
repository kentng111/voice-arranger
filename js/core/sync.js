// Synchronising separately recorded tracks without a shared clock.
//
// Idea: in a conversation people take turns. When two activity sequences are lined up
// correctly, the two people rarely speak at the same time; at any other offset their
// speech overlaps about as often as chance would predict. For every possible offset we
// measure how far the simultaneous speech falls short of chance (a z-score, so longer
// overlaps count as stronger evidence), using FFT cross-correlation over the whole
// recording. The best offset is then refined so that hand-overs look alike in both
// directions (gap "A stops -> B starts" = gap "B stops -> A starts"), and the same
// refinement on consecutive windows reveals slow clock drift between devices.

import { crossCorrelate } from './fft.js';
import { FRAME_RATE } from './vad.js';

function prefixSum(arr) {
  const p = new Float64Array(arr.length + 1);
  for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i];
  return p;
}

/**
 * Find the peak of a score curve (higher = better).
 * score: Float64Array (NaN = invalid lag). Index idx corresponds to lag idx + minLag.
 * The lag returned is the weighted centre of the peak region, not just its maximum, because
 * with network latency the "no overlap" region is a plateau rather than a sharp point.
 */
function analyzeScore(score, minLag, { smoothHalf = 5, regionMax = 400, exclusion = 500 } = {}) {
  const L = score.length;
  const ps = new Float64Array(L + 1);
  const pc = new Float64Array(L + 1);
  for (let i = 0; i < L; i++) {
    const v = score[i];
    const ok = v === v;
    ps[i + 1] = ps[i] + (ok ? v : 0);
    pc[i + 1] = pc[i] + (ok ? 1 : 0);
  }
  const sm = new Float64Array(L).fill(NaN);
  let best = -Infinity;
  let bi = -1;
  let count = 0;
  for (let i = 0; i < L; i++) {
    if (score[i] !== score[i]) continue;
    const lo = Math.max(0, i - smoothHalf);
    const hi = Math.min(L, i + smoothHalf + 1);
    const v = (ps[hi] - ps[lo]) / (pc[hi] - pc[lo]);
    sm[i] = v;
    count++;
    if (v > best) { best = v; bi = i; }
  }
  if (bi < 0) return null;
  const vals = new Float64Array(count);
  for (let i = 0, k = 0; i < L; i++) if (sm[i] === sm[i]) vals[k++] = sm[i];
  vals.sort();
  const median = vals[Math.floor(count / 2)];
  for (let i = 0; i < count; i++) vals[i] = Math.abs(vals[i] - median);
  vals.sort();
  const sigma = Math.max(1e-9, 1.4826 * vals[Math.floor(count / 2)]);
  const depth = best - median;
  if (!(depth > 0)) {
    return { lag: bi + minLag, peak: best, median, sigma, prominence: 0, ambiguity: 1, confidence: 0, width: 1 };
  }
  const thr = best - 0.3 * depth;
  let lo = bi;
  let hi = bi;
  while (lo - 1 >= 0 && bi - (lo - 1) <= regionMax && sm[lo - 1] === sm[lo - 1] && sm[lo - 1] >= thr) lo--;
  while (hi + 1 < L && hi + 1 - bi <= regionMax && sm[hi + 1] === sm[hi + 1] && sm[hi + 1] >= thr) hi++;
  let wsum = 0;
  let lsum = 0;
  for (let i = lo; i <= hi; i++) {
    const w = sm[i] - thr;
    if (w > 0) { wsum += w; lsum += w * i; }
  }
  const center = wsum > 0 ? lsum / wsum : bi;
  let second = -Infinity;
  for (let i = 0; i < L; i++) {
    if (Math.abs(i - bi) <= exclusion) continue;
    const v = sm[i];
    if (v === v && v > second) second = v;
  }
  const ambiguity = second === -Infinity ? 0 : Math.max(0, Math.min(1, (second - median) / depth));
  const prominence = depth / sigma;
  const confidence = Math.max(0, Math.min(1, (prominence - 3) / 12)) * (1 - ambiguity);
  return { lag: center + minLag, peak: best, median, sigma, prominence, ambiguity, confidence, width: hi - lo + 1 };
}

/** Evidence that two people take turns at this alignment: shortfall of simultaneous speech vs chance, in "sigmas". */
function turnTakingScore(O, n, SA, SB) {
  const E = (SA * SB) / n;
  return (E - O) / Math.sqrt(E);
}

/** Runs of 1s in an activity array as [start, end) frame pairs. */
export function segmentsOf(act) {
  const segs = [];
  let i = 0;
  const n = act.length;
  while (i < n) {
    if (!act[i]) { i++; continue; }
    const s = i;
    while (i < n && act[i]) i++;
    segs.push([s, i]);
  }
  return segs;
}

function median(arr) {
  const a = Float64Array.from(arr).sort();
  return a.length ? a[a.length >> 1] : NaN;
}

/**
 * Turn-taking gaps between two speakers at a given alignment (frames).
 * gapAB: B starts after A stopped (B answers A); gapBA: the other way round.
 * Only clean hand-overs count: the responder was silent for a while before, the first
 * speaker did not continue in between, and the response is not just a short "un".
 */
function turnGaps(segA, segB, lag, from = -Infinity, to = Infinity) {
  const MAX_GAP = 200; // 2.0 s
  const MAX_OVERLAP = 50; // 0.5 s
  const QUIET_BEFORE = 100; // responder silent for 1.0 s before the hand-over
  const MIN_RESPONSE = 50; // response lasts at least 0.5 s
  const shift = (segs, d) => segs.map(([s, e]) => [s + d, e + d]);
  const A = segA;
  const B = shift(segB, lag);
  const firstStartAtOrAfter = (segs, t) => {
    let lo = 0, hi = segs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m][0] < t) lo = m + 1; else hi = m; }
    return lo;
  };
  const activeIn = (segs, t0, t1) => {
    // any segment overlapping [t0, t1)
    let i = firstStartAtOrAfter(segs, t0);
    if (i > 0 && segs[i - 1][1] > t0) return true;
    return i < segs.length && segs[i][0] < t1;
  };
  const collect = (X, Y) => {
    const gaps = [];
    for (let k = 0; k < X.length; k++) {
      const e = X[k][1];
      if (e < from || e >= to) continue;
      const yi = firstStartAtOrAfter(Y, e - MAX_OVERLAP);
      if (yi >= Y.length) continue;
      const [ys, ye] = Y[yi];
      if (ys > e + MAX_GAP) continue;
      if (ye - ys < MIN_RESPONSE) continue;
      if (activeIn(Y, e - QUIET_BEFORE, ys)) continue;
      const nextX = k + 1 < X.length ? X[k + 1][0] : Infinity;
      if (nextX < ys) continue;
      gaps.push(ys - e);
    }
    return gaps;
  };
  return { gapAB: collect(A, B), gapBA: collect(B, A) };
}

/**
 * Refine an alignment so hand-overs look the same in both directions
 * (A->B gaps and B->A gaps have equal medians).
 */
function refineByTurns(segA, segB, lag, from, to, minEach = 6) {
  let cur = lag;
  let info = null;
  for (let it = 0; it < 3; it++) {
    const { gapAB, gapBA } = turnGaps(segA, segB, Math.round(cur), from, to);
    if (gapAB.length < minEach || gapBA.length < minEach) return info;
    const delta = (median(gapBA) - median(gapAB)) / 2;
    const next = Math.round(cur) + Math.max(-60, Math.min(60, delta));
    info = { lag: next, nAB: gapAB.length, nBA: gapBA.length, gapMedian: (median(gapAB) + median(gapBA)) / 2 };
    if (Math.abs(next - cur) < 1) break;
    cur = next;
  }
  return info;
}

/**
 * Offset of track B relative to track A, in frames: B's frame 0 lines up with A's frame `lag`.
 * A, B: Uint8Array speech activity at FRAME_RATE.
 */
export function estimatePairOffset(A, B) {
  const lenA = A.length;
  const lenB = B.length;
  const minN = Math.max(30 * FRAME_RATE, Math.floor(0.25 * Math.min(lenA, lenB)));
  const minAct = 3 * FRAME_RATE;
  const { values, minLag } = crossCorrelate(A, B);
  const PA = prefixSum(A);
  const PB = prefixSum(B);
  const L = values.length;
  const score = new Float64Array(L).fill(NaN);
  for (let idx = 0; idx < L; idx++) {
    const s = idx + minLag;
    const jLo = Math.max(0, -s);
    const jHi = Math.min(lenB, lenA - s);
    const n = jHi - jLo;
    if (n < minN) continue;
    const SB = PB[jHi] - PB[jLo];
    const SA = PA[jHi + s] - PA[jLo + s];
    if (SA < minAct || SB < minAct) continue;
    score[idx] = turnTakingScore(Math.max(0, values[idx]), n, SA, SB);
  }
  const coarse = analyzeScore(score, minLag, { smoothHalf: 5, regionMax: 400, exclusion: 500 });
  if (!coarse) return null;
  const fine = refineByTurns(segmentsOf(A), segmentsOf(B), coarse.lag);
  return {
    ...coarse,
    coarseLag: coarse.lag,
    lag: fine ? fine.lag : coarse.lag,
    turns: fine ? Math.min(fine.nAB, fine.nBA) : 0,
    gapMedian: fine ? fine.gapMedian / FRAME_RATE : null,
  };
}

function fitLine(points) {
  let sw = 0, st = 0, sy = 0;
  for (const p of points) { sw += p.w; st += p.w * p.t; sy += p.w * p.lag; }
  const tm = st / sw;
  const ym = sy / sw;
  let sxx = 0, sxy = 0;
  for (const p of points) {
    sxx += p.w * (p.t - tm) * (p.t - tm);
    sxy += p.w * (p.t - tm) * (p.lag - ym);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const intercept = ym - slope * tm;
  let ss = 0;
  for (const p of points) {
    const r = p.lag - (intercept + slope * p.t);
    ss += p.w * r * r;
  }
  const n = points.length;
  const sigma2 = Math.max((ss / sw) * (n / (n - 2)), 1e-8);
  const se = Math.sqrt(sigma2 / (sxx / sw) / n);
  return { slope, intercept, se, resid: Math.sqrt(ss / sw), tMid: tm, points };
}

/**
 * Re-estimate the offset on consecutive windows to see whether it changes over time
 * (clock drift). Returns a line fit lag(t) = intercept + slope * t (seconds), or null.
 */
export function estimatePairDrift(A, B, lag) {
  const lagI = Math.round(lag);
  const lenA = A.length;
  const lenB = B.length;
  const r0 = Math.max(0, lagI);
  const r1 = Math.min(lenA, lenB + lagI);
  const span = r1 - r0;
  const winLen = Math.max(4 * 60 * FRAME_RATE, Math.floor(span / 8));
  const nWin = Math.floor(span / winLen);
  if (nWin < 3) return null;
  const segA = segmentsOf(A);
  const segB = segmentsOf(B);
  const points = [];
  for (let w = 0; w < nWin; w++) {
    const w0 = r0 + w * winLen;
    const w1 = w0 + winLen;
    const res = refineByTurns(segA, segB, lag, w0, w1, 5);
    if (res) {
      points.push({ t: (w0 + w1) / 2 / FRAME_RATE, lag: res.lag / FRAME_RATE, w: Math.min(res.nAB, res.nBA) });
    }
  }
  if (points.length < 3) return null;
  return fitLine(points);
}

function invert(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-18) return null;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    for (let k = 0; k < 2 * n; k++) A[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f) for (let k = 0; k < 2 * n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row) => row.slice(n));
}

/** Weighted least squares for x_j - x_i = v with x_0 fixed at 0. */
function solveDifferences(K, meas) {
  const adj = Array.from({ length: K }, () => []);
  for (const m of meas) { adj[m.i].push(m.j); adj[m.j].push(m.i); }
  const known = new Array(K).fill(false);
  known[0] = true;
  const stack = [0];
  while (stack.length) {
    const u = stack.pop();
    for (const v of adj[u]) if (!known[v]) { known[v] = true; stack.push(v); }
  }
  const x = new Array(K).fill(0);
  const se = new Array(K).fill(Infinity);
  se[0] = 0;
  const idx = [];
  for (let k = 1; k < K; k++) if (known[k]) idx.push(k);
  if (!idx.length) return { x, se, known };
  const pos = new Map(idx.map((k, n) => [k, n]));
  const m = idx.length;
  const M = Array.from({ length: m }, () => new Array(m).fill(0));
  const rhs = new Array(m).fill(0);
  for (const e of meas) {
    if (!known[e.i] || !known[e.j]) continue;
    const a = e.i === 0 ? -1 : pos.get(e.i);
    const b = e.j === 0 ? -1 : pos.get(e.j);
    if (b >= 0) { M[b][b] += e.w; rhs[b] += e.w * e.v; }
    if (a >= 0) { M[a][a] += e.w; rhs[a] -= e.w * e.v; }
    if (a >= 0 && b >= 0) { M[a][b] -= e.w; M[b][a] -= e.w; }
  }
  const inv = invert(M);
  if (!inv) return { x, se, known: known.map((k, i) => i === 0) };
  for (let r = 0; r < m; r++) {
    let v = 0;
    for (let c = 0; c < m; c++) v += inv[r][c] * rhs[c];
    x[idx[r]] = v;
    se[idx[r]] = Math.sqrt(Math.max(inv[r][r], 0));
  }
  return { x, se, known };
}

/**
 * Synchronise K tracks.
 * cores: Uint8Array speech activity per track (FRAME_RATE).
 * Returns per-track linear maps from the common timeline T (seconds, 0 = earliest
 * recording start) to the track's own file time: fileTime = a * T + b.
 */
export function solveSync(cores, { union = true } = {}) {
  const K = cores.length;
  const durations = cores.map((c) => c.length / FRAME_RATE);
  const pairs = [];
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      const est = estimatePairOffset(cores[i], cores[j]);
      const drift = est && est.confidence > 0.05 ? estimatePairDrift(cores[i], cores[j], est.lag) : null;
      pairs.push({ i, j, est, drift });
    }
  }

  // Clock drift (seconds of offset change per second).
  const driftMeas = pairs
    .filter((p) => p.drift && isFinite(p.drift.se) && p.drift.se > 0)
    .map((p) => ({ i: p.i, j: p.j, v: p.drift.slope, w: 1 / (p.drift.se * p.drift.se) }));
  const c1Sol = solveDifferences(K, driftMeas);
  const c1 = new Array(K).fill(0);
  const driftCandidatePpm = new Array(K).fill(0);
  for (let k = 1; k < K; k++) {
    if (!c1Sol.known[k]) continue;
    const v = c1Sol.x[k];
    const se = c1Sol.se[k];
    driftCandidatePpm[k] = v * 1e6;
    if (Math.abs(v) < 500e-6 && Math.abs(v) / se > 4 && Math.abs(v) * durations[k] > 0.03) c1[k] = v;
  }

  // Offsets at T = 0 (track 0 time).
  let offMeas = pairs
    .filter((p) => p.est && p.est.confidence > 0)
    .map((p) => {
      const lenA = cores[p.i].length;
      const lenB = cores[p.j].length;
      const r0 = Math.max(0, p.est.lag);
      const r1 = Math.min(lenA, lenB + p.est.lag);
      const tMid = (r0 + r1) / 2 / FRAME_RATE;
      return {
        i: p.i,
        j: p.j,
        v: p.est.lag / FRAME_RATE - (c1[p.j] - c1[p.i]) * tMid,
        w: Math.max(0.02, p.est.confidence),
        conf: p.est.confidence,
      };
    });
  // With three or more tracks the pairwise results must agree (A->B + B->C = A->C).
  // Drop the weakest pair that disagrees, then solve again.
  const rejected = [];
  let c0Sol = solveDifferences(K, offMeas);
  const rejectOutliers = () => {
    for (;;) {
      const bad = offMeas.filter((m) => Math.abs(c0Sol.x[m.j] - c0Sol.x[m.i] - m.v) > 0.3);
      if (!bad.length) break;
      const candidate = bad.reduce((a, b) => (b.conf < a.conf ? b : a));
      const rest = offMeas.filter((m) => m !== candidate);
      const trial = solveDifferences(K, rest);
      if (trial.known.filter(Boolean).length < c0Sol.known.filter(Boolean).length) break;
      rejected.push(candidate);
      offMeas = rest;
      c0Sol = trial;
    }
  };
  rejectOutliers();
  const isRejected = (p) => rejected.some((r) => r.i === p.i && r.j === p.j && !r.union);

  // With three or more people, a track that pairs poorly with every single partner is
  // compared with everyone else at once: "is this person silent whenever anyone else
  // talks?" uses all the other speech as evidence, which is much stronger.
  const unionRefs = [];
  if (union && K >= 3 && c1.every((v) => v === 0)) {
    const pairConf = new Array(K).fill(0);
    for (const p of pairs) {
      if (!p.est || isRejected(p)) continue;
      pairConf[p.i] = Math.max(pairConf[p.i], p.est.confidence);
      pairConf[p.j] = Math.max(pairConf[p.j], p.est.confidence);
    }
    for (let k = 0; k < K; k++) {
      if (pairConf[k] >= 0.35) continue;
      const others = [];
      for (let j = 0; j < K; j++) if (j !== k && c0Sol.known[j] && pairConf[j] >= 0.12) others.push(j);
      if (others.length < 2) continue;
      const pos = others.map((j) => Math.round(c0Sol.x[j] * FRAME_RATE));
      const minF = Math.min(...pos);
      const maxF = Math.max(...others.map((j, n) => pos[n] + cores[j].length));
      const U = new Uint8Array(maxF - minF);
      others.forEach((j, n) => {
        const c = cores[j];
        const o = pos[n] - minF;
        for (let f = 0; f < c.length; f++) if (c[f]) U[o + f] = 1;
      });
      const est = estimatePairOffset(U, cores[k]);
      if (!est || est.confidence <= pairConf[k]) continue;
      const startSec = (est.lag + minF) / FRAME_RATE; // position of track k in track-0 time
      const anchor = others.reduce((a, b) => (pairConf[b] > pairConf[a] ? b : a));
      unionRefs.push({ track: k, others, startSec, confidence: est.confidence, prominence: est.prominence, ambiguity: est.ambiguity, turns: est.turns });
      offMeas.push({ i: anchor, j: k, v: startSec - c0Sol.x[anchor], w: 2 * Math.max(0.02, est.confidence), conf: est.confidence, union: true });
    }
    if (unionRefs.length) {
      c0Sol = solveDifferences(K, offMeas);
      rejectOutliers();
    }
  }
  const c0 = c0Sol.x;

  const residuals = offMeas.map((m) => ({ i: m.i, j: m.j, resid: c0[m.j] - c0[m.i] - m.v }));
  const confidence = new Array(K).fill(0);
  for (const p of pairs) {
    if (!p.est || isRejected(p)) continue;
    confidence[p.i] = Math.max(confidence[p.i], p.est.confidence);
    confidence[p.j] = Math.max(confidence[p.j], p.est.confidence);
  }
  for (const u of unionRefs) {
    if (rejected.some((r) => r.union && r.j === u.track)) continue;
    confidence[u.track] = Math.max(confidence[u.track], u.confidence);
  }

  const T0 = c0.map((c, k) => c / (1 - c1[k]));
  const shift = Math.min(...T0);
  const maps = c0.map((c, k) => {
    const a = 1 - c1[k];
    return { a, b: a * shift - c };
  });
  return {
    maps,
    starts: T0.map((t) => t - shift),
    driftPpm: c1.map((v) => v * 1e6),
    driftCandidatePpm,
    confidence,
    unionRefs,
    known: c0Sol.known,
    residuals,
    pairs: pairs.map((p) => ({
      i: p.i,
      j: p.j,
      lagSec: p.est ? p.est.lag / FRAME_RATE : null,
      confidence: p.est ? p.est.confidence : 0,
      prominence: p.est ? p.est.prominence : 0,
      ambiguity: p.est ? p.est.ambiguity : 1,
      rejected: isRejected(p),
      driftPpm: p.drift ? p.drift.slope * 1e6 : null,
      driftSePpm: p.drift ? p.drift.se * 1e6 : null,
    })),
  };
}

/** Build a map from a start position (seconds on the common timeline) and a drift. */
export function mapFromStart(startSec, driftPpm = 0) {
  const a = 1 - driftPpm * 1e-6;
  return { a, b: -a * startSec };
}

/** Start position (seconds on the common timeline) of a track's first sample. */
export function startOfMap(map) {
  return -map.b / map.a;
}
