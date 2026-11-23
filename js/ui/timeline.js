// Canvas drawing: an overview of the whole episode and a zoomed detail view.

import { FRAME_RATE } from '../core/vad.js';

function setupCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, canvas.clientWidth);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: cssHeight };
}

export function fmtTime(sec, withMs = false) {
  if (!Number.isFinite(sec)) return '--:--';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = withMs ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
  return (neg ? '-' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`);
}

const ROW = 18;

function cutMask(plan) {
  const mask = new Uint8Array(plan.nFrames);
  for (const c of plan.cuts) if (c.enabled) mask.fill(1, c.start, c.end);
  return mask;
}

/**
 * Overview of the whole common timeline.
 * view: { tracks:[{color,name}], actsRef, plan, duration, cursor, playhead, windowSec }
 * The static part (activity and cuts) is cached and only redrawn when the edit changes,
 * so following the playhead during playback stays cheap.
 */
export function drawOverview(canvas, view) {
  const K = view.actsRef.length;
  const height = K * ROW + ROW + 22;
  const { ctx, w } = setupCanvas(canvas, height);
  const dpr = window.devicePixelRatio || 1;
  const key = [w, dpr, K, view.tracks.map((t) => t.color).join()].join('|');
  let cache = canvas._vaCache;
  if (!cache || cache.key !== key || cache.plan !== view.plan || cache.acts !== view.actsRef) {
    const base = document.createElement('canvas');
    base.width = canvas.width;
    base.height = canvas.height;
    const bctx = base.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintOverviewBase(bctx, w, view);
    cache = { key, plan: view.plan, acts: view.actsRef, base };
    canvas._vaCache = cache;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(cache.base, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const dur = view.duration;
  const half = view.windowSec / 2;
  const xa = ((view.cursor - half) / dur) * w;
  const xb = ((view.cursor + half) / dur) * w;
  ctx.strokeStyle = 'rgba(37,99,235,0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.max(0.5, xa), 0.5, Math.max(3, xb - xa), K * ROW + ROW - 2);
  if (Number.isFinite(view.playhead)) {
    const xp = (view.playhead / dur) * w;
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(xp - 0.5, 0, 2, K * ROW + ROW);
  }
}

function paintOverviewBase(ctx, w, view) {
  const K = view.actsRef.length;
  const nFrames = view.plan.nFrames;
  const fpp = nFrames / w;
  const mask = cutMask(view.plan);
  const fmask = new Uint8Array(view.plan.nFrames);
  for (const c of view.plan.cuts) if (c.enabled && c.type === 'filler') fmask.fill(1, c.start, c.end);
  for (const m of view.plan.mutes || []) fmask.fill(1, Math.max(0, m.start), Math.min(fmask.length, m.end));
  for (let k = 0; k < K; k++) {
    const act = view.actsRef[k];
    const y = 4 + k * ROW;
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    ctx.fillRect(0, y, w, ROW - 4);
    ctx.fillStyle = view.tracks[k].color;
    for (let x = 0; x < w; x++) {
      const f0 = Math.floor(x * fpp);
      const f1 = Math.max(f0 + 1, Math.floor((x + 1) * fpp));
      let c = 0;
      for (let f = f0; f < f1 && f < nFrames; f++) c += act[f];
      const d = c / (f1 - f0);
      if (d > 0) {
        ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, d * 1.5);
        ctx.fillRect(x, y, 1, ROW - 4);
      }
    }
    ctx.globalAlpha = 1;
  }
  const yc = 4 + K * ROW;
  ctx.fillStyle = 'rgba(0,0,0,0.04)';
  ctx.fillRect(0, yc, w, ROW - 6);
  ctx.fillStyle = '#6b7280';
  for (let x = 0; x < w; x++) {
    const f0 = Math.floor(x * fpp);
    const f1 = Math.max(f0 + 1, Math.floor((x + 1) * fpp));
    let c = 0;
    let cf = 0;
    for (let f = f0; f < f1 && f < nFrames; f++) { c += mask[f]; cf += fmask[f]; }
    const d = c / (f1 - f0);
    if (cf > 0) {
      ctx.fillStyle = '#ea580c';
      ctx.globalAlpha = 1;
      ctx.fillRect(x, yc + ROW - 9, 1, 3);
      ctx.fillStyle = '#6b7280';
    }
    if (d > 0) {
      ctx.globalAlpha = 0.3 + 0.7 * d;
      ctx.fillRect(x, yc, 1, ROW - 10);
    }
  }
  ctx.globalAlpha = 1;
  const dur = view.duration;
  const step = niceStep(dur / Math.max(1, w / 90));
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= dur; t += step) {
    const x = (t / dur) * w;
    ctx.fillRect(x, yc + ROW - 4, 1, 4);
    ctx.fillText(fmtTime(t), Math.min(x + 2, w - 34), yc + ROW + 1);
  }
}

function niceStep(raw) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) if (s >= raw) return s;
  return 7200;
}

/**
 * Zoomed view around view.cursor: level of each track, detected speech, and cuts.
 * view also needs levelsRef (per-track dB on the common timeline).
 */
export function drawDetail(canvas, view) {
  const K = view.actsRef.length;
  const RH = 46;
  const height = K * RH + 26;
  const { ctx, w } = setupCanvas(canvas, height);
  ctx.clearRect(0, 0, w, height);
  const win = view.windowSec;
  const t0 = view.cursor - win / 2;
  const nFrames = view.plan.nFrames;
  const xOf = (t) => ((t - t0) / win) * w;
  const fpp = (win * FRAME_RATE) / w;

  for (let k = 0; k < K; k++) {
    const y = k * RH + 2;
    const lv = view.levelsRef[k];
    const act = view.actsRef[k];
    ctx.fillStyle = 'rgba(0,0,0,0.035)';
    ctx.fillRect(0, y, w, RH - 6);
    ctx.fillStyle = view.tracks[k].color;
    const base = y + RH - 10;
    for (let x = 0; x < w; x++) {
      const f0 = Math.floor(t0 * FRAME_RATE + x * fpp);
      const f1 = Math.max(f0 + 1, Math.floor(t0 * FRAME_RATE + (x + 1) * fpp));
      let mx = -120;
      let a = 0;
      for (let f = f0; f < f1; f++) {
        if (f < 0 || f >= nFrames) continue;
        if (lv[f] > mx) mx = lv[f];
        a |= act[f];
      }
      const hgt = Math.max(0, Math.min(1, (mx + 70) / 60)) * (RH - 16);
      ctx.globalAlpha = a ? 0.85 : 0.3;
      ctx.fillRect(x, base - hgt, 1, hgt);
      if (a) {
        ctx.globalAlpha = 1;
        ctx.fillRect(x, base + 2, 1, 3);
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#111827';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(view.tracks[k].name, 4, y + 2);
  }

  // cuts
  ctx.font = '11px system-ui, sans-serif';
  for (const c of view.plan.cuts) {
    if (!c.enabled || c.endSec < t0 || c.startSec > t0 + win) continue;
    const xa = xOf(c.startSec);
    const xb = xOf(c.endSec);
    ctx.fillStyle = c.type === 'filler' ? 'rgba(234,88,12,0.28)' : 'rgba(107,114,128,0.28)';
    ctx.fillRect(xa, 0, xb - xa, K * RH);
    ctx.strokeStyle = 'rgba(75,85,99,0.8)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xa + 0.5, 0);
    ctx.lineTo(xa + 0.5, K * RH);
    ctx.moveTo(xb - 0.5, 0);
    ctx.lineTo(xb - 0.5, K * RH);
    ctx.stroke();
    ctx.setLineDash([]);
    if (xb - xa > 34) {
      ctx.fillStyle = '#374151';
      ctx.fillText(`−${(c.endSec - c.startSec).toFixed(1)}s`, xa + 4, K * RH - 14);
    }
  }

  // fillers silenced on one track only (someone else was speaking)
  for (const m of view.plan.mutes || []) {
    if (m.mode !== 'mute') continue;
    const a = m.start / FRAME_RATE;
    const b = m.end / FRAME_RATE;
    if (b < t0 || a > t0 + win) continue;
    const y = m.track * RH + 2;
    ctx.fillStyle = 'rgba(234,88,12,0.35)';
    ctx.fillRect(xOf(a), y, Math.max(2, xOf(b) - xOf(a)), RH - 6);
  }

  // ticks
  const yt = K * RH + 4;
  ctx.fillStyle = '#6b7280';
  const step = win > 30 ? 5 : win > 12 ? 2 : 1;
  for (let t = Math.ceil(t0 / step) * step; t <= t0 + win; t += step) {
    const x = xOf(t);
    ctx.fillRect(x, yt - 4, 1, 4);
    ctx.fillText(fmtTime(t), x + 2, yt);
  }
  // cursor & playhead
  ctx.fillStyle = 'rgba(37,99,235,0.9)';
  ctx.fillRect(xOf(view.cursor) - 0.5, 0, 1, K * RH);
  if (Number.isFinite(view.playhead)) {
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(xOf(view.playhead) - 1, 0, 2, K * RH);
  }
}

/** Convert a click on a canvas to a time on the common timeline. */
export function overviewTimeAt(canvas, evt, duration) {
  const r = canvas.getBoundingClientRect();
  return Math.max(0, Math.min(duration, ((evt.clientX - r.left) / r.width) * duration));
}

export function detailTimeAt(canvas, evt, view) {
  const r = canvas.getBoundingClientRect();
  const t0 = view.cursor - view.windowSec / 2;
  return t0 + ((evt.clientX - r.left) / r.width) * view.windowSec;
}
