// Where exported files go: a folder chosen by the user (Chrome / Edge), or ordinary downloads.

export function folderPickerAvailable() {
  const params = new URLSearchParams(location.search);
  return typeof window.showDirectoryPicker === 'function' && !params.has('download');
}

function mimeFor(name) {
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.csv')) return 'text/csv';
  return 'text/plain';
}

/** Ask the user for an output folder. Resolves to a sink, or null if cancelled. */
export async function pickFolderSink() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'voice-arranger-output', mode: 'readwrite', startIn: 'music' });
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    throw e;
  }
  return {
    kind: 'folder',
    label: `フォルダ「${dir.name}」`,
    async create(name) {
      const fh = await dir.getFileHandle(name, { create: true });
      const ws = await fh.createWritable();
      return {
        write: (bytes) => ws.write(bytes),
        async close() {
          await ws.close();
          return { blob: () => fh.getFile() };
        },
        async abort() {
          try { await ws.abort(); } catch { /* ignore */ }
        },
      };
    },
  };
}

/**
 * Fallback when a folder cannot be chosen (browsers other than Chrome / Edge):
 * files are kept in memory and offered as download links after the export.
 */
export function downloadSink() {
  const files = [];
  return {
    kind: 'download',
    label: '下のリンクから保存してください',
    files,
    async create(name) {
      let parts = [];
      return {
        async write(bytes) { parts.push(bytes); },
        async close() {
          const blob = new Blob(parts, { type: mimeFor(name) });
          parts = [];
          files.push({ name, blob });
          return { blob: async () => blob };
        },
        async abort() { parts = []; },
      };
    },
  };
}

export async function writeText(sink, name, text) {
  const w = await sink.create(name);
  await w.write(new TextEncoder().encode(text));
  return w.close();
}
