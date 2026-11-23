// Node tests for the processing core.
//   node tests/core.test.mjs                 unit tests only
//   node tests/core.test.mjs DATA_DIR        + full pipeline on make_test_audio.py output (uses *_16k.wav)

import fs from 'node:fs';
import path from 'node:path';
import { crossCorrelate } from '../js/core/fft.js';
import { LoudnessMeter } from '../js/core/loudness.js';
import { createLimiterStream } from '../js/core/limiter.js';
import { frameLevels, FRAME_RATE } from '../js/core/vad.js';
import { runVad, runSync, makeTimeline, makePlan, makeGates } from '../js/core/session.js';
import { segmentsInSamples, refToOut, outToRef } from '../js/core/plan.js';
import { renderTrack } from '../js/core/render.js';
import { parseWavHeader, decodePCM, encodePCM, wavHeader } from '../js/io/wav.js';
import { runFillerTests } from './filler.tests.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// ---------- unit tests ----------
{
  const a = Float64Array.from({ length: 37 }, () => Math.round(Math.random()));
  const b = Float64Array.from({ length: 23 }, () => Math.round(Math.random()));
  const { values, minLag } = crossCorrelate(a, b);
  let maxErr = 0;
  for (let s = -(b.length - 1); s <= a.length - 1; s++) {
    let r = 0;
    for (let j = 0; j < b.length; j++) if (j + s >= 0 && j + s < a.length) r += a[j + s] * b[j];
    maxErr = Math.max(maxErr, Math.abs(r - values[s - minLag]));
  }
  check('cross-correlation matches direct sum', maxErr < 1e-9, `max error ${maxErr.toExponential(2)}`);
}
{
  const m = new LoudnessMeter(48000);
  const ref = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
  const got = [m.s1.b0, m.s1.b1, m.s1.b2, m.s1.a1, m.s1.a2];
  const err = Math.max(...ref.map((v, i) => Math.abs(v - got[i])));
  check('K-weighting stage 1 matches BS.1770 at 48 kHz', err < 1e-9, `max error ${err.toExponential(2)}`);
  const ref2 = [-1.99004745483398, 0.99007225036621];
  const err2 = Math.max(Math.abs(ref2[0] - m.s2.a1), Math.abs(ref2[1] - m.s2.a2));
  check('K-weighting stage 2 matches BS.1770 at 48 kHz', err2 < 1e-9, `max error ${err2.toExponential(2)}`);
  for (const sr of [48000, 16000]) {
    const mm = new LoudnessMeter(sr);
    const x = new Float32Array(sr * 10);
    for (let i = 0; i < x.length; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 997 * i) / sr);
    mm.push(x);
    const L = mm.integrated();
    check(`997 Hz sine at -20 dBFS peak = -23.0 LUFS (${sr} Hz)`, Math.abs(L + 23.0) < 0.1, `${L.toFixed(2)} LUFS`);
  }
}
{
  const sr = 48000;
  const x = new Float32Array(sr * 3);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr) + (i % 9000 === 0 ? 1.8 : 0) + (Math.random() - 0.5) * 0.4;
  const ls = createLimiterStream(sr, { ceilingDb: -1 });
  const parts = [];
  for (let p = 0; p < x.length; p += 10007) parts.push(ls.push(x.subarray(p, Math.min(x.length, p + 10007))));
  parts.push(ls.end());
  const y = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { y.set(p, o); o += p.length; }
  const ceil = Math.pow(10, -1 / 20);
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  check('limiter keeps length', y.length === x.length, `${y.length} vs ${x.length}`);
  check('limiter keeps peaks under the ceiling', peak <= ceil + 1e-6, `peak ${peak.toFixed(4)} ceiling ${ceil.toFixed(4)}`);
  const q = new Float32Array(sr);
  for (let i = 0; i < q.length; i++) q[i] = 0.2 * Math.sin(i / 7);
  const l2 = createLimiterStream(sr);
  const a = l2.push(q);
  const b = l2.end();
  const z = new Float32Array(q.length);
  z.set(a); z.set(b, a.length);
  let maxd = 0;
  for (let i = 0; i < q.length; i++) maxd = Math.max(maxd, Math.abs(z[i] - q[i]));
  check('limiter is transparent and time-aligned below the ceiling', maxd < 1e-6, `max diff ${maxd.toExponential(2)}`);
}
{
  const f = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.7);
  for (const bitDepth of [16, 24]) {
    const bytes = encodePCM(f, { bitDepth });
    const back = decodePCM(bytes, { bitDepth });
    let e = 0;
    for (let i = 0; i < f.length; i++) e = Math.max(e, Math.abs(back[i] - f[i]));
    check(`PCM ${bitDepth}-bit round trip`, e < (bitDepth === 16 ? 1e-4 : 1e-6), `max error ${e.toExponential(2)}`);
  }
  const h = parseWavHeader(wavHeader({ numFrames: 10, sampleRate: 48000, channels: 2, bitDepth: 16 }));
  check('WAV header parses', h.channels === 2 && h.sampleRate === 48000 && h.dataBytes === 40 && h.dataOffset === 44);
}

runFillerTests(check);

// ---------- pipeline on synthetic recordings ----------
const dataDir = process.argv[2];
if (dataDir) {
  const truth = JSON.parse(fs.readFileSync(path.join(dataDir, 'truth.json'), 'utf8'));
  const t0 = Date.now();
  const tracks = truth.tracks.map((t) => {
    const file = t.files.wav16k;
    const buf = fs.readFileSync(file);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const h = parseWavHeader(bytes);
    const pcm = decodePCM(bytes.subarray(h.dataOffset, h.dataOffset + h.dataBytes), { bitDepth: h.bitDepth, channels: h.channels });
    return { name: t.name, pcm, sampleRate: h.sampleRate, levels: frameLevels(pcm, h.sampleRate) };
  });
  const tLoad = Date.now();
  const vads = runVad(tracks);
  const tVad = Date.now();
  const sync = runSync(vads);
  const tSync = Date.now();
  console.log(`timing: load+levels ${tLoad - t0} ms, vad ${tVad - tLoad} ms, sync ${tSync - tVad} ms`);

  // VAD quality against the true speech events (track-local time).
  truth.tracks.forEach((t, k) => {
    const v = vads[k];
    const n = v.core.length;
    const truthAct = new Uint8Array(n);
    const eps = t.drift_ppm * 1e-6;
    for (const ev of truth.events) {
      if (ev.spk !== k) continue;
      const s = Math.floor((1 + eps) * (ev.start - t.start_wall) * FRAME_RATE);
      const e = Math.ceil((1 + eps) * (ev.end - t.start_wall) * FRAME_RATE);
      truthAct.fill(1, Math.max(0, s), Math.min(n, e));
    }
    let tp = 0, fp = 0, fn = 0;
    for (let f = 0; f < n; f++) {
      if (v.core[f] && truthAct[f]) tp++;
      else if (v.core[f]) fp++;
      else if (truthAct[f]) fn++;
    }
    const prec = tp / (tp + fp);
    const rec = tp / (tp + fn);
    check(`VAD ${t.name}${t.bleed ? ' (with leaked voices)' : ''}: precision ${prec.toFixed(3)} recall ${rec.toFixed(3)}`, prec > 0.85 && rec > 0.85);
  });

  // Sync accuracy: compare where each true speech moment lands on the common timeline.
  const minStart = Math.min(...truth.tracks.map((t) => t.start_wall));
  const errAt = (k, w) => {
    const t = truth.tracks[k];
    const tau = (1 + t.drift_ppm * 1e-6) * (w - t.start_wall);
    const m = sync.maps[k];
    return (tau - m.b) / m.a - (w - minStart);
  };
  const total = truth.minutes * 60;
  const probe = [10, total / 2, total - 10];
  const rows = truth.tracks.map((t, k) => probe.map((w) => errAt(k, w) - errAt(0, w)));
  console.log("pairs:", JSON.stringify(sync.pairs.map((p) => ({ ...p, lagSec: +p.lagSec?.toFixed(3), confidence: +p.confidence.toFixed(3), prominence: +p.prominence.toFixed(1), ambiguity: +p.ambiguity.toFixed(2) }))));
  console.log('drift applied (ppm):', sync.driftPpm.map((v) => v.toFixed(1)).join(', '), ' candidates:', sync.driftCandidatePpm.map((v) => v.toFixed(1)).join(', '));
  rows.forEach((r, k) => {
    const worst = Math.max(...r.map(Math.abs));
    check(`sync ${truth.tracks[k].name}: error vs track 1 at start/middle/end = ${r.map((e) => (e * 1000).toFixed(0) + ' ms').join(' / ')}`, worst < 0.2);
  });

  // Plan
  const timeline = makeTimeline(tracks, vads, sync.maps);
  const settings = { maxPause: 0.8, targetPause: 0.5, lead: 0.3, tail: 0.6 };
  const plan = makePlan(timeline, settings, sync.maps);
  console.log(`plan: ${plan.inputDuration.toFixed(1)} s -> ${plan.outputDuration.toFixed(1)} s, pauses cut ${plan.counts.pause} (${plan.removed.pause.toFixed(1)} s), segments ${plan.segments.length}, maxSeg ${plan.maxSegSec}`);
  let maxSilence = 0;
  {
    // longest silence left inside the edited programme (union of all speakers)
    const U = plan.U;
    let run = 0;
    for (const seg of plan.segments) {
      for (let f = Math.round(seg.start * FRAME_RATE); f < Math.round(seg.end * FRAME_RATE); f++) {
        if (U[f]) run = 0;
        else { run++; maxSilence = Math.max(maxSilence, run); }
      }
    }
  }
  check('no pause longer than the setting remains', maxSilence / FRAME_RATE <= settings.maxPause + 0.6, `longest ${(maxSilence / FRAME_RATE).toFixed(2)} s (includes lead/tail)`);
  let inv = 0;
  for (let t = 0; t < plan.outputDuration; t += 7.3) inv = Math.max(inv, Math.abs(refToOut(plan, outToRef(plan, t)) - t));
  check('output/ref time mapping round-trips', inv < 1e-9);

  // Render all tracks at 16 kHz and check lengths + loudness normalisation
  const gates = makeGates(timeline, -15);
  const layout = segmentsInSamples(plan, 16000);
  const tR = Date.now();
  tracks.forEach((t, k) => {
    let len = 0;
    const meter = new LoudnessMeter(16000);
    for (const ch of renderTrack({ src: t.pcm, map: sync.maps[k], env: gates[k], layout })) { len += ch.length; meter.push(ch); }
    check(`render ${t.name}: length matches layout`, len === layout.totalLen, `${len} / ${layout.totalLen}, ${meter.integrated().toFixed(1)} LUFS`);
  });
  console.log(`render 3 tracks @16k: ${Date.now() - tR} ms`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
