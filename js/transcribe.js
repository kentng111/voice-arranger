// Transcription in the browser (Whisper in a Web Worker) and filler candidates.

import { modelByKey } from './asr/models.js';
import { planAsrChunks, chunkSamples } from './core/asrplan.js';
import { acousticFeatures, findFillerCandidates } from './core/filler.js';
import { TRANSCRIPT_VERSION, dropLeakedUnits, foreignFrames } from './core/transcript.js';
import { FRAME_RATE } from './core/vad.js';
import { yieldToUI } from './core/render.js';

/** Is the model already in the browser cache (no download needed)? */
export async function isModelCached(modelId) {
  try {
    if (!('caches' in self)) return false;
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((r) => r.url.includes(`/${modelId}/`) && /encoder_model/.test(r.url));
  } catch {
    return false;
  }
}

export class WhisperEngine {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.loadedKey = null;
  }

  /** onDownload(fraction, loadedBytes, totalBytes) */
  load(modelKey, accel, onDownload = () => {}) {
    const m = modelByKey(modelKey);
    const v = m.variants[accel] || m.variants.wasm;
    const device = accel === 'wasm' ? 'wasm' : 'webgpu';
    this.terminate();
    this.worker = new Worker(new URL('./asr/whisper-worker.js', import.meta.url), { type: 'module' });
    const files = new Map();
    return new Promise((resolve, reject) => {
      this.worker.onerror = (e) => reject(new Error(e.message || '文字起こしの準備に失敗しました'));
      this.worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          if (msg.file && msg.total) files.set(msg.file, { loaded: msg.status === 'done' ? msg.total : msg.loaded, total: msg.total });
          let l = 0, t = 0;
          for (const f of files.values()) { l += f.loaded; t += f.total; }
          if (t) onDownload(l / t, l, t);
        } else if (msg.type === 'ready') {
          this.ready = true;
          this.loadedKey = `${modelKey}|${accel}`;
          this.worker.onmessage = (ev) => this._onMessage(ev.data);
          resolve({ device: msg.device, model: m, variant: v });
        } else if (msg.type === 'error') {
          reject(new Error(msg.message));
        }
      };
      this.worker.postMessage({ type: 'load', modelId: m.id, dtype: v.dtype, device });
    });
  }

  _onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'result') p.resolve(msg);
    else p.reject(new Error(msg.message));
  }

  transcribe(audio, offset) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, audio, offset }, [audio.buffer]);
    });
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('中止しました'));
    this.pending.clear();
    this.worker = null;
    this.ready = false;
    this.loadedKey = null;
  }
}

/**
 * Transcribe each track's own speech.
 * tracks: [{ name, pcm16, rate (16000), vad, levels }]
 * onProgress(fraction, text); isCancelled() -> bool
 */
export async function transcribeTracks({ tracks, maps, engine, modelKey, onProgress = () => {}, isCancelled = () => false, resume = null, onCheckpoint = () => {} }) {
  const plans = tracks.map((t) => planAsrChunks(t.vad.segments, t.levels));
  const total = plans.reduce((a, cs) => a + cs.reduce((b, c) => b + (c.end - c.start), 0), 0) || 1;
  let done = 0;
  let skipped = 0; // audio already transcribed in an earlier, interrupted run
  const t0 = performance.now();
  // resume: { model, tracks: [{ units, chunksDone }] } from an interrupted run with the same model
  const prev = resume && resume.model === modelByKey(modelKey).id && Array.isArray(resume.tracks) ? resume.tracks : [];
  const partial = { model: modelByKey(modelKey).id, tracks: tracks.map(() => ({ units: [], chunksDone: 0 })) };
  const out = { version: TRANSCRIPT_VERSION, engine: 'whisper-web', model: modelByKey(modelKey).id, language: 'ja', createdAt: new Date().toISOString(), tracks: [] };
  for (let k = 0; k < tracks.length; k++) {
    const t = tracks[k];
    const units = [];
    const p = prev[k] && prev[k].chunksDone <= plans[k].length ? prev[k] : null;
    const startAt = p ? p.chunksDone : 0;
    if (p) units.push(...p.units);
    for (let ci = 0; ci < startAt; ci++) {
      const c = plans[k][ci];
      done += c.end - c.start;
      skipped += c.end - c.start;
    }
    partial.tracks[k] = { units, chunksDone: startAt };
    for (let ci = startAt; ci < plans[k].length; ci++) {
      const c = plans[k][ci];
      if (isCancelled()) throw new Error('中止しました');
      const audio = chunkSamples(t.pcm16, t.rate, c, t.vad.act);
      const res = await engine.transcribe(audio, c.start);
      units.push(...res.units);
      partial.tracks[k].chunksDone = ci + 1;
      onCheckpoint(partial);
      done += c.end - c.start;
      const el = (performance.now() - t0) / 1000;
      const eta = done - skipped > 0 ? (el / (done - skipped)) * (total - done) : 0;
      onProgress(done / total, `${t.name}: 文字起こし中（${fmtMin(done)} / ${fmtMin(total)} の音声、残り約 ${fmtMin(eta)}）`);
    }
    out.tracks.push({ units });
  }
  // text that is really someone else's voice leaking into this phone
  if (maps) {
    const levels = tracks.map((t) => t.levels);
    const speech = tracks.map((t) => t.vad.speechDb);
    const cores = tracks.map((t) => t.vad.core);
    out.tracks.forEach((tr, k) => {
      const before = tr.units.length;
      tr.units = dropLeakedUnits(tr.units, k, levels, cores, speech, maps);
      tr.droppedLeaked = before - tr.units.length;
    });
  }
  out.audioSec = total;
  out.elapsedSec = (performance.now() - t0) / 1000;
  return out;
}

function fmtMin(sec) {
  return sec >= 60 ? `${Math.floor(sec / 60)}分${String(Math.round(sec % 60)).padStart(2, '0')}秒` : `${Math.round(sec)}秒`;
}

/**
 * Filler candidates for every track. Returns [{ id, track, start, end, text, cls, sources, score, enabled }].
 * The acoustic analysis runs in slices so the page stays responsive.
 */
export async function detectFillers({ tracks, transcript, maps = null, onProgress = () => {} }) {
  const all = [];
  const levels = tracks.map((t) => t.levels);
  const cores = tracks.map((t) => t.vad.core);
  const speech = tracks.map((t) => t.vad.speechDb);
  for (let k = 0; k < tracks.length; k++) {
    const t = tracks[k];
    const n = t.vad.core.length;
    const SLICE = 60 * FRAME_RATE;
    let feat = null;
    for (let f0 = 0; f0 < n; f0 += SLICE) {
      feat = acousticFeatures(t.pcm16, t.rate, t.vad.core, { from: f0, to: f0 + SLICE, out: feat });
      onProgress((k + f0 / n) / tracks.length, `${t.name}: 音の特徴を解析中`);
      await yieldToUI();
    }
    const foreign = maps ? foreignFrames(k, levels, cores, speech, maps) : null;
    const cands = findFillerCandidates({ units: transcript.tracks[k].units, core: t.vad.core, levels: t.levels, feat, foreign });
    cands.forEach((c, i) => all.push({ ...c, id: `${k}-${i}`, track: k, enabled: c.cls === 'auto', defaultEnabled: c.cls === 'auto' }));
  }
  return all;
}
