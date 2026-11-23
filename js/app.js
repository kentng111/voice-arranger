// Voice Arranger — UI controller.

import { decodeToMono, toInt16 } from './io/decode.js';
import { frameLevels, detectSpeech } from './core/vad.js';
import { solveSync, mapFromStart, startOfMap } from './core/sync.js';
import { makeTimeline, makePlan, makeGates } from './core/session.js';
import { levelsOnTimeline, refToOut, outToRef, DEFAULT_SETTINGS } from './core/plan.js';
import { yieldToUI } from './core/render.js';
import { buildPreview } from './preview.js';
import { exportProject } from './export.js';
import { folderPickerAvailable, pickFolderSink, downloadSink } from './io/output.js';
import { drawOverview, fmtTime, overviewTimeAt } from './ui/timeline.js';
import { TrackEditor } from './ui/editor.js';
import { ASR_MODELS, modelByKey, detectAccel } from './asr/models.js';
import { WhisperEngine, transcribeTracks, detectFillers, isModelCached } from './transcribe.js';
import { gatesWithMutes } from './core/gate.js';
import { buildRows, renderRows, updateMarks, filterRows, markNowRow } from './ui/transcript-view.js';
import { evaluateVerdicts } from './core/evaluate.js';
import { manualFillerAt } from './core/filler.js';
import { playRaw, playEdited, stopSnippet, isCurrent, focusGains } from './ui/snippet.js';

const ANALYSIS_RATE = 16000;
const MAX_TRACKS = 6;
const COLORS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777'];
const $ = (id) => document.getElementById(id);

const state = {
  tracks: [],
  nextId: 1,
  analyzed: false,
  sync: null,
  maps: null,
  timeline: null,
  levelsRef: null,
  gates: null,
  plan: null,
  settings: { ...DEFAULT_SETTINGS, gateDb: -15, targetLufs: -16 },
  view: { cursor: 0, windowSec: 16, playhead: NaN },
  preview: null,
  version: 0,
  busy: false,
  transcript: null, // common format (js/core/transcript.js), times in each track's own file
  fillers: null, // [{ id, track, start, end, text, cls, sources, score, enabled }]
  asr: { engine: null, accel: null, cancel: false },
  marks: null,
  selFiller: null,
  // hand edits from the track editor (seconds on the common timeline)
  edits: { cuts: [], mutes: [], disabled: [] },
  undo: [],
  redo: [],
  editor: null,
};

// ---------------------------------------------------------------- helpers

function log(msg) {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
  console.log('[VoiceArranger]', msg);
}

function setProgress(id, frac, text) {
  const el = $(id);
  el.hidden = false;
  el.querySelector('i').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  if (text != null) el.querySelector('.text').textContent = text;
}

function hideProgress(id) {
  $(id).hidden = true;
}

function setBusy(b) {
  state.busy = b;
  updateButtons();
}

function updateButtons() {
  const n = state.tracks.length;
  $('analyzeBtn').disabled = state.busy || n < 2;
  $('analyzeHint').textContent = n === 0 ? '' : n < 2 ? 'あと1人分以上のファイルを入れてください' : '';
  $('analyzeBtn').textContent = state.analyzed ? '次へ →' : '自動で整える →';
  $('previewBtn').disabled = state.busy || !state.analyzed;
  const anyOut = $('exportStems').checked || $('exportMix').checked;
  $('exportBtn').disabled = state.busy || !state.analyzed || !anyOut;
  $('resyncBtn').disabled = state.busy;
  $('resetSyncBtn').disabled = state.busy;
  $('asrBtn').disabled = state.busy || !state.analyzed;
  $('asrModel').disabled = state.busy;
  $('exportTranscript').disabled = !state.transcript;
  if (!state.transcript) $('exportTranscript').checked = false;
  updateStepper();
  updateFillerChoice();
}

function confLabel(c) {
  if (c >= 0.35) return ['高', 'high'];
  if (c >= 0.12) return ['中', 'mid'];
  return ['低', 'low'];
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- steps

const STEPS = ['stepLoad', 'stepReview', 'stepTranscript', 'stepExport'];
let curStep = 0;

function showStep(i) {
  if (i > 0 && !state.analyzed) return;
  if (i !== curStep) {
    // leaving a step stops what was playing there
    if (state.editor) state.editor.stopPlay();
    stopEvalPlay();
    stopSnippet();
  }
  curStep = i;
  STEPS.forEach((id, k) => { $(id).hidden = k !== i; });
  updateStepper();
  if (i === 1) scheduleDraw(); // the canvases need their width, which they only have when shown
  window.scrollTo({ top: 0 });
}

function updateStepper() {
  document.querySelectorAll('#stepper [data-step]').forEach((b) => {
    const k = parseInt(b.dataset.step, 10);
    b.classList.toggle('cur', k === curStep);
    b.classList.toggle('done', k < curStep);
    b.disabled = k > 0 && !state.analyzed;
  });
}

// ---------------------------------------------------------------- browser check

function checkEnvironment() {
  const warn = [];
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const chromium = brands.some((b) => /Chromium/i.test(b.brand));
  if (!chromium) warn.push('このツールは Chrome または Edge（Mac・Windows）での利用を前提にしています。ほかのブラウザでは読み込みや保存がうまくいかないことがあります。');
  if (!window.isSecureContext) warn.push('安全な接続（https または localhost）で開いていないため、一部の機能が使えません。');
  if (warn.length) {
    $('browserWarning').hidden = false;
    $('browserWarning').innerHTML = warn.map((w) => `<div>${w}</div>`).join('');
  }
  $('exportHint').textContent = folderPickerAvailable()
    ? '選んだフォルダにまとめて保存します。'
    : '書き出しのあとに表示されるリンクから保存します（Chrome / Edge なら保存先フォルダを選べます）。';
  if (!folderPickerAvailable()) $('exportBtn').textContent = '書き出す';
}

// ---------------------------------------------------------------- tracks

function isAudioFile(f) {
  return /^audio\//.test(f.type) || /\.(m4a|mp3|wav|aac|flac|caf|ogg|opus|aif|aiff)$/i.test(f.name);
}

function addFiles(fileList) {
  const files = [...fileList].filter(isAudioFile);
  const skipped = [...fileList].length - files.length;
  for (const f of files) {
    if (state.tracks.length >= MAX_TRACKS) break;
    const id = state.nextId++;
    state.tracks.push({ id, file: f, name: `話者${state.tracks.length + 1}`, color: COLORS[(id - 1) % COLORS.length], sensitivity: 0 });
  }
  if (skipped) log(`音声ではないファイルを ${skipped} 件スキップしました`);
  invalidateAnalysis();
  renderTrackList();
}

function removeTrack(id) {
  state.tracks = state.tracks.filter((t) => t.id !== id);
  invalidateAnalysis();
  renderTrackList();
}

function invalidateAnalysis() {
  if (!state.analyzed) {
    updateButtons();
    return;
  }
  state.analyzed = false;
  state.sync = state.maps = state.timeline = state.levelsRef = state.gates = state.plan = null;
  state.edits = { cuts: [], mutes: [], disabled: [] };
  state.undo = [];
  state.redo = [];
  if (state.editor) { state.editor.stopPlay(); state.editor.setSel(null); }
  clearTranscript();
  clearPreview();
  showStep(0);
  updateButtons();
}

function renderTrackList() {
  const ul = $('trackList');
  ul.innerHTML = '';
  state.tracks.forEach((t) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="dot" style="background:${t.color}"></span>
      <input type="text" value="" aria-label="話者の名前" title="名前を変えられます">
      <span class="file"></span>
      <span class="dur">${t.duration ? fmtTime(t.duration) : ''}</span>
      <button class="btn link" title="このファイルを外す">✕ 外す</button>`;
    const inp = li.querySelector('input');
    inp.value = t.name;
    inp.addEventListener('input', () => {
      t.name = inp.value.trim() || t.name;
      if (state.analyzed) {
        renderSyncTable();
        state.editor.setTracks();
        scheduleDraw();
      }
    });
    li.querySelector('.file').textContent = t.file.name;
    li.querySelector('.file').title = t.file.name;
    li.querySelector('button').addEventListener('click', () => removeTrack(t.id));
    ul.appendChild(li);
  });
  updateButtons();
}

// ---------------------------------------------------------------- analysis

async function analyze() {
  if (state.busy || state.tracks.length < 2) return;
  if (state.analyzed) {
    showStep(1);
    return;
  }
  setBusy(true);
  $('analyzeError').hidden = true;
  const K = state.tracks.length;
  try {
    for (let k = 0; k < K; k++) {
      const t = state.tracks[k];
      if (t.pcm16 && t.decodedFile === t.file) continue;
      setProgress('analyzeProgress', k / (K + 1), `${t.name}（${t.file.name}）を読み込み中…`);
      await yieldToUI();
      const t0 = performance.now();
      const dec = await decodeToMono(t.file, ANALYSIS_RATE);
      t.levels = frameLevels(dec.data, ANALYSIS_RATE);
      t.pcm16 = toInt16(dec.data);
      t.rate = ANALYSIS_RATE;
      t.duration = dec.duration;
      t.decodedFile = t.file;
      log(`${t.name}: ${t.file.name}  長さ ${fmtTime(t.duration)}  ${dec.channels}ch  (${Math.round(performance.now() - t0)} ms)`);
    }
    renderTrackList();
    setProgress('analyzeProgress', K / (K + 1), '声の区間を検出して、タイミングを合わせています…');
    await yieldToUI();
    for (const t of state.tracks) t.vad = detectSpeech(t.levels, { sensitivity: t.sensitivity });
    for (const t of state.tracks) log(`${t.name}: 話している割合 ${(t.vad.activeRatio * 100).toFixed(0)}%  雑音 ${t.vad.noiseDb.toFixed(0)} dB`);
    autoSync();
    syncWarned = false;
    state.analyzed = true;
    if (!$('baseName').value) $('baseName').value = `podcast_${todayStamp()}`;
    rebuildTimeline();
    renderSyncTable();
    showStep(1);
    state.editor.setTracks();
    refreshAsrInfo();
    checkRestore();
    hideProgress('analyzeProgress');
    state.view.cursor = firstInterestingTime();
    state.editor.playhead = Math.max(0, state.view.cursor - 3);
    scheduleDraw();
  } catch (e) {
    console.error(e);
    hideProgress('analyzeProgress');
    const box = $('analyzeError');
    box.hidden = false;
    box.textContent = `${e.message}${e.hint ? ' ' + e.hint : ''}`;
    log(`エラー: ${e.message} ${e.cause ? '(' + e.cause.message + ')' : ''}`);
  } finally {
    setBusy(false);
  }
}

function autoSync() {
  const t0 = performance.now();
  state.sync = solveSync(state.tracks.map((t) => t.vad.core));
  state.maps = state.sync.maps.map((m) => ({ ...m }));
  log(`同期の計算 ${Math.round(performance.now() - t0)} ms`);
  for (const p of state.sync.pairs) {
    const a = state.tracks[p.i].name;
    const b = state.tracks[p.j].name;
    log(`  ${a} → ${b}: ${p.lagSec == null ? '不明' : p.lagSec.toFixed(2) + ' 秒'}  確度 ${p.confidence.toFixed(2)}${p.rejected ? '（ほかの組と矛盾するため不採用）' : ''}`);
  }
  for (const u of state.sync.unionRefs || []) {
    const others = u.others.map((j) => state.tracks[j].name).join('・');
    log(`  ${state.tracks[u.track].name}: ${others} の会話とまとめて照合 → 確度 ${u.confidence.toFixed(2)}（受け答え ${u.turns} 回）`);
  }
  state.tracks.forEach((t, k) => {
    if (state.sync.driftPpm[k]) log(`  ${t.name}: 時計のズレ ${state.sync.driftPpm[k].toFixed(0)} ppm を補正`);
  });
}

function firstInterestingTime() {
  const c = state.plan.cuts.find((x) => x.type === 'pause' && x.enabled);
  return c ? (c.startSec + c.endSec) / 2 : state.view.windowSec / 2;
}

// ---------------------------------------------------------------- rebuilding

function rebuildTimeline() {
  const vads = state.tracks.map((t) => t.vad);
  state.timeline = makeTimeline(state.tracks, vads, state.maps);
  state.levelsRef = state.tracks.map((t, k) => levelsOnTimeline(t.levels, state.maps[k], state.timeline.nFrames));
  rebuildGates(false);
  rebuildPlan();
}

function rebuildGates(bump = true) {
  state.gates = makeGates(state.timeline, state.settings.gateDb);
  if (bump) changed();
}

function rebuildPlan() {
  state.plan = makePlan(state.timeline, state.settings, state.maps, {
    fillers: state.fillers || [],
    manualCuts: state.edits.cuts,
    manualMutes: state.edits.mutes,
    disabledCuts: state.edits.disabled,
  });
  state.view.cursor = Math.max(0, Math.min(state.timeline.duration, state.view.cursor));
  renderSummary();
  if (state.fillers) {
    renderFillerSummary();
    if (state.marks) updateMarks(state.marks, state.fillers, state.plan, state.selFiller);
  }
  if (state.editor) state.editor.refresh();
  changed();
}

/** Gates with the adopted fillers silenced, for a given plan. */
function gatesFor(plan) {
  return gatesWithMutes(state.gates, plan.mutes);
}

function changed() {
  state.version++;
  if (state.preview) $('previewStale').hidden = state.preview.version === state.version;
  scheduleDraw();
}

let planQueued = false;
function queuePlan() {
  if (planQueued) return;
  planQueued = true;
  requestAnimationFrame(() => {
    planQueued = false;
    rebuildPlan();
  });
}

// ---------------------------------------------------------------- review UI

function renderSummary() {
  const p = state.plan;
  const saved = p.inputDuration - p.outputDuration;
  const items = [
    ['元の長さ', fmtTime(p.inputDuration)],
    ['編集後の長さ', fmtTime(p.outputDuration)],
    ['短くなった', `−${fmtTime(saved)}（${p.inputDuration ? ((saved / p.inputDuration) * 100).toFixed(0) : 0}%）`],
  ];
  const parts = [
    `間 ${p.counts.pause} か所`,
    state.fillers ? `「えー」など ${p.counts.filler + p.counts.mute} か所` : '',
    p.counts.manual || p.counts.manualMute ? `手で切った所 ${p.counts.manual + p.counts.manualMute} か所` : '',
    p.removed.head + p.removed.tail > 0.05 ? `最初と最後の無音 ${(p.removed.head + p.removed.tail).toFixed(1)} 秒` : '',
  ].filter(Boolean);
  $('summary').innerHTML =
    items.map(([k, v]) => `<div class="item"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') +
    `<div class="item parts"><span class="k">詰めた所</span><span class="hint">${parts.join('・')}</span></div>`;
}

function relStarts(maps) {
  const s = maps.map(startOfMap);
  const m = Math.min(...s);
  return s.map((v) => v - m);
}

function currentStarts() {
  return state.maps.map(startOfMap);
}

function setStarts(starts) {
  const shift = Math.min(...starts);
  state.maps = starts.map((s, k) => mapFromStart(s - shift, (1 - state.maps[k].a) * 1e6));
  rebuildTimeline();
  renderSyncTable();
}

function renderSyncTable() {
  const tb = $('syncRows');
  tb.innerHTML = '';
  const starts = currentStarts();
  state.tracks.forEach((t, k) => {
    const tr = document.createElement('tr');
    const drift = (1 - state.maps[k].a) * 1e6;
    const conf = state.sync ? state.sync.confidence[k] : 0;
    const [cl, cc] = confLabel(conf);
    const manual = state.sync && Math.abs(relStarts(state.maps)[k] - relStarts(state.sync.maps)[k]) > 0.0005;
    const pairInfo = state.sync
      ? state.sync.pairs
          .filter((p) => p.i === k || p.j === k)
          .map((p) => `${state.tracks[p.i === k ? p.j : p.i].name}との確度 ${p.confidence.toFixed(2)}${p.rejected ? '（不採用）' : ''}`)
          .join(' / ')
      : '';
    tr.innerHTML = `
      <td><span class="name"><span class="dot" style="background:${t.color}"></span><span class="nm"></span></span></td>
      <td><input type="number" step="0.01" value="${starts[k].toFixed(2)}"> 秒</td>
      <td><span class="nudge">
        <button class="btn tiny" data-d="-0.1">−0.1</button><button class="btn tiny" data-d="-0.01">−0.01</button>
        <button class="btn tiny" data-d="0.01">+0.01</button><button class="btn tiny" data-d="0.1">+0.1</button></span></td>
      <td><span class="conf ${cc}" title="${pairInfo}">${cl}</span>${manual ? '　<span class="hint">手で調整済み</span>' : ''}</td>
      <td><span class="sens"><input type="range" min="-12" max="12" step="1" value="${t.sensitivity}" title="声が拾えていない人は右へ、ほかの人の声まで拾う人は左へ"><output>${t.sensitivity > 0 ? '+' : ''}${t.sensitivity}</output></span></td>
      <td class="hint">${drift ? `${drift > 0 ? '+' : ''}${drift.toFixed(0)} ppm を補正` : 'なし'}</td>`;
    tr.querySelector('.nm').textContent = t.name;
    const num = tr.querySelector('input[type=number]');
    num.addEventListener('change', () => {
      const v = parseFloat(num.value);
      if (!Number.isFinite(v)) return;
      const s = currentStarts();
      s[k] = v;
      setStarts(s);
    });
    tr.querySelectorAll('[data-d]').forEach((b) =>
      b.addEventListener('click', () => {
        const s = currentStarts();
        s[k] += parseFloat(b.dataset.d);
        setStarts(s);
      }),
    );
    const sens = tr.querySelector('input[type=range]');
    sens.addEventListener('input', () => {
      tr.querySelector('output').textContent = `${sens.value > 0 ? '+' : ''}${sens.value}`;
    });
    sens.addEventListener('change', () => {
      t.sensitivity = parseInt(sens.value, 10);
      t.vad = detectSpeech(t.levels, { sensitivity: t.sensitivity });
      log(`${t.name}: 感度 ${t.sensitivity} → 話している割合 ${(t.vad.activeRatio * 100).toFixed(0)}%`);
      // the speech areas changed, so match the timing again
      autoSync();
      rebuildTimeline();
      renderSyncTable();
    });
    tb.appendChild(tr);
  });
  renderSyncStatus();
}

/** Short status of the automatic timing; opens the panel by itself when someone may be off. */
let syncWarned = false;
function renderSyncStatus() {
  const el = $('syncStatus');
  if (!state.sync) { el.textContent = ''; return; }
  const low = state.tracks.filter((t, k) => state.sync.confidence[k] < 0.12).map((t) => t.name);
  el.className = `badge ${low.length ? 'low' : 'ok'}`;
  el.textContent = low.length ? `${low.join('・')} がずれているかもしれません` : '自動で合わせました';
  if (low.length && !syncWarned) {
    syncWarned = true;
    $('syncBox').open = true;
  }
}

// ---------------------------------------------------------------- timeline drawing

let drawQueued = false;
function scheduleDraw() {
  if (drawQueued || !state.analyzed) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function viewModel() {
  return {
    tracks: state.tracks,
    actsRef: state.timeline.actsRef,
    levelsRef: state.levelsRef,
    plan: state.plan,
    duration: state.timeline.duration,
    cursor: state.view.cursor,
    windowSec: state.view.windowSec,
    playhead: state.view.playhead,
  };
}

function draw() {
  if (!state.analyzed || !state.plan) return;
  const vm = viewModel();
  drawOverview($('overview'), vm);
  if (state.editor) state.editor.draw();
  const c = state.editor ? state.editor.playhead : state.view.cursor;
  $('cursorInfo').textContent = `　赤い線＝編集後の ${fmtTime(refToOut(state.plan, c))}`;
}

function setCursor(T, seek) {
  state.view.cursor = Math.max(0, Math.min(state.timeline.duration, T));
  if (seek && state.preview) {
    const p = $('player');
    p.currentTime = refToOut(state.preview.plan, state.view.cursor);
    state.view.playhead = state.view.cursor;
  }
  scheduleDraw();
}

// ---------------------------------------------------------------- track editor & hand edits

function editState() {
  return JSON.stringify({ edits: state.edits, fillersOn: state.fillers ? state.fillers.filter((f) => f.enabled).map((f) => f.id) : null });
}

/** Remember the current edits so the next change can be undone. */
function pushUndo() {
  state.undo.push(editState());
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
}

function applyEditState(json) {
  const d = JSON.parse(json);
  state.edits = d.edits;
  if (state.fillers && d.fillersOn) {
    const on = new Set(d.fillersOn);
    for (const f of state.fillers) f.enabled = on.has(f.id);
    if (state.marks) updateMarks(state.marks, state.fillers, state.plan, state.selFiller);
  }
  rebuildPlan();
  scheduleSave();
}

let editSeq = 1;
const editId = () => `e${Date.now().toString(36)}${editSeq++}`;

const editorHost = {
  model: () =>
    state.analyzed && state.plan
      ? {
          tracks: state.tracks,
          maps: state.maps,
          timeline: state.timeline,
          plan: state.plan,
          get gates() { return gatesFor(state.plan); }, // only built when playing
          transcript: state.transcript,
          fillers: state.fillers,
          view: state.view,
        }
      : null,
  cut(r) {
    pushUndo();
    state.edits.cuts.push({ id: editId(), start: r.start, end: r.end });
    log(`手動でカット: ${fmtTime(r.start, true)}〜${fmtTime(r.end, true)}`);
    rebuildPlan();
    scheduleSave();
  },
  mute(track, r) {
    pushUndo();
    state.edits.mutes.push({ id: editId(), track, start: r.start, end: r.end });
    log(`手動で消音: ${state.tracks[track].name} ${fmtTime(r.start, true)}〜${fmtTime(r.end, true)}`);
    rebuildPlan();
    scheduleSave();
  },
  toggleAutoCut(key) {
    pushUndo();
    const d = state.edits.disabled;
    const i = d.indexOf(key);
    if (i >= 0) d.splice(i, 1);
    else d.push(key);
    rebuildPlan();
    scheduleSave();
  },
  removeManualCut(id) {
    pushUndo();
    state.edits.cuts = state.edits.cuts.filter((c) => c.id !== id);
    rebuildPlan();
    scheduleSave();
  },
  removeManualMute(id) {
    pushUndo();
    state.edits.mutes = state.edits.mutes.filter((m) => m.id !== id);
    rebuildPlan();
    scheduleSave();
  },
  setFiller(id, on) {
    toggleFiller(id, on);
  },
  selectFiller(id) {
    // also select it in the transcript list (and play the surroundings)
    selectFiller(id, true);
  },
  undo() {
    if (!state.undo.length) return;
    state.redo.push(editState());
    applyEditState(state.undo.pop());
  },
  redo() {
    if (!state.redo.length) return;
    state.undo.push(editState());
    applyEditState(state.redo.pop());
  },
  canUndo: () => state.undo.length > 0,
  canRedo: () => state.redo.length > 0,
  changedView: () => scheduleDraw(),
};

// ---------------------------------------------------------------- preview

function clearPreview() {
  const p = $('player');
  p.pause();
  if (state.preview) URL.revokeObjectURL(state.preview.url);
  state.preview = null;
  p.removeAttribute('src');
  p.hidden = true;
  $('previewStale').hidden = true;
  state.view.playhead = NaN;
}

async function makePreview() {
  if (state.busy || !state.analyzed) return;
  setBusy(true);
  const mode = $('previewMode').value;
  try {
    const plan = mode === 'edited' ? state.plan : makePlan(state.timeline, state.settings, state.maps, { noCuts: true });
    const version = state.version;
    const t0 = performance.now();
    const res = await buildPreview({
      tracks: state.tracks.map((t) => ({ pcm16: t.pcm16, rate: t.rate })),
      maps: state.maps,
      gates: gatesFor(plan),
      plan,
      targetLufs: state.settings.targetLufs,
      onProgress: (f) => setProgress('previewProgress', f, 'プレビューを作成中…'),
    });
    clearPreview();
    state.preview = { url: URL.createObjectURL(res.blob), plan, mode, version };
    const p = $('player');
    p.src = state.preview.url;
    p.hidden = false;
    p.addEventListener('loadedmetadata', () => { p.currentTime = refToOut(plan, state.view.cursor); }, { once: true });
    $('previewStale').hidden = version === state.version;
    log(`プレビュー（${mode === 'edited' ? '編集後' : '同期のみ'}）${fmtTime(res.duration)}  ${Math.round(performance.now() - t0)} ms`);
    hideProgress('previewProgress');
  } catch (e) {
    console.error(e);
    log(`プレビュー作成エラー: ${e.message}`);
    setProgress('previewProgress', 0, `エラー: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

let playLoop = 0;
function followPlayback() {
  const p = $('player');
  if (!state.preview) return;
  const T = outToRef(state.preview.plan, p.currentTime);
  state.view.playhead = T;
  const half = state.view.windowSec / 2;
  if (Math.abs(T - state.view.cursor) > half * 0.8) state.view.cursor = T + half * 0.6;
  draw();
  if (!p.paused) playLoop = requestAnimationFrame(followPlayback);
}

// ---------------------------------------------------------------- export

async function doExport() {
  if (state.busy || !state.analyzed) return;
  let sink;
  if (folderPickerAvailable()) {
    try {
      sink = await pickFolderSink();
    } catch (e) {
      log(`フォルダを開けませんでした: ${e.message}`);
      sink = null;
    }
    if (!sink) return;
  } else {
    sink = downloadSink();
  }
  setBusy(true);
  $('exportResult').innerHTML = '';
  const t0 = performance.now();
  try {
    const settings = {
      ...state.settings,
      bitDepth: parseInt($('bitDepth').value, 10),
      exportStems: $('exportStems').checked,
      exportMix: $('exportMix').checked,
      exportTranscript: $('exportTranscript').checked && !!state.transcript,
    };
    const report = await exportProject({
      tracks: state.tracks.map((t) => ({ file: t.file, name: t.name })),
      maps: state.maps,
      gates: gatesFor(state.plan),
      plan: state.plan,
      transcript: state.transcript,
      fillers: state.fillers,
      evalRanges: hasVerdicts() ? evalRangesTrack() : null,
      evalRangeRef: hasVerdicts() ? evalRangeRef() : null,
      settings,
      sink,
      baseName: $('baseName').value || `podcast_${todayStamp()}`,
      onProgress: (f, text) => setProgress('exportProgress', f, text),
      log,
    });
    const secs = Math.round((performance.now() - t0) / 1000);
    log(`書き出し完了（${secs} 秒）`);
    showExportResult(sink, report, secs);
    hideProgress('exportProgress');
    window.__vaLastReport = report;
  } catch (e) {
    console.error(e);
    log(`書き出しエラー: ${e.message}`);
    setProgress('exportProgress', 0, `エラー: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

let downloadUrls = [];
function showExportResult(sink, report, secs) {
  downloadUrls.forEach((u) => URL.revokeObjectURL(u));
  downloadUrls = [];
  const res = $('exportResult');
  res.innerHTML = `<p class="done">書き出しました（${secs} 秒）。${sink.kind === 'folder' ? sink.label + 'に保存しました。' : sink.label}</p><ul></ul>`;
  const ul = res.querySelector('ul');
  if (sink.kind === 'download') {
    for (const f of sink.files) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f.blob);
      a.download = f.name;
      a.textContent = f.name;
      downloadUrls.push(a.href);
      li.append(a, ` （${(f.blob.size / 1e6).toFixed(1)} MB）`);
      ul.appendChild(li);
    }
    const all = document.createElement('button');
    all.className = 'btn';
    all.textContent = 'すべて保存';
    all.addEventListener('click', async () => {
      for (const a of ul.querySelectorAll('a')) {
        a.click();
        await new Promise((r) => setTimeout(r, 400));
      }
    });
    res.appendChild(all);
  } else {
    for (const f of report.files) {
      const li = document.createElement('li');
      li.textContent = f;
      ul.appendChild(li);
    }
  }
}

// ---------------------------------------------------------------- transcription & fillers

function clearTranscript() {
  if (state.asr.engine) state.asr.engine.terminate();
  state.asr.engine = null;
  state.transcript = null;
  state.fillers = null;
  state.marks = null;
  state.selFiller = null;
  stopEvalPlay();
  stopSnippet();
  $('fillerPanel').hidden = true;
  $('transcriptView').innerHTML = '';
}

async function refreshAsrInfo() {
  if (!state.asr.accel) state.asr.accel = await detectAccel();
  const sel = $('asrModel');
  const accel = state.asr.accel.kind;
  const prev = sel.value || (accel === 'wasm' ? 'base' : 'small');
  sel.innerHTML = '';
  for (const m of ASR_MODELS) {
    const v = m.variants[accel];
    const cached = await isModelCached(m.id);
    const o = document.createElement('option');
    o.value = m.key;
    o.textContent = `${m.label}${cached ? '（ダウンロード済み）' : `（初回 約${v.sizeMB}MB）`}`;
    sel.appendChild(o);
  }
  sel.value = prev;
  $('asrInfo').textContent = `${state.asr.accel.note}。文字起こしはこのPCの中で行い、音声は外に送りません。モデルは初回だけ Hugging Face からダウンロードして、ブラウザに保存します。`;
  refreshAsrNote();
}

async function refreshAsrNote() {
  const m = modelByKey($('asrModel').value);
  if (!m || !state.asr.accel) return;
  const cached = await isModelCached(m.id);
  $('asrNote').textContent = state.transcript
    ? '文字起こしは済んでいます。'
    : cached
      ? ''
      : `初回だけ、約${m.variants[state.asr.accel.kind].sizeMB}MB のダウンロードがあります。`;
  $('asrBtn').textContent = state.transcript ? '文字起こしをやり直す' : '文字起こしを始める';
  $('asrBtn').classList.toggle('primary', !state.transcript);
}

async function runTranscription() {
  if (state.busy || !state.analyzed) return;
  const m = modelByKey($('asrModel').value);
  const accel = state.asr.accel ? state.asr.accel.kind : 'wasm';
  const cached = await isModelCached(m.id);
  if (!cached) {
    const ok = confirm(`文字起こしのモデル「${m.label}」を Hugging Face からダウンロードします（約${m.variants[accel].sizeMB}MB、初回のみ）。\n音声は送信されません。続けますか？`);
    if (!ok) return;
  }
  setBusy(true);
  state.asr.cancel = false;
  $('asrCancel').hidden = false;
  $('asrError').hidden = true;
  try {
    const key = `${m.key}|${accel}`;
    const loadEngine = async (reason) => {
      if (state.asr.engine) state.asr.engine.terminate();
      state.asr.engine = new WhisperEngine();
      setProgress('asrProgress', 0, reason || (cached ? 'モデルを読み込み中…' : 'モデルをダウンロード中…'));
      const t0 = performance.now();
      await state.asr.engine.load(m.key, accel, (f, l, t) =>
        setProgress('asrProgress', f * 0.98, `${reason || 'モデルをダウンロード中…'} ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`),
      );
      setProgress('asrProgress', 1, 'モデルの準備ができました');
      log(`文字起こしモデル ${m.id}（${accel}）を準備（${Math.round(performance.now() - t0)} ms）`);
    };
    if (!state.asr.engine || state.asr.engine.loadedKey !== key) await loadEngine();
    if (state.asr.cancel) throw new Error('中止しました');
    // progress is saved as it goes, so an interrupted run (browser or PC restart) continues where it stopped
    const pkey = partialKey(m.id);
    let resume = null;
    try {
      resume = JSON.parse(localStorage.getItem(pkey) || 'null');
    } catch {
      resume = null;
    }
    if (resume) log(`前回の途中経過から再開します（${resume.tracks.map((t) => t.chunksDone).join(' / ')} かたまり済み）`);
    let lastSave = 0;
    let latest = resume;
    let tr = null;
    // the GPU sometimes fails in the middle of a long run: restart the model and go on from where it stopped
    for (let attempt = 0; ; attempt++) {
      try {
        tr = await transcribeTracks({
          tracks: state.tracks.map((t) => ({ name: t.name, pcm16: t.pcm16, rate: t.rate, vad: t.vad, levels: t.levels })),
          maps: state.maps,
          engine: state.asr.engine,
          modelKey: m.key,
          onProgress: (f, text) => setProgress('asrProgress', f, text),
          isCancelled: () => state.asr.cancel,
          resume: latest,
          onCheckpoint: (partial) => {
            latest = JSON.parse(JSON.stringify(partial));
            if (performance.now() - lastSave < 15000) return;
            lastSave = performance.now();
            try {
              localStorage.setItem(pkey, JSON.stringify(partial));
            } catch (e) {
              log(`途中経過を保存できませんでした（${e.message}）`);
            }
          },
        });
        break;
      } catch (e) {
        if (state.asr.cancel || attempt >= 3) {
          try { if (latest) localStorage.setItem(pkey, JSON.stringify(latest)); } catch { /* ignore */ }
          throw e;
        }
        log(`文字起こし中にエラー（${String(e.message).split('\n')[0]}）。モデルを読み込み直して続きから再開します（${attempt + 1} 回目）`);
        await loadEngine('エラーのため、モデルを読み込み直しています…');
      }
    }
    try { localStorage.removeItem(pkey); } catch { /* ignore */ }
    tr.device = accel;
    log(`文字起こし: 音声 ${fmtTime(tr.audioSec)} を ${tr.elapsedSec.toFixed(0)} 秒で処理（${(tr.audioSec / Math.max(1, tr.elapsedSec)).toFixed(1)} 倍速）`);
    await applyTranscript(tr, null);
    hideProgress('asrProgress');
    refreshAsrInfo();
  } catch (e) {
    console.error(e);
    hideProgress('asrProgress');
    const box = $('asrError');
    box.hidden = false;
    box.textContent = state.asr.cancel ? '文字起こしを中止しました。' : `文字起こしに失敗しました: ${e.message}`;
    log(`文字起こしエラー: ${e.message}`);
    if (state.asr.engine && !state.asr.engine.ready) state.asr.engine = null;
  } finally {
    $('asrCancel').hidden = true;
    setBusy(false);
  }
}

function cancelTranscription() {
  state.asr.cancel = true;
  if (state.asr.engine) state.asr.engine.terminate();
  state.asr.engine = null;
}

/** Use a transcript (new or loaded from a file); savedFillers restores earlier decisions. */
async function applyTranscript(tr, savedFillers) {
  if (tr.tracks.length !== state.tracks.length) throw new Error(`トラック数が違います（文字起こし ${tr.tracks.length} / 読み込み ${state.tracks.length}）`);
  state.transcript = tr;
  if (savedFillers) {
    state.fillers = savedFillers.map((f) => ({ ...f }));
  } else {
    setProgress('asrProgress', 0, 'フィラーの候補を探しています…');
    const t0 = performance.now();
    state.fillers = await detectFillers({
      tracks: state.tracks.map((t) => ({ name: t.name, pcm16: t.pcm16, rate: t.rate, vad: t.vad, levels: t.levels })),
      transcript: tr,
      maps: state.maps,
      onProgress: (f, text) => setProgress('asrProgress', f, text),
    });
    log(`フィラー候補 ${state.fillers.length} 件（${Math.round(performance.now() - t0)} ms）`);
  }
  for (const f of state.fillers) if (f.defaultEnabled == null) f.defaultEnabled = f.sources.includes('manual') ? false : f.enabled;
  $('restoreBox').hidden = true;
  state.selFiller = null;
  $('fillerPanel').hidden = false;
  renderTranscriptView();
  rebuildPlan();
  hideProgress('asrProgress');
  $('exportTranscript').checked = true; // a fresh transcript is saved too unless unticked
  updateButtons();
  refreshAsrNote();
  saveNow();
}

function renderTranscriptView() {
  const rows = buildRows(state.transcript, state.fillers, state.maps);
  state.marks = renderRows($('transcriptView'), rows, state.tracks);
  updateMarks(state.marks, state.fillers, state.plan || { fillers: [] }, state.selFiller);
  applyEvalMode();
}

function renderFillerSummary() {
  const f = state.fillers;
    const on = f.filter((x) => x.enabled).length;
  const items = [
    ['見つかった候補', `${f.length} か所`],
    ['切る', `${on} か所`],
    ['残す', `${f.length - on} か所`],
  ];
  $('fillerSummary').innerHTML = items.map(([k, v]) => `<div class="item"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
}

function fillerById(id) {
  return state.fillers && state.fillers.find((f) => f.id === id);
}

function fillerRefTime(f) {
  const m = state.maps[f.track];
  return { T0: (f.start - m.b) / m.a, T1: (f.end - m.b) / m.a };
}

function selectFiller(id, play = true) {
  const f = fillerById(id);
  if (!f) return;
  state.selFiller = id;
  updateMarks(state.marks, state.fillers, state.plan, id);
  const mk = state.marks.get(id);
  if (mk) {
    // scroll only the transcript list, not the whole page
    const box = $('transcriptView');
    const top = mk.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  }
  const { T0, T1 } = fillerRefTime(f);
  if (state.editor) {
    state.editor.selFillerId = id;
    state.editor.playhead = Math.max(0, T0 - 1.2);
  }
  const mode = (state.plan.fillers || []).find((x) => x.id === id);
  const info = $('fillerSelInfo');
  info.innerHTML = '';
  const who = document.createElement('b');
  who.style.color = state.tracks[f.track].color;
  who.textContent = state.tracks[f.track].name;
  info.append(who, `　${fmtTime(T0)}　「${f.text}」${f.enabled && mode && mode.mode === 'mute' ? '（ほかの人と重なっているので、この人の声だけ消します）' : ''}`);
  updateFillerChoice();
  setCursor((T0 + T1) / 2, false);
  if (play) playFiller('raw');
}

function playFiller(kind) {
  const f = fillerById(state.selFiller);
  if (!f) return;
  const { T0, T1 } = fillerRefTime(f);
  const tracks = state.tracks;
  // pick the speaker's voice out of overlapping speech
  const gains = focusGains(tracks.length, f.track, $('listenMode').value);
  if (kind === 'raw') playRaw({ tracks, maps: state.maps, T0: T0 - 1.2, T1: T1 + 0.8, gains });
  else playEdited({ tracks, maps: state.maps, gates: gatesFor(state.plan), plan: state.plan, T0: T0 - 1.6, T1: T1 + 1.2, gains });
}

function toggleFiller(id, on) {
  const f = fillerById(id);
  if (!f) return;
  const next = on == null ? !f.enabled : on;
  if (next === f.enabled) return;
  pushUndo();
  f.enabled = next;
  rebuildPlan();
  scheduleSave();
  if (state.selFiller === id) selectFiller(id, false);
}

/** The 切る / 残す buttons show the choice for the selected candidate. */
function updateFillerChoice() {
  const f = fillerById(state.selFiller);
  for (const id of ['fCut', 'fKeep', 'fPlayRaw', 'fPlayEdit']) $(id).disabled = !f;
  $('fCut').classList.toggle('on', !!f && f.enabled);
  $('fKeep').classList.toggle('on', !!f && !f.enabled);
}

function moveFiller(dir) {
  if (!state.fillers || !state.fillers.length) return;
  let sorted = [...state.fillers].map((f) => ({ f, T: fillerRefTime(f).T0 })).sort((a, b) => a.T - b.T);
  if (evalOpen()) {
    const [T0, T1] = evalRangeRef();
    sorted = sorted.filter((x) => x.T >= T0 - 1 && x.T < T1);
  }
  const only = $('onlyFillerRows').checked;
  let i = sorted.findIndex((x) => x.f.id === state.selFiller);
  if (i < 0) i = dir > 0 ? -1 : sorted.length;
  const next = sorted[i + dir];
  if (next) selectFiller(next.f.id, true);
  else if (only) $('fillerSelInfo').textContent = dir > 0 ? '最後のフィラーです' : '最初のフィラーです';
}

function bulkFillers(cls, on) {
  pushUndo();
  for (const f of state.fillers) if (f.cls === cls) f.enabled = on;
  rebuildPlan();
  scheduleSave();
  updateFillerChoice();
}

async function loadTranscriptFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const tr = data.transcript || data;
    if (!tr.tracks || !Array.isArray(tr.tracks)) throw new Error('文字起こしの形式ではありません');
    if (!state.analyzed) throw new Error('先に音声を読み込んで解析してください');
    let fillers = data.fillers || null;
    // the audio may have been loaded in another order: match the tracks by file name
    if (Array.isArray(data.tracks) && data.tracks.length === state.tracks.length && data.tracks.every((t) => t.source)) {
      const order = data.tracks.map((t) => state.tracks.findIndex((x) => x.file.name === t.source));
      if (order.every((i) => i >= 0) && new Set(order).size === order.length && order.some((i, k) => i !== k)) {
        const tracks = [];
        order.forEach((i, k) => { tracks[i] = tr.tracks[k]; });
        tr.tracks = tracks;
        if (fillers) fillers = fillers.map((f) => ({ ...f, track: order[f.track] }));
        log('文字起こしのトラックを、ファイル名に合わせて並べ替えました');
      }
    }
    if (data.evalFrom) $('evalFrom').value = data.evalFrom;
    if (data.evalLen) $('evalLen').value = data.evalLen;
    await applyTranscript(tr, fillers);
    hideProgress('asrProgress');
    log(`文字起こしを読み込みました: ${file.name}`);
  } catch (e) {
    $('asrError').hidden = false;
    $('asrError').textContent = `読み込めませんでした: ${e.message}`;
  }
}

// ---------------------------------------------------------------- answers for evaluation (正解を付ける)

const evalState = { play: null, raf: 0 };

function evalOpen() {
  return $('evalBox').open && !!state.fillers;
}

/** Evaluation range on the common timeline (seconds). */
function evalRangeRef() {
  const from = Math.max(0, parseFloat($('evalFrom').value) || 0) * 60;
  const len = Math.max(0.5, parseFloat($('evalLen').value) || 5) * 60;
  return [from, Math.min(state.timeline.duration, from + len)];
}

/** The same range in each track's own time. */
function evalRangesTrack() {
  const [T0, T1] = evalRangeRef();
  return state.maps.map((m) => [m.a * T0 + m.b, m.a * T1 + m.b]);
}

function hasVerdicts() {
  return !!state.fillers && state.fillers.some((f) => f.verdict || f.sources.includes('manual'));
}

function applyEvalMode() {
  const on = evalOpen();
  document.body.classList.toggle('evalmode', on);
  if (!state.marks) return;
  if (on) {
    const [T0, T1] = evalRangeRef();
    filterRows($('transcriptView'), T0, T1);
    renderEval();
  } else {
    filterRows($('transcriptView'), NaN, NaN);
    stopEvalPlay();
  }
}

function renderEval() {
  if (!state.fillers) return;
  const r = evaluateVerdicts(state.fillers, evalRangesTrack());
  const p = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');
  const src = Object.entries(r.bySource)
    .map(([k, v]) => `${k.split('+').map((s) => ({ text: '文字', gap: '文字なし', sound: '伸ばす音' })[s] || s).join('＋')} ${v.yes}/${v.n}`)
    .join('、');
  $('evalResult').innerHTML = `
    <div class="summary">
      <div class="item"><span class="k">判定した候補</span><span class="v">${r.judged} / ${r.candidates}</span></div>
      <div class="item"><span class="k">候補のうち本当にフィラー</span><span class="v">${p(r.precision)}</span></div>
      <div class="item"><span class="k">フィラーを見つけられた割合</span><span class="v">${p(r.recall)}</span></div>
      <div class="item"><span class="k">最初から「切る」候補の正しさ</span><span class="v">${p(r.cutByDefault.precision)}</span></div>
      <div class="item"><span class="k">誤って切る候補</span><span class="v">${r.cutByDefault.wrong} 件</span></div>
      <div class="item"><span class="k">追加した見落とし</span><span class="v">${r.addedByHand} 件</span></div>
    </div>
    <p class="hint">根拠ごとの当たり: ${src || '—'}。見つけられた割合は「判定でフィラーとした数 ÷（それ＋追加した見落とし）」です。範囲を最後まで聞き終えてから見てください。</p>`;
}

function setVerdict(id, v) {
  const f = fillerById(id);
  if (!f) return;
  if (f.sources.includes('manual') && v === 'no') {
    // a filler added by hand and then rejected is simply removed
    state.fillers = state.fillers.filter((x) => x !== f);
    state.selFiller = null;
    renderTranscriptView();
    rebuildPlan();
  } else {
    f.verdict = f.verdict === v ? undefined : v;
    updateMarks(state.marks, state.fillers, state.plan, state.selFiller);
  }
  renderEval();
  scheduleSave();
}

/** Playback position (common timeline) of the "通して聞く" playback, or NaN. */
function evalPlayPos() {
  const p = evalState.play;
  if (!p) return NaN;
  const t = p.T0 + (p.handle.ctx.currentTime - p.handle.startedAt);
  return t <= p.T1 ? t : NaN;
}

function startEvalPlay() {
  stopEvalPlay();
  const [R0, R1] = evalRangeRef();
  const c = state.view.cursor;
  const T0 = c > R0 && c < R1 - 2 ? c : R0;
  const token = {};
  const handle = playRaw({ tracks: state.tracks, maps: state.maps, T0, T1: R1, onEnd: () => { if (evalState.play && evalState.play.token === token) stopEvalPlay(); } });
  evalState.play = { T0, T1: R1, handle, token };
  const tick = () => {
    const T = evalPlayPos();
    if (!Number.isFinite(T)) return;
    $('evalPos').textContent = `再生中 ${fmtTime(T)}（${fmtTime(R1)} まで）`;
    markNowRow($('transcriptView'), T);
    state.view.playhead = T;
    if (Math.abs(T - state.view.cursor) > state.view.windowSec * 0.4) state.view.cursor = T + state.view.windowSec * 0.3;
    scheduleDraw();
    evalState.raf = requestAnimationFrame(tick);
  };
  evalState.raf = requestAnimationFrame(tick);
}

function stopEvalPlay() {
  cancelAnimationFrame(evalState.raf);
  if (evalState.play) {
    const T = evalPlayPos();
    if (Number.isFinite(T)) state.view.cursor = T;
    if (isCurrent(evalState.play.handle)) stopSnippet();
  }
  evalState.play = null;
  $('evalPos').textContent = '';
}

/** Which person most likely said the sound that ended just before T (common timeline). */
function likelyTrack(T) {
  let best = 0;
  let bv = -Infinity;
  state.tracks.forEach((t, k) => {
    const m = state.maps[k];
    const f1 = Math.round((m.a * T + m.b) * 100);
    let sum = 0;
    let n = 0;
    for (let f = f1 - 100; f < f1; f++) {
      if (f < 0 || f >= t.levels.length || !t.vad.core[f]) continue;
      sum += t.levels[f] - t.vad.speechDb;
      n++;
    }
    const v = n ? sum / n + Math.min(n, 40) * 0.1 : -999;
    if (v > bv) { bv = v; best = k; }
  });
  return best;
}

let manualSeq = 1;
function addMissedFiller(trackOverride) {
  if (!state.fillers) return;
  const Tp = evalPlayPos();
  const T = Number.isFinite(Tp) ? Tp : state.view.cursor;
  const k = trackOverride != null ? trackOverride : likelyTrack(T);
  const m = state.maps[k];
  const t = state.tracks[k];
  const c = manualFillerAt(m.a * T + m.b, t.vad.core, t.levels);
  const f = { ...c, id: `m-${Date.now().toString(36)}-${manualSeq++}`, track: k, enabled: true, defaultEnabled: false, verdict: 'yes' };
  state.fillers.push(f);
  renderTranscriptView();
  rebuildPlan();
  state.selFiller = f.id;
  updateMarks(state.marks, state.fillers, state.plan, f.id);
  $('fillerSelInfo').textContent = `見落としを追加: ${t.name}　${fmtTime((f.start - m.b) / m.a, true)}（話者が違うときは 1〜${state.tracks.length} キー）`;
  renderEval();
  scheduleSave();
  log(`見落としを追加: ${t.name} ${f.start.toFixed(2)}-${f.end.toFixed(2)} 秒`);
}

/** Move a hand-added filler to another person (keys 1-3). */
function reassignManual(k) {
  const f = fillerById(state.selFiller);
  if (!f || !f.sources.includes('manual') || k >= state.tracks.length || k === f.track) return;
  const old = state.maps[f.track];
  const T = (f.end + 0.35 - old.b) / old.a;
  state.fillers = state.fillers.filter((x) => x !== f);
  const m = state.maps[k];
  const t = state.tracks[k];
  const c = manualFillerAt(m.a * T + m.b, t.vad.core, t.levels);
  const nf = { ...f, ...c, track: k };
  state.fillers.push(nf);
  renderTranscriptView();
  rebuildPlan();
  selectFiller(nf.id, false);
  renderEval();
  scheduleSave();
}

// ---------------------------------------------------------------- saving the transcript in the browser

function filesSignature() {
  return state.tracks.map((t) => `${t.file.name}:${t.file.size}`).join('|');
}

function saveKey() {
  return 'va:transcript:' + filesSignature();
}

/** Where an unfinished transcription is kept (per files, model and speech-detection settings). */
function partialKey(modelId) {
  return `va:partial:${modelId}:${state.tracks.map((t) => t.sensitivity).join(',')}:${filesSignature()}`;
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}

function hasEdits() {
  const e = state.edits;
  return e.cuts.length + e.mutes.length + e.disabled.length > 0;
}

function saveNow() {
  if (!state.analyzed || (!state.transcript && !hasEdits())) return;
  try {
    const data = { savedAt: new Date().toISOString(), transcript: state.transcript, fillers: state.fillers, edits: state.edits, evalFrom: $('evalFrom').value, evalLen: $('evalLen').value };
    localStorage.setItem(saveKey(), JSON.stringify(data));
  } catch (e) {
    log(`ブラウザへの保存に失敗しました（${e.message}）。書き出しの _transcript.json は使えます。`);
  }
}

/** After analysis: offer to restore a transcript saved for the same files. */
function checkRestore() {
  const box = $('restoreBox');
  box.hidden = true;
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(saveKey()) || 'null');
  } catch {
    data = null;
  }
  const e = data && data.edits;
  const nEdits = e ? e.cuts.length + e.mutes.length + e.disabled.length : 0;
  if (!data || (!data.transcript && !nEdits) || state.transcript) return;
  const when = new Date(data.savedAt).toLocaleString();
  const verdicts = (data.fillers || []).filter((f) => f.verdict).length;
  const what = [data.transcript ? '文字起こし' : '', nEdits ? `手動の編集 ${nEdits} 件` : ''].filter(Boolean).join('と');
  box.hidden = false;
  box.innerHTML = `この音声の${what}が保存されています（${when}${verdicts ? `、判定 ${verdicts} 件` : ''}）。 <button class="btn tiny" id="restoreBtn">復元する</button> <button class="btn tiny link" id="restoreDrop">削除</button>`;
  $('restoreBtn').addEventListener('click', async () => {
    box.hidden = true;
    if (nEdits) {
      state.edits = { cuts: e.cuts || [], mutes: e.mutes || [], disabled: e.disabled || [] };
      rebuildPlan();
      log(`手動の編集 ${nEdits} 件を復元しました`);
    }
    if (!data.transcript) return;
    if (data.evalFrom) $('evalFrom').value = data.evalFrom;
    if (data.evalLen) $('evalLen').value = data.evalLen;
    // keep the saved candidates only if someone has already worked on them; otherwise
    // find them again with the current detection rules
    const touched = (data.fillers || []).some((f) => f.verdict || f.sources.includes('manual') || (f.defaultEnabled != null && f.enabled !== f.defaultEnabled));
    await applyTranscript(data.transcript, touched ? data.fillers : null);
    log(`保存されていた文字起こしを復元しました（${when}${touched ? '' : '、候補は今の設定で探し直し'}）`);
  });
  $('restoreDrop').addEventListener('click', () => {
    try { localStorage.removeItem(saveKey()); } catch { /* ignore */ }
    box.hidden = true;
  });
}

function bindTranscriptUI() {
  $('asrBtn').addEventListener('click', runTranscription);
  $('asrCancel').addEventListener('click', cancelTranscription);
  $('transcriptFile').addEventListener('change', (e) => {
    if (e.target.files[0]) loadTranscriptFile(e.target.files[0]);
    e.target.value = '';
  });
  const view = $('transcriptView');
  view.addEventListener('click', (e) => {
    const mk = e.target.closest('mark');
    if (mk) {
      selectFiller(mk.dataset.id, true);
      return;
    }
    const tt = e.target.closest('.tt');
    if (tt) {
      const T = parseFloat(tt.dataset.t);
      setCursor(T, true);
      playRaw({ tracks: state.tracks, maps: state.maps, T0: T - 0.3, T1: T + 6 });
    }
  });
  view.addEventListener('dblclick', (e) => {
    const mk = e.target.closest('mark');
    if (mk) {
      e.preventDefault();
      toggleFiller(mk.dataset.id);
    }
  });
  view.addEventListener('keydown', (e) => {
    if (!state.fillers) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown') moveFiller(1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') moveFiller(-1);
    else if (k === ' ') playFiller('raw');
    else if (k === 'e' || k === 'E') playFiller('edited');
    else if (k === 'Enter') toggleFiller(state.selFiller);
    else if (evalOpen() && (k === 'y' || k === 'Y')) setVerdict(state.selFiller, 'yes');
    else if (evalOpen() && (k === 'n' || k === 'N')) setVerdict(state.selFiller, 'no');
    else if (evalOpen() && (k === 'a' || k === 'A')) addMissedFiller();
    else if (evalOpen() && /^[1-9]$/.test(k)) reassignManual(parseInt(k, 10) - 1);
    else return;
    e.preventDefault();
  });
  $('fPrev').addEventListener('click', () => moveFiller(-1));
  $('fNext').addEventListener('click', () => moveFiller(1));
  $('fPlayRaw').addEventListener('click', () => playFiller('raw'));
  $('fPlayEdit').addEventListener('click', () => playFiller('edited'));
  $('fCut').addEventListener('click', () => { toggleFiller(state.selFiller, true); updateFillerChoice(); });
  $('fKeep').addEventListener('click', () => { toggleFiller(state.selFiller, false); updateFillerChoice(); });
  $('asrModel').addEventListener('change', refreshAsrNote);
  document.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => bulkFillers(b.dataset.bulk, b.dataset.on === '1')));
  $('listenMode').addEventListener('change', () => {
    try { localStorage.setItem('va:listenMode', $('listenMode').value); } catch { /* ignore */ }
    playFiller('raw');
  });
  try {
    const lm = localStorage.getItem('va:listenMode');
    if (lm) $('listenMode').value = lm;
  } catch { /* ignore */ }
  $('fYes').addEventListener('click', () => setVerdict(state.selFiller, 'yes'));
  $('fNo').addEventListener('click', () => setVerdict(state.selFiller, 'no'));
  // marking answers is for checking the detection; it only shows with ?eval in the address
  $('evalBox').hidden = !new URLSearchParams(location.search).has('eval');
  $('evalBox').addEventListener('toggle', applyEvalMode);
  for (const id of ['evalFrom', 'evalLen']) $(id).addEventListener('change', () => { applyEvalMode(); scheduleSave(); });
  $('evalPlay').addEventListener('click', () => { startEvalPlay(); $('transcriptView').focus(); });
  $('evalStop').addEventListener('click', stopEvalPlay);
  $('evalAdd').addEventListener('click', () => { addMissedFiller(); $('transcriptView').focus(); });
  $('onlyFillerRows').addEventListener('change', () => view.classList.toggle('only', $('onlyFillerRows').checked));
}

// ---------------------------------------------------------------- settings

function bindSettings() {
  const s = state.settings;
  const bind = (id, fmt, apply) => {
    const el = $(id);
    const out = $(id + 'Out');
    el.value = s[id];
    const show = () => { if (out) out.textContent = fmt(parseFloat(el.value)); };
    show();
    el.addEventListener('input', () => {
      s[id] = parseFloat(el.value);
      show();
      apply();
    });
    return { el, show };
  };
  const maxP = bind('maxPause', (v) => `${v.toFixed(1)} 秒`, () => {
    if (s.targetPause > s.maxPause) { s.targetPause = s.maxPause; tgt.el.value = s.targetPause; tgt.show(); }
    if (state.analyzed) queuePlan();
  });
  const tgt = bind('targetPause', (v) => `${v.toFixed(2)} 秒`, () => {
    if (s.targetPause > s.maxPause) { s.maxPause = s.targetPause; maxP.el.value = s.maxPause; maxP.show(); }
    if (state.analyzed) queuePlan();
  });
  // 控えめ / ふつう / しっかり set both pause sliders at once
  const PRESETS = { soft: [1.5, 0.8], normal: [DEFAULT_SETTINGS.maxPause, DEFAULT_SETTINGS.targetPause], strong: [0.5, 0.3] };
  const showPreset = () => {
    document.querySelectorAll('#pausePreset [data-preset]').forEach((b) => {
      const [mp, tp] = PRESETS[b.dataset.preset];
      b.classList.toggle('on', Math.abs(s.maxPause - mp) < 1e-6 && Math.abs(s.targetPause - tp) < 1e-6);
    });
  };
  document.querySelectorAll('#pausePreset [data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      [s.maxPause, s.targetPause] = PRESETS[b.dataset.preset];
      maxP.el.value = s.maxPause;
      tgt.el.value = s.targetPause;
      maxP.show();
      tgt.show();
      showPreset();
      if (state.analyzed) queuePlan();
    }),
  );
  maxP.el.addEventListener('input', showPreset);
  tgt.el.addEventListener('input', showPreset);
  showPreset();
  bind('fillerGap', (v) => `${v.toFixed(2)} 秒`, () => {
    if (state.analyzed) queuePlan();
  });
  bind('gateDb', (v) => (v === 0 ? 'そのまま' : `${v} dB`), () => {
    if (state.analyzed) rebuildGates();
  });
  const lufs = $('targetLufs');
  lufs.value = String(s.targetLufs);
  lufs.addEventListener('change', () => {
    s.targetLufs = parseFloat(lufs.value);
    if (state.analyzed) changed();
  });
}

// ---------------------------------------------------------------- wiring

function init() {
  checkEnvironment();
  bindSettings();
  bindTranscriptUI();

  const drop = $('drop');
  $('fileInput').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'drop' || e.target === drop) drop.classList.remove('over');
    }),
  );
  window.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  $('analyzeBtn').addEventListener('click', analyze);
  $('resyncBtn').addEventListener('click', () => {
    if (!state.analyzed) return;
    autoSync();
    rebuildTimeline();
    renderSyncTable();
  });
  $('resetSyncBtn').addEventListener('click', () => {
    if (!state.analyzed) return;
    state.maps = state.sync.maps.map((m) => ({ ...m }));
    rebuildTimeline();
    renderSyncTable();
  });

  state.editor = new TrackEditor($('editor'), editorHost);
  // click or drag on the overview to move the view there
  const ov = $('overview');
  let ovDrag = false;
  const ovMove = (e) => {
    const T = overviewTimeAt(ov, e, state.timeline.duration);
    setCursor(T, true);
    state.editor.seek(T);
  };
  ov.addEventListener('mousedown', (e) => { if (!state.analyzed) return; ovDrag = true; ovMove(e); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (ovDrag) ovMove(e); });
  window.addEventListener('mouseup', () => { ovDrag = false; });

  document.querySelectorAll('#stepper [data-step]').forEach((b) => b.addEventListener('click', () => showStep(parseInt(b.dataset.step, 10))));
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => showStep(parseInt(b.dataset.go, 10))));
  window.addEventListener('resize', scheduleDraw);

  $('previewBtn').addEventListener('click', makePreview);
  const player = $('player');
  player.addEventListener('play', () => {
    cancelAnimationFrame(playLoop);
    playLoop = requestAnimationFrame(followPlayback);
  });
  player.addEventListener('seeked', followPlayback);

  $('exportBtn').addEventListener('click', doExport);
  $('exportStems').addEventListener('change', updateButtons);
  $('exportMix').addEventListener('change', updateButtons);

  showStep(0);
  updateButtons();
  log('準備ができました。音声ファイルを読み込んでください。');
}

init();

// For debugging and automated tests.
window.__va = { state, analyze, makePreview, doExport, addFiles, runTranscription, applyTranscript, toggleFiller, selectFiller, setVerdict, addMissedFiller, saveNow, evaluate: () => evaluateVerdicts(state.fillers, evalRangesTrack()) };
