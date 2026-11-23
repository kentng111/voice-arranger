// Transcript with filler candidates, as a list of rows (one row = one stretch of one speaker).

import { fmtTime } from './timeline.js';

/**
 * rows: [{ track, T, start, end, tokens: [{ kind: 'text'|'filler', text, id? }] }]
 * T = start on the common timeline (seconds). Fillers swallow the text units inside them.
 */
export function buildRows(transcript, fillers, maps) {
  const rows = [];
  transcript.tracks.forEach((tr, k) => {
    const m = maps[k];
    const fl = fillers.filter((f) => f.track === k).sort((a, b) => a.start - b.start);
    const tokens = [];
    const used = new Set();
    for (const f of fl) {
      const inside = [];
      const a = f.textStart ?? f.start;
      const b = f.textEnd ?? f.end;
      tr.units.forEach((u, i) => {
        if (used.has(i)) return;
        const mid = (u.start + u.end) / 2;
        if (mid >= a - 0.02 && mid <= b + 0.02 && (f.textStart != null || !/^[、。]$/.test(u.text))) { inside.push(u.text); used.add(i); }
      });
      // show the words the candidate covers; a drawn-out sound inside a word is marked with "〜"
      const text = inside.length ? inside.join('') + (f.sources.includes('text') ? '' : '〜') : f.text;
      // text-based fillers keep their place in the text; sound-only ones sit at their time
      tokens.push({ kind: 'filler', id: f.id, text, start: a, end: b });
    }
    tr.units.forEach((u, i) => {
      if (!used.has(i)) tokens.push({ kind: 'text', text: u.text, start: u.start, end: u.end });
    });
    tokens.sort((a, b) => a.start - b.start || (a.kind === 'filler' ? -1 : 1));
    let row = null;
    let chars = 0;
    for (const t of tokens) {
      const brk = !row || t.start - row.end > 1.2 || chars > 110 || /[。？！?!]$/.test(row.tokens[row.tokens.length - 1].text);
      if (brk) {
        row = { track: k, start: t.start, end: t.end, tokens: [], T: (t.start - m.b) / m.a };
        rows.push(row);
        chars = 0;
      }
      row.tokens.push(t);
      row.end = Math.max(row.end, t.end);
      chars += t.text.length;
    }
  });
  rows.sort((a, b) => a.T - b.T);
  return rows;
}

/** Fill the container. Returns a map filler id -> <mark> element for quick updates. */
export function renderRows(container, rows, tracks) {
  const marks = new Map();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'trow';
    div.dataset.t = String(r.T);
    const tm = document.createElement('button');
    tm.className = 'tt';
    tm.dataset.t = String(r.T);
    tm.textContent = fmtTime(r.T);
    tm.title = 'この位置を上の図で表示して再生';
    const spk = document.createElement('span');
    spk.className = 'spk';
    spk.style.color = tracks[r.track].color;
    spk.textContent = tracks[r.track].name;
    const txt = document.createElement('span');
    txt.className = 'txt';
    let hasF = false;
    let buf = '';
    const flush = () => {
      if (buf) txt.appendChild(document.createTextNode(buf));
      buf = '';
    };
    for (const t of r.tokens) {
      if (t.kind === 'text') { buf += t.text; continue; }
      flush();
      const mk = document.createElement('mark');
      mk.dataset.id = t.id;
      mk.textContent = t.text;
      txt.appendChild(mk);
      marks.set(t.id, mk);
      hasF = true;
    }
    flush();
    if (hasF) div.classList.add('hasf');
    div.append(tm, spk, txt);
    frag.appendChild(div);
  }
  container.innerHTML = '';
  container.appendChild(frag);
  return marks;
}

/** Update the look of each mark: class (auto / review), adopted (cut) and how it is removed. */
export function updateMarks(marks, fillers, plan, selectedId) {
  const mode = new Map((plan.fillers || []).map((f) => [f.id, f.mode]));
  for (const f of fillers) {
    const mk = marks.get(f.id);
    if (!mk) continue;
    const v = f.verdict === 'yes' ? ' v-yes' : f.verdict === 'no' ? ' v-no' : '';
    const man = f.sources.includes('manual') ? ' manual' : '';
    mk.className = `fl ${f.cls}${f.enabled ? ' on' : ''}${mode.get(f.id) === 'mute' ? ' mute' : ''}${f.id === selectedId ? ' sel' : ''}${v}${man}`;
    const how = !f.enabled ? '残す' : mode.get(f.id) === 'mute' ? '切る（他の人が話しているので、この人の音だけ消す）' : '切る';
    mk.title = `${f.cls === 'auto' ? '自動候補' : '要確認'}・${how}（根拠: ${f.sources.map((s) => SRC[s] || s).join('・')}）`;
  }
}

const SRC = { text: '文字起こし', gap: '文字にならない声', sound: '伸ばす音', manual: '手で追加' };

/** Evaluation mode: show only rows inside [T0, T1] (common timeline). */
export function filterRows(container, T0, T1) {
  for (const row of container.children) {
    const t = parseFloat(row.dataset.t);
    row.classList.toggle('out', Number.isFinite(T0) && (t < T0 - 1 || t > T1));
  }
}

/** Highlight the row being played. */
export function markNowRow(container, T) {
  let now = null;
  for (const row of container.children) {
    if (row.classList.contains('out')) continue;
    if (parseFloat(row.dataset.t) <= T) now = row;
  }
  for (const r of container.querySelectorAll('.trow.now')) if (r !== now) r.classList.remove('now');
  if (now && !now.classList.contains('now')) {
    now.classList.add('now');
    now.scrollIntoView({ block: 'nearest' });
  }
}
