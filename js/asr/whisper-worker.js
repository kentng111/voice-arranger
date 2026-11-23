// Web Worker: runs Whisper (Transformers.js) on chunks of 16 kHz audio and returns timed units.
// Messages in:  { type: 'load', modelId, dtype, device }
//               { type: 'transcribe', id, audio: Float32Array, offset }
// Messages out: { type: 'progress', file, loaded, total, status }
//               { type: 'ready', device } | { type: 'result', id, units, ms } | { type: 'error', id, message }

import { TRANSFORMERS_URL } from './models.js';
import { collateWhisperTokens, cleanupUnits } from '../core/transcript.js';

let lib = null;
let model = null;
let processor = null;
let tokenizer = null;
let specialFrom = 50257;

async function load({ modelId, dtype, device }) {
  lib = lib || (await import(TRANSFORMERS_URL));
  lib.env.allowLocalModels = false;
  const progress_callback = (p) => {
    if (p.status === 'progress' || p.status === 'done' || p.status === 'initiate') {
      postMessage({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
    }
  };
  processor = await lib.AutoProcessor.from_pretrained(modelId, { progress_callback });
  tokenizer = await lib.AutoTokenizer.from_pretrained(modelId, { progress_callback });
  model = await lib.WhisperForConditionalGeneration.from_pretrained(modelId, { dtype, device, progress_callback });
  specialFrom = Math.min(...tokenizer.all_special_ids.map(Number));
  // first run compiles the GPU kernels; do it now so the progress bar reflects real work later
  await run(new Float32Array(16000), 0);
  postMessage({ type: 'ready', device });
}

async function run(audio, offset) {
  const inputs = await processor(audio);
  const out = await model.generate({
    inputs: inputs.input_features,
    language: 'ja',
    task: 'transcribe',
    return_timestamps: true,
    return_token_timestamps: true,
    num_frames: Math.floor(audio.length / 160),
  });
  const tokens = out.sequences.tolist()[0].map(Number);
  const times = out.token_timestamps.tolist()[0].map(Number);
  const decode = (ids) => tokenizer.decode(ids, { skip_special_tokens: false });
  return cleanupUnits(collateWhisperTokens(tokens, times, decode, specialFrom, offset));
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') await load(msg);
    else if (msg.type === 'transcribe') {
      const t0 = performance.now();
      const units = await run(msg.audio, msg.offset);
      postMessage({ type: 'result', id: msg.id, units, ms: performance.now() - t0 });
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
