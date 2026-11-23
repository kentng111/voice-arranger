// Edit plan: which parts of the common timeline are kept.
// Cuts are applied to every track at the same place, so the tracks stay in sync.

import { FRAME_RATE, padActivity } from './vad.js';

/** Total length of the common timeline (seconds). */
export function timelineDuration(maps, durations) {
  let end = 0;
  maps.forEach((m, k) => {
    end = Math.max(end, (durations[k] - m.b) / m.a);
  });
  return end;
}

/** Re-sample a per-frame activity array of one track onto the common timeline. */
export function activityOnTimeline(act, map, nFrames) {
  const out = new Uint8Array(nFrames);
  const bf = map.b * FRAME_RATE;
  for (let f = 0; f < nFrames; f++) {
    const src = Math.round(map.a * f + bf);
    if (src >= 0 && src < act.length) out[f] = act[src];
  }
  return out;
}

/** Same for per-frame levels (dB); frames outside the recording get -120 dB. */
export function levelsOnTimeline(levels, map, nFrames) {
  const out = new Float32Array(nFrames).fill(-120);
  const bf = map.b * FRAME_RATE;
  for (let f = 0; f < nFrames; f++) {
    const src = Math.round(map.a * f + bf);
    if (src >= 0 && src < levels.length) out[f] = levels[src];
  }
  return out;
}

export const DEFAULT_SETTINGS = {
  maxPause: 0.8, // pauses longer than this (s) are shortened
  targetPause: 0.5, // ...to this length (s)
  lead: 0.3, // silence kept before the first word (s)
  tail: 0.6, // silence kept after the last word (s)
  fillerGap: 0.2, // shortest silence left where a filler was cut out (s)
};

/**
 * Decide how each adopted filler is removed and what the activity looks like without it.
 * fillers: [{ id, track, start, end, enabled }] with start/end in frames on the common timeline.
 * - nobody else speaks during the filler -> 'cut' (removed from the timeline of every track)
 * - someone else speaks -> 'mute' (only that track is silenced, so the other voice stays)
 * Every adopted filler is also muted on its own track, so nothing of it is left in a kept pause.
 */
export function resolveFillers(actsRef, coresRef, fillers, nFrames) {
  const K = actsRef.length;
  const adopted = fillers.filter((f) => f.enabled && f.end > f.start);
  if (!adopted.length) return { acts: actsRef, resolved: [] };
  const cores = coresRef.map((c) => c);
  const touched = new Set();
  for (const f of adopted) {
    if (!touched.has(f.track)) {
      cores[f.track] = Uint8Array.from(coresRef[f.track]);
      touched.add(f.track);
    }
    cores[f.track].fill(0, Math.max(0, f.start), Math.min(nFrames, f.end));
  }
  const acts = actsRef.map((a, k) => (touched.has(k) ? padActivity(cores[k]) : a));
  const resolved = adopted.map((f) => {
    let busy = 0;
    for (let j = 0; j < K; j++) {
      if (j === f.track) continue;
      for (let t = Math.max(0, f.start); t < Math.min(nFrames, f.end); t++) if (coresRef[j][t]) busy++;
    }
    return { ...f, mode: busy > 3 ? 'mute' : 'cut' };
  });
  // a 'mute' filler stays in the timeline, so it keeps the place busy (no pause is cut there)
  for (const f of resolved) {
    if (f.mode !== 'mute') continue;
    if (acts[f.track] === actsRef[f.track]) acts[f.track] = Uint8Array.from(actsRef[f.track]);
    acts[f.track].fill(1, Math.max(0, f.start), Math.min(nFrames, f.end));
  }
  return { acts, resolved };
}

/**
 * actsRef: per-track activity on the common timeline (Uint8Array, FRAME_RATE).
 * maxSegSec: longest stretch rendered without re-reading the clock map
 *            (only matters when drift correction is active).
 */
/**
 * Hand edits (from the track editor), all in frames on the common timeline:
 *   manualCuts:  [{ id, start, end }]          removed from every track (time is closed up)
 *   manualMutes: [{ id, track, start, end }]   one track silenced, time unchanged
 *   disabledCuts: Set of automatic cut keys ("pause:1234") the user put back
 */
export function buildPlan(actsRef, nFrames, settings = DEFAULT_SETTINGS, { maxSegSec = Infinity, noCuts = false, fillers = [], coresRef = null, manualCuts = [], manualMutes = [], disabledCuts = null } = {}) {
  const fr = FRAME_RATE;
  const { acts, resolved } = !noCuts && coresRef ? resolveFillers(actsRef, coresRef, fillers, nFrames) : { acts: actsRef, resolved: [] };
  const U = new Uint8Array(nFrames);
  for (const a of acts) for (let f = 0; f < nFrames; f++) if (a[f]) U[f] = 1;
  // a filler that is cut counts as silence, even where the padding around neighbouring words covers it
  for (const fl of resolved) if (fl.mode === 'cut') U.fill(0, Math.max(0, fl.start), Math.min(nFrames, fl.end));

  const cuts = [];
  if (!noCuts) {
    const first = U.indexOf(1);
    const last = U.lastIndexOf(1);
    if (first >= 0) {
      const lead = Math.round(settings.lead * fr);
      const tail = Math.round(settings.tail * fr);
      if (first - lead > 0) cuts.push({ type: 'head', start: 0, end: first - lead });
      const maxP = Math.round(settings.maxPause * fr);
      const tgt = Math.round(Math.min(settings.targetPause, settings.maxPause) * fr);
      const keepHead = Math.floor(tgt / 2);
      const keepTail = tgt - keepHead;
      let f = first;
      while (f <= last) {
        if (U[f]) { f++; continue; }
        const r0 = f;
        while (f <= last && !U[f]) f++;
        const r1 = f;
        const len = r1 - r0;
        if (len > maxP && len > tgt) {
          cuts.push({ type: 'pause', start: r0 + keepHead, end: r1 - keepTail, pauseSec: len / fr });
        }
      }
      if (last + 1 + tail < nFrames) cuts.push({ type: 'tail', start: last + 1 + tail, end: nFrames });

      // Fillers removed from a short silence: cut them out, but leave at least fillerGap.
      const gapF = Math.round((settings.fillerGap ?? DEFAULT_SETTINGS.fillerGap) * fr);
      const byRun = new Map();
      for (const fl of resolved) {
        if (fl.mode !== 'cut') continue;
        const s0 = Math.max(first, fl.start);
        const e0 = Math.min(last + 1, fl.end);
        if (e0 <= s0) continue;
        let r0 = s0;
        while (r0 > 0 && !U[r0 - 1]) r0--;
        let r1 = e0;
        while (r1 < nFrames && !U[r1]) r1++;
        if (r1 - r0 > maxP && r1 - r0 > tgt) continue; // already shortened as a pause
        const key = r0;
        if (!byRun.has(key)) byRun.set(key, { r0, r1, items: [] });
        byRun.get(key).items.push({ s: s0, e: e0, id: fl.id });
      }
      for (const { r0, r1, items } of byRun.values()) {
        const L = r1 - r0;
        const F = items.reduce((a, it) => a + (it.e - it.s), 0);
        const keep = Math.min(L, Math.max(L - F, gapF));
        let toCut = L - keep;
        if (toCut < 2) continue;
        const ratio = toCut / F;
        for (const it of items) {
          const len = Math.min(it.e - it.s, Math.round((it.e - it.s) * ratio));
          if (len < 2) continue;
          const c0 = it.s + Math.floor((it.e - it.s - len) / 2);
          cuts.push({ type: 'filler', start: c0, end: c0 + len, fillerId: it.id });
          toCut -= len;
        }
      }
    }
  }
  for (const c of cuts) c.key = `${c.type}:${c.start}`;
  if (!noCuts) {
    for (const m of manualCuts) {
      const a = Math.max(0, Math.round(m.start));
      const b = Math.min(nFrames, Math.round(m.end));
      if (b > a) cuts.push({ type: 'manual', start: a, end: b, manualId: m.id, key: `manual:${m.id}` });
    }
  }
  cuts.sort((a, b) => a.start - b.start);
  cuts.forEach((c, i) => {
    c.id = i;
    c.enabled = !(disabledCuts && c.type !== 'filler' && c.type !== 'manual' && disabledCuts.has(c.key));
  });
  const plan = finalizePlan({ cuts, nFrames, U, maxSegSec });
  plan.fillers = resolved;
  plan.mutes = resolved.map((f) => ({ track: f.track, start: f.start, end: f.end, fillerId: f.id, mode: f.mode }));
  if (!noCuts) {
    for (const m of manualMutes) {
      const a = Math.max(0, Math.round(m.start));
      const b = Math.min(nFrames, Math.round(m.end));
      if (b > a) plan.mutes.push({ track: m.track, start: a, end: b, manualId: m.id, mode: 'manual' });
    }
  }
  plan.counts.mute = resolved.filter((f) => f.mode === 'mute').length;
  plan.counts.manualMute = plan.mutes.filter((m) => m.mode === 'manual').length;
  return plan;
}

/** Turn cuts into kept segments (seconds) and output-time bookkeeping. */
export function finalizePlan({ cuts, nFrames, U, maxSegSec = Infinity }) {
  const fr = FRAME_RATE;
  const active = cuts.filter((c) => c.enabled).sort((a, b) => a.start - b.start);
  const keep = [];
  let pos = 0;
  for (const c of active) {
    if (c.start > pos) keep.push([pos, c.start]);
    pos = Math.max(pos, c.end);
  }
  if (pos < nFrames) keep.push([pos, nFrames]);

  // Split long kept stretches at short silences so clock drift can be re-applied.
  const maxSeg = Number.isFinite(maxSegSec) ? Math.max(5 * fr, Math.round(maxSegSec * fr)) : Infinity;
  const segFrames = [];
  for (const [s, e] of keep) {
    if (e - s <= maxSeg) { segFrames.push([s, e]); continue; }
    let segStart = s;
    let f = s;
    while (f < e) {
      if (U[f]) { f++; continue; }
      const r0 = f;
      while (f < e && !U[f]) f++;
      const mid = Math.floor((r0 + f) / 2);
      if (f - r0 >= 3 && mid - segStart >= maxSeg / 2 && e - mid >= 2 * fr) {
        segFrames.push([segStart, mid]);
        segStart = mid;
      }
    }
    segFrames.push([segStart, e]);
  }

  let out = 0;
  const segments = segFrames.map(([s, e]) => {
    const seg = { start: s / fr, end: e / fr, outStart: out };
    out += seg.end - seg.start;
    return seg;
  });
  const removed = { pause: 0, head: 0, tail: 0, filler: 0, manual: 0, other: 0 };
  const counts = { pause: 0, head: 0, tail: 0, filler: 0, manual: 0, other: 0 };
  for (const c of active) {
    const k = c.type in removed ? c.type : 'other';
    removed[k] += (c.end - c.start) / fr;
    counts[k] += 1;
  }
  return {
    cuts: cuts.map((c) => ({ ...c, startSec: c.start / fr, endSec: c.end / fr })),
    segments,
    inputDuration: nFrames / fr,
    outputDuration: out,
    removed,
    counts,
    U,
    nFrames,
    maxSegSec,
  };
}

/** Kept segments expressed in samples at a given rate (identical for every track). */
export function segmentsInSamples(plan, rate) {
  let cum = 0;
  const segs = plan.segments.map((s) => {
    const outStart = Math.round(s.outStart * rate);
    const outEnd = Math.round((s.outStart + (s.end - s.start)) * rate);
    cum = outEnd;
    return { start: s.start, end: s.end, outStart, len: outEnd - outStart };
  });
  return { segs, totalLen: cum, rate };
}

/** Common-timeline time -> edited (output) time. Times inside a cut map to the cut point. */
export function refToOut(plan, T) {
  const segs = plan.segments;
  if (!segs.length) return 0;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].start <= T) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo];
  if (T < s.start) return s.outStart;
  return s.outStart + Math.min(T - s.start, s.end - s.start);
}

/** Edited (output) time -> common-timeline time. */
export function outToRef(plan, t) {
  const segs = plan.segments;
  if (!segs.length) return 0;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].outStart <= t) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo];
  return s.start + Math.max(0, Math.min(t - s.outStart, s.end - s.start));
}

/** Common-timeline time -> edited time, or null when T falls inside a cut. */
export function refToOutOrNull(plan, T) {
  const segs = plan.segments;
  let lo = 0;
  let hi = segs.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].start <= T) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo];
  if (T < s.start - 1e-6 || T > s.end + 1e-6) return null;
  return s.outStart + Math.min(Math.max(0, T - s.start), s.end - s.start);
}
