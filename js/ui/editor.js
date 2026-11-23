// Track editor in the style of GarageBand: one lane per speaker with its waveform,
// S (solo) / M (mute) buttons, a playhead, drag to select, and clickable cut bands.
// Everything is shown on the common timeline BEFORE cutting: cuts are drawn as bands so
// it stays visible what was removed, and every cut can be put back.

import { FRAME_RATE } from '../core/vad.js';
import { fmtTime } from './timeline.js';
import { playRaw, playEdited, stopSnippet, isCurrent } from './snippet.js';

const RULER = 26;
const LANE = 104;
const TEXT_H = 30; // the row of words under each waveform
const HEADER_W = 140;

/** min / max of each 10 ms frame (Int16), for fast waveform drawing. */
function computePeaks(pcm16, rate) {
  const hop = Math.round(rate / FRAME_RATE);
  const n = Math.floor(pcm16.length / hop);
  const mn = new Int16Array(n);
  const mx = new Int16Array(n);
  for (let f = 0, i = 0; f < n; f++) {
    let a = 32767;
    let b = -32768;
    for (let j = 0; j < hop; j++, i++) {
      const v = pcm16[i];
      if (v < a) a = v;
      if (v > b) b = v;
    }
    mn[f] = a;
    mx[f] = b;
  }
  return { mn, mx };
}

export class TrackEditor {
  /**
   * host: {
   *   model(): { tracks, maps, timeline, plan, gates, transcript, fillers, view }
   *   cut(range) / mute(track, range)             add a hand edit
   *   toggleAutoCut(key) / removeManualCut(id) / removeManualMute(id) / setFiller(id, enabled)
   *   undo() / redo() / canUndo() / canRedo()
   *   changedView()                                cursor or zoom changed (redraw other views)
   * }
   */
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.sel = null; // { kind: 'range', track|null, start, end } | { kind: 'cut', cut } | { kind: 'mute', mute }
    this.solo = new Set();
    this.muted = new Set();
    this.peaks = new WeakMap(); // pcm16 -> peaks (kept when tracks are renamed)
    this.playhead = 0;
    this.play = null;
    this.raf = 0;
    this.drag = null;
    this.build();
    this.updateSelPanel();
  }

  // ------------------------------------------------------------ DOM

  build() {
    this.root.innerHTML = `
      <div class="ed-bar">
        <button class="btn primary ed-play" data-a="play" title="再生 / 停止（スペース）">▶ 再生</button>
        <span class="seg" title="どちらの音を流すか">
          <button data-a="mode-edited" class="on">編集後</button><button data-a="mode-raw">編集前</button>
        </span>
        <span class="ed-time"></span>
        <span class="ed-sp"></span>
        <button class="btn" data-a="prevcut" title="前の編集箇所へ">← 前の編集</button>
        <button class="btn" data-a="nextcut" title="次の編集箇所へ">次の編集 →</button>
        <span class="ed-zoom">
          <button class="btn" data-a="zoomout" title="縮小（－ / Ctrl＋ホイール）">－</button>
          <button class="btn" data-a="zoomin" title="拡大（＋ / Ctrl＋ホイール）">＋</button>
        </span>
        <button class="btn" data-a="undo" title="元に戻す（Ctrl＋Z）">↶ 元に戻す</button>
        <button class="btn" data-a="redo" title="やり直し（Ctrl＋Y）">↷</button>
      </div>
      <div class="ed-sel">
        <span class="ed-selinfo"></span>
        <span class="ed-selbtns"></span>
      </div>
      <div class="ed-body">
        <div class="ed-heads"></div>
        <canvas class="ed-canvas" tabindex="0"></canvas>
      </div>`;
    this.canvas = this.root.querySelector('canvas');
    this.heads = this.root.querySelector('.ed-heads');
    this.selInfo = this.root.querySelector('.ed-selinfo');
    this.selBtns = this.root.querySelector('.ed-selbtns');
    this.timeEl = this.root.querySelector('.ed-time');
    this.playBtn = this.root.querySelector('[data-a=play]');
    this.mode = 'edited'; // which sound the play button plays: 'edited' | 'raw'
    this.root.querySelector('.ed-bar').addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      this.action(a.dataset.a);
    });
    this.selBtns.addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]');
      if (b) this.action(b.dataset.s);
    });
    const c = this.canvas;
    c.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.draw());
  }

  /** (Re)build the track headers; call after analysis or when names change. */
  setTracks() {
    const m = this.host.model();
    if (!m) return;
    this.heads.innerHTML = '';
    this.heads.style.paddingTop = `${RULER}px`;
    m.tracks.forEach((t, k) => {
      const h = document.createElement('div');
      h.className = 'ed-head';
      h.style.height = `${LANE}px`;
      h.innerHTML = `<span class="ed-name"></span><span class="ed-sm"><button class="ed-s" title="この人の声だけを流す（聞くときだけ。保存には影響しません）">だけ聞く</button><button class="ed-m" title="この人の声を流さない（聞くときだけ。保存には影響しません）">聞かない</button></span>`;
      h.querySelector('.ed-name').textContent = t.name;
      h.querySelector('.ed-name').style.color = t.color;
      h.querySelector('.ed-s').addEventListener('click', () => this.toggleSet(this.solo, k));
      h.querySelector('.ed-m').addEventListener('click', () => this.toggleSet(this.muted, k));
      this.heads.appendChild(h);
    });
    this.refreshHeads();
    this.draw();
  }

  toggleSet(set, k) {
    if (set.has(k)) set.delete(k);
    else set.add(k);
    this.refreshHeads();
    if (this.play) this.startPlay();
  }

  refreshHeads() {
    [...this.heads.children].forEach((h, k) => {
      h.querySelector('.ed-s').classList.toggle('on', this.solo.has(k));
      h.querySelector('.ed-m').classList.toggle('on', this.muted.has(k));
      h.classList.toggle('dim', this.gains()[k] === 0);
    });
  }

  gains() {
    const m = this.host.model();
    const K = m ? m.tracks.length : 0;
    return Array.from({ length: K }, (_, k) => (this.muted.has(k) ? 0 : this.solo.size && !this.solo.has(k) ? 0 : 1));
  }

  // ------------------------------------------------------------ geometry

  geom() {
    const m = this.host.model();
    const v = m.view;
    const w = Math.max(200, this.canvas.clientWidth);
    return { m, v, w, t0: v.cursor - v.windowSec / 2, win: v.windowSec, K: m.tracks.length };
  }

  xOf(T, g) {
    return ((T - g.t0) / g.win) * g.w;
  }

  tOf(x, g) {
    return g.t0 + (x / g.w) * g.win;
  }

  hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const g = this.geom();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const lane = y < RULER ? null : Math.min(g.K - 1, Math.floor((y - RULER) / LANE));
    return { x, y, T: Math.max(0, Math.min(g.m.timeline.duration, this.tOf(x, g))), lane, g };
  }

  // ------------------------------------------------------------ drawing

  draw() {
    const m = this.host.model();
    if (!m || !m.plan) return;
    const K = m.tracks.length;
    const height = RULER + K * LANE + 4;
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    const w = Math.max(200, c.clientWidth);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(height * dpr);
    }
    c.style.height = `${height}px`;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const g = this.geom();
    const fr = FRAME_RATE;

    // lanes: waveform + words
    m.tracks.forEach((t, k) => {
      const y0 = RULER + k * LANE;
      const wh = LANE - TEXT_H - 6;
      const mid = y0 + 3 + wh / 2;
      ctx.fillStyle = k % 2 ? '#f8fafc' : '#ffffff';
      ctx.fillRect(0, y0, w, LANE);
      if (!this.peaks.has(t.pcm16)) this.peaks.set(t.pcm16, computePeaks(t.pcm16, t.rate));
      const pk = this.peaks.get(t.pcm16);
      const map = m.maps[k];
      const ref = Math.pow(10, (t.vad.speechDb + 4) / 20) * 32768; // speech peaks reach about the lane edge
      const act = t.vad.act;
      const dimmed = this.gains()[k] === 0;
      for (let x = 0; x < w; x++) {
        const fa = (map.a * this.tOf(x, g) + map.b) * fr;
        const fb = (map.a * this.tOf(x + 1, g) + map.b) * fr;
        let f0 = Math.floor(fa);
        const f1 = Math.max(f0 + 1, Math.floor(fb));
        if (f1 <= 0 || f0 >= pk.mn.length) continue;
        f0 = Math.max(0, f0);
        let a = 32767;
        let b = -32768;
        let on = 0;
        for (let f = f0; f < f1 && f < pk.mn.length; f++) {
          if (pk.mn[f] < a) a = pk.mn[f];
          if (pk.mx[f] > b) b = pk.mx[f];
          on |= act[f];
        }
        const ya = Math.max(-1, a / ref) * (wh / 2);
        const yb = Math.min(1, b / ref) * (wh / 2);
        ctx.fillStyle = t.color;
        ctx.globalAlpha = dimmed ? 0.15 : on ? 0.9 : 0.3;
        ctx.fillRect(x, mid - yb, 1, Math.max(1, yb - ya));
      }
      ctx.globalAlpha = 1;
      // the words of this person, in their own row under the waveform
      if (m.transcript) this.drawTextRow(ctx, m, k, y0, w, g);
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(0, y0 + LANE - 1, w, 1);
    });

    // cut bands over every lane
    const lanesH = K * LANE;
    for (const cut of m.plan.cuts) {
      if (cut.endSec < g.t0 || cut.startSec > g.t0 + g.win) continue;
      const xa = this.xOf(cut.startSec, g);
      const xb = this.xOf(cut.endSec, g);
      const selected = this.sel && this.sel.kind === 'cut' && this.sel.cut.key === cut.key;
      if (cut.enabled) {
        ctx.fillStyle = cut.type === 'filler' ? 'rgba(234,88,12,0.30)' : cut.type === 'manual' ? 'rgba(220,38,38,0.22)' : 'rgba(75,85,99,0.30)';
        ctx.fillRect(xa, RULER, xb - xa, lanesH);
        ctx.strokeStyle = cut.type === 'manual' ? 'rgba(185,28,28,0.9)' : 'rgba(55,65,81,0.6)';
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(75,85,99,0.7)';
        ctx.setLineDash([4, 3]);
      }
      ctx.lineWidth = selected ? 2.5 : 1;
      ctx.strokeRect(xa + 0.5, RULER + 0.5, Math.max(1, xb - xa - 1), lanesH - 1);
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      if (xb - xa > 46) {
        ctx.fillStyle = '#1f2937';
        ctx.font = '11px system-ui, sans-serif';
        const label = cut.enabled ? `${{ pause: '間', head: '最初', tail: '最後', filler: 'えー', manual: '手で切った' }[cut.type] || ''} −${(cut.endSec - cut.startSec).toFixed(1)}秒` : '残す';
        ctx.fillText(label, xa + 4, RULER + 13);
      }
    }
    // silenced parts of one lane
    for (const mu of m.plan.mutes || []) {
      const a = mu.start / fr;
      const b = mu.end / fr;
      if (b < g.t0 || a > g.t0 + g.win) continue;
      const xa = this.xOf(a, g);
      const xb = this.xOf(b, g);
      const y0 = RULER + mu.track * LANE;
      const selected = this.sel && this.sel.kind === 'mute' && this.sel.mute === mu;
      ctx.fillStyle = mu.mode === 'manual' ? 'rgba(185,28,28,0.28)' : 'rgba(234,88,12,0.35)';
      ctx.fillRect(xa, y0 + 1, Math.max(2, xb - xa), LANE - 3);
      if (selected) {
        ctx.strokeStyle = '#1d4ed8';
        ctx.lineWidth = 2;
        ctx.strokeRect(xa, y0 + 1, Math.max(2, xb - xa), LANE - 3);
        ctx.lineWidth = 1;
      }
      if (xb - xa > 30) {
        ctx.fillStyle = '#7f1d1d';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText('声を消す', xa + 3, y0 + 13);
      }
    }
    // selection
    if (this.sel && this.sel.kind === 'range') {
      const s = this.sel;
      const xa = this.xOf(s.start, g);
      const xb = this.xOf(s.end, g);
      const y = s.track == null ? RULER : RULER + s.track * LANE;
      const h = s.track == null ? lanesH : LANE;
      ctx.fillStyle = 'rgba(37,99,235,0.18)';
      ctx.fillRect(xa, y, xb - xa, h);
      ctx.strokeStyle = 'rgba(37,99,235,0.9)';
      ctx.strokeRect(xa + 0.5, y + 0.5, Math.max(1, xb - xa - 1), h - 1);
    }
    // ruler
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, w, RULER);
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => (s / g.win) * w >= 70) || 600;
    for (let T = Math.ceil(g.t0 / step) * step; T <= g.t0 + g.win; T += step) {
      const x = this.xOf(T, g);
      ctx.fillRect(x, RULER - 7, 1, 7);
      ctx.fillText(fmtTime(T, step < 1), x + 3, 6);
    }
    ctx.textBaseline = 'alphabetic';
    // playhead
    const xp = this.xOf(this.playhead, g);
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(xp - 1, 0, 2, RULER + lanesH);
    ctx.beginPath();
    ctx.moveTo(xp - 6, 0);
    ctx.lineTo(xp + 6, 0);
    ctx.lineTo(xp, 9);
    ctx.fill();
    this.timeEl.textContent = fmtTime(this.playhead, true);
    this.root.querySelector('[data-a=undo]').disabled = !this.host.canUndo();
    this.root.querySelector('[data-a=redo]').disabled = !this.host.canRedo();
  }

  /** Phrases of one track (units joined at short gaps), cached per transcript. */
  phrasesOf(units) {
    if (!this.phraseCache) this.phraseCache = new WeakMap();
    let ph = this.phraseCache.get(units);
    if (ph) return ph;
    ph = [];
    let cur = null;
    for (const u of units) {
      const brk = !cur || u.start - cur.end > 0.35 || cur.text.length >= 24 || /[。？！?!、]$/.test(cur.text);
      if (brk) {
        if (/^[、。]$/.test(u.text) && cur) { cur.text += u.text; continue; }
        cur = { start: u.start, end: u.end, text: '' };
        ph.push(cur);
      }
      cur.text += u.text;
      cur.end = Math.max(cur.end, Math.min(u.end, u.start + 1.2));
    }
    this.phraseCache.set(units, ph);
    return ph;
  }

  drawTextRow(ctx, m, k, y0, w, g) {
    const map = m.maps[k];
    const top = y0 + LANE - TEXT_H - 2;
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, top, w, TEXT_H);
    const toX = (t) => this.xOf((t - map.b) / map.a, g);
    const tA = map.a * g.t0 + map.b;
    const tB = map.a * (g.t0 + g.win) + map.b;
    // filler candidates behind the words: orange = automatic, purple = to check; a line = cut
    for (const f of m.fillers || []) {
      if (f.track !== k || f.end < tA || f.start > tB) continue;
      const xa = toX(f.textStart ?? f.start);
      const xb = Math.max(xa + 6, toX(f.textEnd ?? f.end));
      const manual = f.sources.includes('manual');
      ctx.fillStyle = manual ? 'rgba(34,197,94,0.35)' : f.cls === 'auto' ? 'rgba(251,146,60,0.40)' : 'rgba(167,139,250,0.40)';
      ctx.fillRect(xa, top + 2, xb - xa, TEXT_H - 4);
      if (this.selFillerId === f.id) {
        ctx.strokeStyle = '#1d4ed8';
        ctx.lineWidth = 2;
        ctx.strokeRect(xa, top + 2, xb - xa, TEXT_H - 4);
        ctx.lineWidth = 1;
      }
    }
    // runs of words: a filler is its own run placed at its own time (inside its highlight),
    // the other words are joined into phrases that flow until the next run starts
    const units = m.transcript.tracks[k].units;
    let lo = 0;
    let hi = units.length;
    while (lo < hi) { const md = (lo + hi) >> 1; if (units[md].end < tA - 8) lo = md + 1; else hi = md; }
    const fl = (m.fillers || []).filter((f) => f.track === k && f.end >= tA - 8 && f.start <= tB + 2);
    const fillerOf = (u) => {
      const mid = (u.start + u.end) / 2;
      return fl.find((f) => mid >= (f.textStart ?? f.start) - 0.02 && mid <= (f.textEnd ?? f.end) + 0.02) || null;
    };
    const runs = [];
    let cur = null;
    for (let i = lo; i < units.length && units[i].start <= tB + 2; i++) {
      const u = units[i];
      const f = fillerOf(u);
      const brk = !cur || cur.filler !== f || (!f && (u.start - cur.end > 0.35 || cur.text.length >= 24 || /[。？！?!、]$/.test(cur.text)));
      if (brk) {
        if (!f && cur && !cur.filler && /^[、。]$/.test(u.text)) { cur.text += u.text; continue; }
        cur = { start: f ? (f.textStart ?? f.start) : u.start, end: u.end, text: '', filler: f };
        runs.push(cur);
      }
      cur.text += u.text;
      cur.end = Math.max(cur.end, Math.min(u.end, u.start + 1.2));
    }
    ctx.font = '14px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const y = top + TEXT_H / 2;
    let lastX = -Infinity;
    const drawn = new Set(); // fillers drawn with their words
    for (let i = 0; i < runs.length; i++) {
      const p = runs[i];
      const x = toX(p.start);
      const next = i + 1 < runs.length ? toX(runs[i + 1].start) : w + 400;
      const dx = p.filler ? Math.max(x, lastX + 1) : Math.max(x, lastX + 6, 0);
      const room = Math.max(next - 2, dx + (p.filler ? 18 : 14)) - dx;
      if (room < 10) continue;
      let text = p.text;
      let tw = ctx.measureText(text).width;
      if (tw > room) {
        let n = text.length;
        while (n > 1 && ctx.measureText(text.slice(0, n) + '…').width > room) n--;
        text = text.slice(0, n) + '…';
        tw = ctx.measureText(text).width;
      }
      if (p.filler) {
        const f = p.filler;
        const manual = f.sources.includes('manual');
        const xb = Math.max(dx + tw, toX(f.textEnd ?? f.end));
        ctx.fillStyle = manual ? 'rgba(34,197,94,0.35)' : f.cls === 'auto' ? 'rgba(251,146,60,0.40)' : 'rgba(167,139,250,0.40)';
        ctx.fillRect(dx - 2, top + 2, xb - dx + 4, TEXT_H - 4);
        if (this.selFillerId === f.id) {
          ctx.strokeStyle = '#1d4ed8';
          ctx.lineWidth = 2;
          ctx.strokeRect(dx - 2, top + 2, xb - dx + 4, TEXT_H - 4);
          ctx.lineWidth = 1;
        }
        drawn.add(f);
      }
      ctx.fillStyle = p.filler ? '#7c2d12' : '#111827';
      ctx.fillText(text, dx, y);
      if (p.filler && p.filler.enabled) {
        ctx.fillStyle = 'rgba(124,45,18,0.85)';
        ctx.fillRect(dx - 1, y - 1, tw + 2, 2);
      }
      lastX = dx + tw;
    }
    ctx.textBaseline = 'alphabetic';
    // cut fillers without words (sounds only): a line through the highlight
    for (const f of m.fillers || []) {
      if (f.track !== k || !f.enabled || f.end < tA || f.start > tB || drawn.has(f)) continue;
      const xa = toX(f.textStart ?? f.start);
      const xb = Math.max(xa + 6, toX(f.textEnd ?? f.end));
      ctx.fillStyle = 'rgba(124,45,18,0.85)';
      ctx.fillRect(xa, y - 1, xb - xa, 2);
    }
  }

  /** Filler candidate under a point of the word row, or null. */
  fillerAt(m, k, T) {
    const map = m.maps[k];
    const t = map.a * T + map.b;
    return (m.fillers || []).find((f) => f.track === k && t >= (f.textStart ?? f.start) - 0.05 && t <= (f.textEnd ?? f.end) + 0.05) || null;
  }

  // ------------------------------------------------------------ selection panel

  updateSelPanel() {
    const m = this.host.model();
    const s = this.sel;
    const btn = (a, label, cls = '') => `<button class="btn tiny ${cls}" data-s="${a}">${label}</button>`;
    this.root.querySelector('.ed-sel').classList.toggle('active', !!s);
    if (!s) {
      this.selInfo.textContent = '切りたい所を、波形の上でなぞって選びます。灰色の帯をクリックすると、詰めるのをやめられます。';
      this.selBtns.innerHTML = '';
      return;
    }
    if (s.kind === 'range') {
      const who = s.track == null ? '全員' : m.tracks[s.track].name;
      this.selInfo.textContent = `${who}の ${(s.end - s.start).toFixed(1)} 秒を選んでいます`;
      this.selBtns.innerHTML =
        btn('playsel', '▶ 聞く') +
        btn('cut', '切って詰める', 'danger') +
        (s.track != null ? btn('mute', `${m.tracks[s.track].name}の声だけ消す`) : '') +
        btn('clear', 'やめる');
      return;
    }
    if (s.kind === 'cut') {
      const c = s.cut;
      const name = { pause: '詰める間', head: '最初の無音', tail: '最後の無音', filler: '切る「えー」', manual: '手で切った所' }[c.type] || '切る所';
      const filler = c.fillerId != null && m.fillers ? m.fillers.find((f) => f.id === c.fillerId) : null;
      this.selInfo.textContent = `${name}${filler ? `「${filler.text}」` : ''}（${(c.endSec - c.startSec).toFixed(1)} 秒）${c.enabled ? '' : '・切らずに残しています'}`;
      this.selBtns.innerHTML = btn('playsel', '▶ 前後を聞く') + (c.enabled ? btn('uncut', '切らずに残す') : btn('recut', 'やっぱり切る')) + btn('clear', '閉じる');
      return;
    }
    if (s.kind === 'mute') {
      const mu = s.mute;
      const filler = mu.fillerId != null && m.fillers ? m.fillers.find((f) => f.id === mu.fillerId) : null;
      this.selInfo.textContent = `${m.tracks[mu.track].name}の声を消している所${filler ? `（「${filler.text}」）` : ''}`;
      this.selBtns.innerHTML = btn('playsel', '▶ 前後を聞く') + btn('unmute', '消さずに残す') + btn('clear', '閉じる');
    }
  }

  setSel(sel) {
    this.sel = sel;
    this.updateSelPanel();
    this.draw();
  }

  /** Keep the selection pointing at the current plan objects after the plan was rebuilt. */
  refresh() {
    const m = this.host.model();
    if (this.sel && this.sel.kind === 'cut') {
      const c = m.plan.cuts.find((x) => x.key === this.sel.cut.key || (x.fillerId != null && x.fillerId === this.sel.cut.fillerId));
      this.sel = c ? { kind: 'cut', cut: c } : null;
    } else if (this.sel && this.sel.kind === 'mute') {
      const o = this.sel.mute;
      const mu = (m.plan.mutes || []).find((x) => x.track === o.track && (x.manualId != null ? x.manualId === o.manualId : x.fillerId === o.fillerId));
      this.sel = mu ? { kind: 'mute', mute: mu } : null;
    }
    this.updateSelPanel();
    this.draw();
  }

  // ------------------------------------------------------------ actions

  action(a) {
    const m = this.host.model();
    const v = m.view;
    const s = this.sel;
    switch (a) {
      case 'play':
        if (this.play) this.stopPlay();
        else this.startPlay();
        break;
      case 'mode-edited':
      case 'mode-raw':
        this.mode = a === 'mode-raw' ? 'raw' : 'edited';
        this.root.querySelectorAll('[data-a^=mode-]').forEach((b) => b.classList.toggle('on', b.dataset.a === a));
        if (this.play) this.startPlay();
        break;
      case 'zoomin':
        this.zoom(0.5, this.playhead);
        break;
      case 'zoomout':
        this.zoom(2, this.playhead);
        break;
      case 'prevcut':
      case 'nextcut': {
        const dir = a === 'nextcut' ? 1 : -1;
        const cuts = m.plan.cuts.filter((c) => c.enabled);
        const ref = this.playhead;
        const t = dir > 0 ? cuts.find((c) => c.startSec > ref + 0.05) : [...cuts].reverse().find((c) => c.endSec < ref - 0.05);
        if (t) {
          this.seek(Math.max(0, t.startSec - 1));
          v.cursor = (t.startSec + t.endSec) / 2;
          this.setSel({ kind: 'cut', cut: t });
          this.host.changedView();
        }
        break;
      }
      case 'undo':
        this.host.undo();
        break;
      case 'redo':
        this.host.redo();
        break;
      case 'clear':
        this.setSel(null);
        break;
      case 'playsel': {
        let a0;
        let b0;
        if (s.kind === 'range') { a0 = s.start; b0 = s.end; }
        else if (s.kind === 'cut') { a0 = s.cut.startSec - 1.5; b0 = s.cut.endSec + 1.5; }
        else { a0 = s.mute.start / FRAME_RATE - 1.5; b0 = s.mute.end / FRAME_RATE + 1.5; }
        this.startPlay(a0, b0, s.kind === 'range' ? 'raw' : null);
        break;
      }
      case 'cut':
        if (s && s.kind === 'range' && s.end - s.start >= 0.02) {
          this.host.cut({ start: s.start, end: s.end });
          this.setSel(null);
        }
        break;
      case 'mute':
        if (s && s.kind === 'range' && s.track != null && s.end - s.start >= 0.02) {
          this.host.mute(s.track, { start: s.start, end: s.end });
          this.setSel(null);
        }
        break;
      case 'uncut':
      case 'recut': {
        const c = s.cut;
        if (c.type === 'filler') this.host.setFiller(c.fillerId, a === 'recut');
        else if (c.type === 'manual') this.host.removeManualCut(c.manualId);
        else this.host.toggleAutoCut(c.key);
        this.refresh();
        break;
      }
      case 'unmute': {
        const mu = s.mute;
        if (mu.mode === 'manual') this.host.removeManualMute(mu.manualId);
        else this.host.setFiller(mu.fillerId, false);
        this.setSel(null);
        break;
      }
      default:
    }
  }

  zoom(factor, around) {
    const v = this.host.model().view;
    const dur = this.host.model().timeline.duration;
    const nw = Math.max(2, Math.min(600, v.windowSec * factor));
    const T = around != null ? around : v.cursor;
    // keep `around` at the same place on screen
    const frac = (T - (v.cursor - v.windowSec / 2)) / v.windowSec;
    v.windowSec = nw;
    v.cursor = Math.max(0, Math.min(dur, T - (frac - 0.5) * nw));
    this.draw();
    this.host.changedView();
  }

  pan(dt) {
    const v = this.host.model().view;
    v.cursor = Math.max(0, Math.min(this.host.model().timeline.duration, v.cursor + dt));
    this.draw();
    this.host.changedView();
  }

  // ------------------------------------------------------------ mouse & keys

  onDown(e) {
    if (e.button !== 0) return;
    this.canvas.focus();
    const h = this.hit(e);
    this.drag = { x0: h.x, T0: h.T, lane: h.lane, moved: false };
    e.preventDefault();
  }

  onMove(e) {
    if (!this.drag) return;
    const h = this.hit(e);
    if (!this.drag.moved && Math.abs(h.x - this.drag.x0) < 4) return;
    this.drag.moved = true;
    const a = Math.min(this.drag.T0, h.T);
    const b = Math.max(this.drag.T0, h.T);
    this.sel = { kind: 'range', track: this.drag.lane, start: a, end: b };
    this.updateSelPanel();
    this.draw();
  }

  onUp(e) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.moved) return;
    // a click: pick a band under the pointer, otherwise move the playhead
    const h = this.hit(e);
    const m = this.host.model();
    if (d.lane != null) {
      const inWords = h.y > RULER + d.lane * LANE + LANE - TEXT_H - 2;
      if (inWords) {
        const f = this.fillerAt(m, d.lane, h.T);
        if (f) {
          this.selFillerId = f.id;
          this.host.selectFiller(f.id);
          this.draw();
          return;
        }
      }
      const fr = FRAME_RATE;
      const mu = (m.plan.mutes || []).find((x) => x.track === d.lane && h.T >= x.start / fr && h.T <= x.end / fr);
      if (mu) { this.setSel({ kind: 'mute', mute: mu }); return; }
      const cut = m.plan.cuts.find((c) => h.T >= c.startSec && h.T <= c.endSec);
      if (cut) { this.setSel({ kind: 'cut', cut }); return; }
    }
    this.setSel(null);
    this.seek(h.T);
  }

  onWheel(e) {
    const h = this.hit(e);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8, h.T);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.pan((d / this.canvas.clientWidth) * h.g.win);
    }
  }

  onKey(e) {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (k === 'z' || k === 'Z') && !e.shiftKey) this.host.undo();
    else if (ctrl && (k === 'y' || k === 'Y' || ((k === 'z' || k === 'Z') && e.shiftKey))) this.host.redo();
    else if (k === ' ') this.action('play');
    else if (k === 'Delete' || k === 'Backspace') this.action(this.sel && this.sel.kind === 'cut' ? 'uncut' : this.sel && this.sel.kind === 'mute' ? 'unmute' : 'cut');
    else if (k === 'm' || k === 'M') this.action('mute');
    else if (k === 'Escape') this.setSel(null);
    else if (k === '+' || k === '=') this.zoom(0.5, this.playhead);
    else if (k === '-') this.zoom(2, this.playhead);
    else if (k === 'ArrowLeft') this.seek(this.playhead - (e.shiftKey ? 0.1 : 1));
    else if (k === 'ArrowRight') this.seek(this.playhead + (e.shiftKey ? 0.1 : 1));
    else if (k === 'Home') this.seek(0);
    else return;
    e.preventDefault();
  }

  // ------------------------------------------------------------ playback

  seek(T) {
    const m = this.host.model();
    this.playhead = Math.max(0, Math.min(m.timeline.duration, T));
    if (this.play) this.startPlay();
    else this.draw();
    this.follow();
  }

  /** Keep the playhead inside the view. */
  follow() {
    const v = this.host.model().view;
    const a = v.cursor - v.windowSec / 2;
    if (this.playhead < a || this.playhead > a + v.windowSec * 0.92) {
      v.cursor = this.playhead + v.windowSec * 0.35;
      this.draw();
      this.host.changedView();
    }
  }

  /** Play from the playhead (or a given range). mode: 'edited' | 'raw' (default: the selector). */
  startPlay(from = null, to = null, modeOverride = null) {
    this.stopPlay(true);
    const m = this.host.model();
    const mode = modeOverride || this.mode;
    const T0 = from != null ? Math.max(0, from) : this.playhead;
    const T1 = to != null ? Math.min(m.timeline.duration, to) : Math.min(m.timeline.duration, T0 + 300);
    if (T1 - T0 < 0.05) return;
    const gains = this.gains();
    const token = {};
    const onEnd = () => { if (this.play && this.play.token === token) this.stopPlay(); };
    let handle;
    let segs = null;
    if (mode === 'raw') {
      handle = playRaw({ tracks: m.tracks, maps: m.maps, T0, T1, gains, onEnd });
    } else {
      handle = playEdited({ tracks: m.tracks, maps: m.maps, gates: m.gates, plan: m.plan, T0, T1, gains, onEnd });
      segs = handle.segs;
    }
    this.play = { token, handle, T0, segs, rate: m.tracks[0].rate };
    this.playBtn.textContent = '■ 停止';
    const tick = () => {
      if (!this.play || this.play.token !== token) return;
      const el = handle.ctx.currentTime - handle.startedAt;
      this.playhead = this.posAt(el);
      this.follow();
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Common-timeline position after `el` seconds of playback. */
  posAt(el) {
    const p = this.play;
    if (!p.segs) return p.T0 + el;
    const o = el * p.rate;
    for (const s of p.segs) if (o < s.outStart + s.len) return s.start + Math.max(0, o - s.outStart) / p.rate;
    const last = p.segs[p.segs.length - 1];
    return last ? last.end : p.T0;
  }

  stopPlay(silent = false) {
    cancelAnimationFrame(this.raf);
    if (this.play && isCurrent(this.play.handle)) stopSnippet();
    this.play = null;
    this.playBtn.textContent = '▶ 再生';
    if (!silent) this.draw();
  }
}

export { HEADER_W };
