// Speech recognition models that can run in the browser (Transformers.js + ONNX Runtime Web).
// Model files are downloaded once from Hugging Face and kept in the browser's cache.
// Audio is never uploaded: the models run on this PC.

export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

// kotoba-whisper (Japanese) is not listed: its ONNX export gives no per-token times.
// dtype per device. "f16" = the GPU supports half precision (shader-f16).
// sizeMB: approximate download for that choice.
export const ASR_MODELS = [
  {
    key: 'base',
    id: 'onnx-community/whisper-base_timestamped',
    label: 'Whisper base（速い・精度は低め）',
    variants: {
      f16: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, sizeMB: 205 },
      webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, sizeMB: 205 },
      wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, sizeMB: 76 },
    },
  },
  {
    key: 'small',
    id: 'onnx-community/whisper-small_timestamped',
    label: 'Whisper small（標準）',
    variants: {
      f16: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4f16' }, sizeMB: 321 },
      webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, sizeMB: 585 },
      wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, sizeMB: 248 },
    },
  },
  {
    key: 'turbo',
    id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    label: 'Whisper large-v3-turbo（高精度・GPU向け）',
    variants: {
      f16: { dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }, sizeMB: 563 },
      webgpu: { dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, sizeMB: 759 },
      wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, sizeMB: 1083 },
    },
  },
];

export function modelByKey(key) {
  return ASR_MODELS.find((m) => m.key === key) || ASR_MODELS[1];
}

/** What this browser can use: 'f16' (WebGPU with half precision), 'webgpu', or 'wasm'. */
export async function detectAccel() {
  try {
    if (!navigator.gpu) return { kind: 'wasm', note: 'WebGPU が使えないため CPU で動かします（遅くなります）' };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { kind: 'wasm', note: 'GPU が見つからないため CPU で動かします（遅くなります）' };
    const f16 = adapter.features.has('shader-f16');
    return { kind: f16 ? 'f16' : 'webgpu', note: f16 ? 'GPU（WebGPU・半精度）で動かします' : 'GPU（WebGPU）で動かします' };
  } catch (e) {
    return { kind: 'wasm', note: `WebGPU を初期化できないため CPU で動かします（${e.message}）` };
  }
}
