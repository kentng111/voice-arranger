// WAV (PCM) writing and reading helpers.

export function wavHeader({ numFrames, sampleRate, channels = 1, bitDepth = 16 }) {
  const bytesPerSample = bitDepth / 8;
  const dataBytes = numFrames * channels * bytesPerSample;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPerSample, true);
  v.setUint16(32, channels * bytesPerSample, true);
  v.setUint16(34, bitDepth, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

/** Fast deterministic random numbers for dither. */
export function makeRng(seed = 0x9e3779b9) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Float samples -> PCM bytes. channels = 2 duplicates the mono signal (dual mono).
 * 16-bit output uses TPDF dither.
 */
export function encodePCM(f32, { bitDepth = 16, channels = 1, rng = null } = {}) {
  const n = f32.length;
  if (bitDepth === 16) {
    const out = new Int16Array(n * channels);
    const r = rng || makeRng();
    for (let i = 0; i < n; i++) {
      let v = f32[i] * 32767 + (r() - r());
      v = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
      if (channels === 1) out[i] = v;
      else { out[2 * i] = v; out[2 * i + 1] = v; }
    }
    return new Uint8Array(out.buffer);
  }
  if (bitDepth === 24) {
    const out = new Uint8Array(n * channels * 3);
    let o = 0;
    for (let i = 0; i < n; i++) {
      let v = Math.round(f32[i] * 8388607);
      v = v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v;
      for (let c = 0; c < channels; c++) {
        out[o++] = v & 0xff;
        out[o++] = (v >> 8) & 0xff;
        out[o++] = (v >> 16) & 0xff;
      }
    }
    return out;
  }
  throw new Error('Unsupported bit depth ' + bitDepth);
}

/** Decode interleaved PCM bytes of the first channel into floats. */
export function decodePCM(bytes, { bitDepth = 16, channels = 1 } = {}) {
  const bps = bitDepth / 8;
  const n = Math.floor(bytes.byteLength / (bps * channels));
  const out = new Float32Array(n);
  if (bitDepth === 16) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2 * channels, true) / 32768;
  } else if (bitDepth === 24) {
    for (let i = 0; i < n; i++) {
      const o = i * 3 * channels;
      let v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      if (v & 0x800000) v |= ~0xffffff;
      out[i] = v / 8388608;
    }
  } else if (bitDepth === 32) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4 * channels, true);
  }
  return out;
}

/** Parse the header of a canonical or extended WAV file. */
export function parseWavHeader(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let fmt = null;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(o + 8, true),
        channels: v.getUint16(o + 10, true),
        sampleRate: v.getUint32(o + 12, true),
        bitDepth: v.getUint16(o + 22, true),
      };
    } else if (id === 'data') {
      return { ...fmt, dataOffset: o + 8, dataBytes: size };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV data chunk not found');
}

/** Reads float samples (first channel) from a WAV Blob in chunks. */
export class WavBlobReader {
  constructor(blob, header) {
    this.blob = blob;
    this.h = header;
    this.frameBytes = (header.bitDepth / 8) * header.channels;
    this.numFrames = Math.floor(header.dataBytes / this.frameBytes);
  }
  static async open(blob) {
    const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    return new WavBlobReader(blob, parseWavHeader(head));
  }
  async read(startFrame, count) {
    const s = this.h.dataOffset + startFrame * this.frameBytes;
    const e = s + count * this.frameBytes;
    const bytes = new Uint8Array(await this.blob.slice(s, e).arrayBuffer());
    return decodePCM(bytes, { bitDepth: this.h.bitDepth, channels: this.h.channels });
  }
}
