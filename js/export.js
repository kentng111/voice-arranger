// Full-quality export (48 kHz): one WAV per speaker, a finished mix, and edit notes.
// Tracks are decoded one at a time so memory stays manageable for long episodes.

import { decodeToMono } from './io/decode.js';
import { renderTrack, yieldToUI } from './core/render.js';
import { LoudnessMeter } from './core/loudness.js';
import { createLimiterStream } from './core/limiter.js';
import { encodePCM, wavHeader, makeRng, WavBlobReader } from './io/wav.js';
import { segmentsInSamples, refToOut, refToOutOrNull } from './core/plan.js';
import { buildCues, cuesToSrt, cuesToVtt, cuesToText } from './core/transcript.js';
import { writeText } from './io/output.js';
import { FRAME_RATE } from './core/vad.js';

export const OUT_RATE = 48000;

export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'episode';
}

const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);
const BOM = '﻿'; // so Excel opens UTF-8 text correctly
const CUT_LABEL = { pause: '間', head: '冒頭', tail: '末尾', filler: 'フィラー', manual: '手動でカット' };

/** Keeps files in memory only (used for intermediate per-speaker tracks when only the mix is wanted). */
function memorySink() {
  return {
    async create() {
      let parts = [];
      return {
        async write(bytes) { parts.push(bytes); },
        async close() {
          const blob = new Blob(parts);
          parts = [];
          return { blob: async () => blob };
        },
        async abort() { parts = []; },
      };
    },
  };
}

function fmt(sec) {
  return (Math.round(sec * 1000) / 1000).toFixed(3);
}

/**
 * @param {object} o
 *  tracks: [{ file, name }]
 *  maps, gates (per track), plan, settings { targetLufs, bitDepth, exportStems, exportMix }
 *  sink: from output.js; baseName; onProgress(fraction, text); log(text)
 */
export async function exportProject(o) {
  const { tracks, maps, gates, plan, settings, sink, onProgress = () => {}, log = () => {} } = o;
  const base = safeName(o.baseName);
  const layout = segmentsInSamples(plan, OUT_RATE);
  const total = layout.totalLen;
  const bitDepth = settings.bitDepth === 24 ? 24 : 16;
  const stemTarget = settings.targetLufs - 3; // mono measurement; = target when played as dual mono
  const K = tracks.length;
  const stages = K * 3 + (settings.exportMix ? 2 : 0) + 1;
  let stage = 0;
  const progress = (frac, text) => onProgress((stage + Math.min(1, frac)) / stages, text);
  const report = {
    app: 'Voice Arranger',
    createdAt: new Date().toISOString(),
    settings: { ...settings },
    outputDurationSec: plan.outputDuration,
    inputDurationSec: plan.inputDuration,
    cuts: plan.counts,
    removedSec: plan.removed,
    tracks: [],
    files: [],
  };
  const stemFiles = [];

  for (let k = 0; k < K; k++) {
    const t = tracks[k];
    progress(0, `${t.name}: 読み込み中（48kHz）`);
    log(`${t.name}: 48kHzで読み込み`);
    const { data } = await decodeToMono(t.file, OUT_RATE);
    stage++;

    // Pass 1: measure loudness of the edited track.
    const meter = new LoudnessMeter(OUT_RATE);
    let done = 0;
    let sinceYield = 0;
    for (const ch of renderTrack({ src: data, map: maps[k], env: gates[k], layout })) {
      meter.push(ch);
      done += ch.length;
      sinceYield += ch.length;
      if (sinceYield > 1 << 20) {
        sinceYield = 0;
        progress(done / total, `${t.name}: 音量を測定中`);
        await yieldToUI();
      }
    }
    const measured = meter.integrated();
    const gainDb = Number.isFinite(measured) ? Math.max(-24, Math.min(30, stemTarget - measured)) : 0;
    stage++;

    // Pass 2: write the WAV.
    const name = `${base}_${k + 1}_${safeName(t.name)}.wav`;
    const shouldWrite = settings.exportStems || settings.exportMix;
    if (shouldWrite) {
      const w = await (settings.exportStems ? sink : memorySink()).create(name);
      await w.write(wavHeader({ numFrames: total, sampleRate: OUT_RATE, channels: 1, bitDepth }));
      const lim = createLimiterStream(OUT_RATE, { ceilingDb: -1 });
      const rng = makeRng(0x1234567 + k);
      const gain = Math.pow(10, gainDb / 20);
      done = 0;
      sinceYield = 0;
      for (const ch of renderTrack({ src: data, map: maps[k], env: gates[k], layout, gain })) {
        const y = lim.push(ch);
        if (y.length) await w.write(encodePCM(y, { bitDepth, rng }));
        done += ch.length;
        sinceYield += ch.length;
        if (sinceYield > 1 << 20) {
          sinceYield = 0;
          progress(done / total, `${t.name}: 書き出し中`);
          await yieldToUI();
        }
      }
      await w.write(encodePCM(lim.end(), { bitDepth, rng }));
      const closed = await w.close();
      stemFiles.push({ name, closed });
      if (settings.exportStems) report.files.push(name);
      report.tracks.push({
        name: t.name,
        source: t.file.name,
        startSec: -maps[k].b / maps[k].a,
        driftPpm: (1 - maps[k].a) * 1e6,
        measuredLufs: measured,
        gainDb,
        limiterDb: lim.reductionDb,
        file: settings.exportStems ? name : null,
      });
      log(`${t.name}: ${measured.toFixed(1)} LUFS → ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`);
    }
    stage++;
  }

  if (settings.exportMix) {
    progress(0, 'ミックス: 音量を測定中');
    const readers = [];
    for (const s of stemFiles) readers.push(await WavBlobReader.open(await s.closed.blob()));
    const CH = 1 << 18;
    const sumAt = async (pos, n) => {
      const out = new Float32Array(n);
      for (const r of readers) {
        const x = await r.read(pos, n);
        for (let i = 0; i < x.length; i++) out[i] += x[i];
      }
      return out;
    };
    const meter = new LoudnessMeter(OUT_RATE);
    for (let pos = 0; pos < total; pos += CH) {
      meter.push(await sumAt(pos, Math.min(CH, total - pos)));
      if ((pos / CH) % 4 === 0) {
        progress(pos / total, 'ミックス: 音量を測定中');
        await yieldToUI();
      }
    }
    const measured = meter.integrated();
    const mixGainDb = Number.isFinite(measured) ? Math.max(-24, Math.min(24, stemTarget - measured)) : 0;
    stage++;
    const name = `${base}_mix.wav`;
    const w = await sink.create(name);
    await w.write(wavHeader({ numFrames: total, sampleRate: OUT_RATE, channels: 2, bitDepth: 16 }));
    const lim = createLimiterStream(OUT_RATE, { ceilingDb: -1 });
    const rng = makeRng(0xabcdef);
    const g = Math.pow(10, mixGainDb / 20);
    for (let pos = 0; pos < total; pos += CH) {
      const x = await sumAt(pos, Math.min(CH, total - pos));
      for (let i = 0; i < x.length; i++) x[i] *= g;
      const y = lim.push(x);
      if (y.length) await w.write(encodePCM(y, { bitDepth: 16, channels: 2, rng }));
      if ((pos / CH) % 4 === 0) {
        progress(pos / total, 'ミックス: 書き出し中');
        await yieldToUI();
      }
    }
    await w.write(encodePCM(lim.end(), { bitDepth: 16, channels: 2, rng }));
    await w.close();
    report.files.push(name);
    report.mix = { file: name, lufs: measured + mixGainDb + 3.01, measuredBeforeGainLufs: measured + 3.01, gainDb: mixGainDb, limiterDb: lim.reductionDb };
    log(`ミックス: ${settings.targetLufs} LUFS に調整（${mixGainDb >= 0 ? '+' : ''}${mixGainDb.toFixed(1)} dB）`);
    stage++;
  }

  // Edit notes
  progress(0, 'カット一覧を書き出し中');
  const fillers = o.fillers || [];
  const fillerOf = new Map(fillers.map((f) => [f.id, f]));
  const active = plan.cuts.filter((c) => c.enabled);
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = ['種類,話者,内容,元の開始(秒),元の終了(秒),削除した長さ(秒),編集後の位置(秒)'];
  const labels = [];
  for (const c of active) {
    const at = refToOut(plan, c.startSec);
    const f = c.fillerId != null ? fillerOf.get(c.fillerId) : null;
    const who = f ? tracks[f.track].name : '';
    const what = f ? f.text : '';
    rows.push([CUT_LABEL[c.type] || c.type, q(who), q(what), fmt(c.startSec), fmt(c.endSec), fmt(c.endSec - c.startSec), fmt(at)].join(','));
    labels.push(`${fmt(at)}\t${fmt(at)}\t${CUT_LABEL[c.type] || c.type}${what ? ' ' + what : ''} -${(c.endSec - c.startSec).toFixed(1)}s`);
  }
  for (const m of plan.mutes || []) {
    if (m.mode !== 'mute' && m.mode !== 'manual') continue;
    const f = m.mode === 'manual' ? { text: '手動で消音' } : fillerOf.get(m.fillerId);
    const s0 = m.start / FRAME_RATE;
    const at = refToOut(plan, s0);
    rows.push([m.mode === 'manual' ? '手動で消音' : 'フィラー（音だけ消す）', q(tracks[m.track].name), q(f ? f.text : ''), fmt(s0), fmt(m.end / FRAME_RATE), '0.000', fmt(at)].join(','));
    labels.push(`${fmt(at)}\t${fmt(refToOut(plan, m.end / FRAME_RATE))}\t${tracks[m.track].name}: ${f ? f.text : 'フィラー'}（音だけ消す）`);
  }
  await writeText(sink, `${base}_cuts.csv`, BOM + rows.join(CRLF) + CRLF);
  await writeText(sink, `${base}_markers_audacity.txt`, labels.join(LF) + LF);
  report.files.push(`${base}_cuts.csv`, `${base}_markers_audacity.txt`);

  if (o.transcript) {
    report.fillers = {
      total: fillers.length,
      adopted: fillers.filter((f) => f.enabled).length,
      cut: plan.counts.filler,
      muted: plan.counts.mute,
      model: o.transcript.model,
    };
    // Full transcript + decisions (also the input for tests/eval_fillers.mjs). Times: each track's own file.
    const raw = {
      app: 'Voice Arranger',
      kind: 'transcript',
      tracks: tracks.map((t, k) => ({ name: t.name, source: t.file.name, startSec: -maps[k].b / maps[k].a, driftPpm: (1 - maps[k].a) * 1e6 })),
      transcript: o.transcript,
      fillers,
      ...(o.evalRanges ? { evalRanges: o.evalRanges, evalRangeRef: o.evalRangeRef } : {}),
    };
    await writeText(sink, `${base}_transcript.json`, JSON.stringify(raw));
    report.files.push(`${base}_transcript.json`);
    if (settings.exportTranscript) {
      const cues = buildCues(
        tracks.map((t, k) => ({ name: t.name, units: o.transcript.tracks[k].units, map: maps[k] })),
        fillers,
        (T) => refToOutOrNull(plan, T),
        { toOutClamp: (T) => refToOut(plan, T) },
      );
      await writeText(sink, `${base}_transcript.txt`, BOM + cuesToText(cues));
      await writeText(sink, `${base}_transcript.srt`, cuesToSrt(cues));
      await writeText(sink, `${base}_transcript.vtt`, cuesToVtt(cues));
      report.files.push(`${base}_transcript.txt`, `${base}_transcript.srt`, `${base}_transcript.vtt`);
    }
  }
  report.files.push(`${base}_report.json`);
  await writeText(sink, `${base}_report.json`, JSON.stringify(report, null, 2));
  stage++;
  onProgress(1, '完了');
  return report;
}
