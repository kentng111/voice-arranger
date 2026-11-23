// Quick preview (16 kHz mono) built from the analysis copies kept in memory.

import { renderTrack, yieldToUI } from './core/render.js';
import { LoudnessMeter } from './core/loudness.js';
import { createLimiterStream } from './core/limiter.js';
import { segmentsInSamples } from './core/plan.js';
import { wavHeader, encodePCM } from './io/wav.js';

export async function buildPreview({ tracks, maps, gates, plan, targetLufs = -16, onProgress = () => {} }) {
  const rate = tracks[0].rate;
  const layout = segmentsInSamples(plan, rate);
  const total = layout.totalLen;
  const mix = new Float32Array(total);
  const target = targetLufs - 3;
  const K = tracks.length;
  for (let k = 0; k < K; k++) {
    const t = tracks[k];
    const common = { src: t.pcm16, srcScale: 1 / 32768, map: maps[k], env: gates[k], layout };
    const meter = new LoudnessMeter(rate);
    let n = 0;
    for (const ch of renderTrack(common)) {
      meter.push(ch);
      if (++n % 8 === 0) {
        onProgress((k + 0.5 * (n * ch.length) / total) / (K + 1));
        await yieldToUI();
      }
    }
    const L = meter.integrated();
    const gain = Number.isFinite(L) ? Math.pow(10, Math.max(-24, Math.min(30, target - L)) / 20) : 1;
    let pos = 0;
    n = 0;
    for (const ch of renderTrack({ ...common, gain })) {
      for (let i = 0; i < ch.length; i++) mix[pos + i] += ch[i];
      pos += ch.length;
      if (++n % 8 === 0) {
        onProgress((k + 0.5 + (0.5 * pos) / total) / (K + 1));
        await yieldToUI();
      }
    }
  }
  const meter = new LoudnessMeter(rate);
  meter.push(mix);
  const L = meter.integrated();
  const g = Number.isFinite(L) ? Math.pow(10, Math.max(-24, Math.min(24, target - L)) / 20) : 1;
  for (let i = 0; i < total; i++) mix[i] *= g;
  const lim = createLimiterStream(rate, { ceilingDb: -1 });
  const a = lim.push(mix);
  const b = lim.end();
  const out = new Float32Array(total);
  out.set(a);
  out.set(b, a.length);
  onProgress(1);
  const blob = new Blob([wavHeader({ numFrames: total, sampleRate: rate, channels: 1, bitDepth: 16 }), encodePCM(out, { bitDepth: 16 })], {
    type: 'audio/wav',
  });
  return { blob, duration: total / rate };
}
