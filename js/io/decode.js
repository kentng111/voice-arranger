// Decoding audio files in the browser (Chrome / Edge decode AAC .m4a, MP3, WAV, FLAC...).

/**
 * Decode a File to mono Float32 at the requested sample rate.
 * The browser resamples while decoding, so analysis can run at 16 kHz and export at 48 kHz.
 */
export async function decodeToMono(file, sampleRate) {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  let audio;
  try {
    audio = await ctx.decodeAudioData(bytes);
  } catch (e) {
    const err = new Error(`「${file.name}」を読み込めませんでした。`);
    err.cause = e;
    err.hint = /\.m4a$/i.test(file.name)
      ? 'ボイスメモの音質設定が「ロスレス」の場合、ブラウザが読めないことがあります。「圧縮」で録音するか、WAVかAACに変換してから読み込んでください。'
      : '対応形式: m4a（AAC）, mp3, wav, flac など';
    throw err;
  }
  const n = audio.length;
  const ch = audio.numberOfChannels;
  let data;
  if (ch === 1) {
    data = audio.getChannelData(0);
  } else {
    data = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < n; i++) data[i] += d[i];
    }
    const inv = 1 / ch;
    for (let i = 0; i < n; i++) data[i] *= inv;
  }
  return { data, sampleRate: audio.sampleRate, duration: audio.duration, channels: ch };
}

/** Float32 [-1, 1] -> Int16 (halves memory for the analysis copy). */
export function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i] * 32767;
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}
