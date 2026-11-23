// Glue between the processing steps (no browser APIs here, so it also runs in Node tests).

import { detectSpeech, FRAME_RATE } from './vad.js';
import { solveSync } from './sync.js';
import { timelineDuration, activityOnTimeline, buildPlan } from './plan.js';
import { gateEnvelope } from './gate.js';

/** tracks: [{ levels: Float32Array, sensitivity?: number }] */
export function runVad(tracks) {
  return tracks.map((t) => detectSpeech(t.levels, { sensitivity: t.sensitivity || 0 }));
}

export function runSync(vads) {
  return solveSync(vads.map((v) => v.core));
}

export function makeTimeline(tracks, vads, maps) {
  const durations = tracks.map((t) => t.levels.length / FRAME_RATE);
  const duration = timelineDuration(maps, durations);
  const nFrames = Math.ceil(duration * FRAME_RATE);
  const actsRef = vads.map((v, k) => activityOnTimeline(v.act, maps[k], nFrames));
  const coresRef = vads.map((v, k) => activityOnTimeline(v.core, maps[k], nFrames));
  return { nFrames, duration: nFrames / FRAME_RATE, actsRef, coresRef };
}

/** Longest segment that keeps drift error below ~4 ms. */
export function maxSegmentFor(maps) {
  const worst = Math.max(...maps.map((m) => Math.abs(1 - m.a)));
  return worst > 1e-7 ? Math.max(5, 0.004 / worst) : Infinity;
}

/**
 * fillers (optional): [{ id, track, start, end, enabled }] with start/end in seconds of the
 * track's own file; they are moved onto the common timeline here.
 */
export function makePlan(timeline, settings, maps, opts = {}) {
  const { fillers = [], manualCuts = [], manualMutes = [], disabledCuts = null, ...rest } = opts;
  const fr = FRAME_RATE;
  const toF = (x) => Math.round(x * fr);
  const onRef = fillers.map((f) => {
    const m = maps[f.track];
    return { id: f.id, track: f.track, enabled: f.enabled, start: Math.round(((f.start - m.b) / m.a) * fr), end: Math.round(((f.end - m.b) / m.a) * fr) };
  });
  return buildPlan(timeline.actsRef, timeline.nFrames, settings, {
    maxSegSec: maxSegmentFor(maps),
    fillers: onRef,
    coresRef: timeline.coresRef,
    // hand edits are kept in seconds on the common timeline
    manualCuts: manualCuts.map((c) => ({ id: c.id, start: toF(c.start), end: toF(c.end) })),
    manualMutes: manualMutes.map((m) => ({ id: m.id, track: m.track, start: toF(m.start), end: toF(m.end) })),
    disabledCuts: disabledCuts ? new Set(disabledCuts) : null,
    ...rest,
  });
}

export function makeGates(timeline, gateDb) {
  return timeline.actsRef.map((a) => gateEnvelope(a, gateDb));
}
