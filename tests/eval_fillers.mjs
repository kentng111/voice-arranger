// Scores filler candidates against a person's judgement (real recordings).
//
//   node tests/eval_fillers.mjs <name>_transcript.json
//     uses the answers given in the app ("正解を付ける": each candidate marked as filler / not,
//     missed fillers added by hand) within the evaluation range saved in the file.
//
// or, with Audacity labels:
//   node tests/eval_fillers.mjs <name>_transcript.json <labels1.txt> <labels2.txt> <labels3.txt> [--from 600] [--until 900] [--json out.json]
//
// <name>_transcript.json : written by the app on export (when a transcript exists)
// labelsN.txt            : Audacity label file for track N (in the same order as in the app),
//                          made on the ORIGINAL recording of that person. One label per filler,
//                          text = what was said (えー, あの, ...). Times are in that file's own time.
// --from S / --until S   : only this part of each track (its own time, seconds) was labelled
//
// Matching: a candidate and a label match when they overlap by at least half of the shorter one
// (each label matches at most one candidate).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fillerClass } from '../js/core/transcript.js';
import { evaluateVerdicts, parseAudacityLabels as parseLabels } from '../js/core/evaluate.js';

export function parseAudacityLabels(text) {
  return parseLabels(text, fillerClass);
}

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Greedy one-to-one matching by overlap. Returns pairs [candIndex, labelIndex]. */
export function matchIntervals(cands, labels) {
  const pairs = [];
  for (let i = 0; i < cands.length; i++) {
    for (let j = 0; j < labels.length; j++) {
      const o = overlap(cands[i], labels[j]);
      const shorter = Math.min(cands[i].end - cands[i].start, labels[j].end - labels[j].start);
      if (o >= 0.5 * shorter && o > 0) pairs.push([i, j, o]);
    }
  }
  pairs.sort((x, y) => y[2] - x[2]);
  const ci = new Set();
  const lj = new Set();
  const res = [];
  for (const [i, j] of pairs) {
    if (ci.has(i) || lj.has(j)) continue;
    ci.add(i);
    lj.add(j);
    res.push([i, j]);
  }
  return res;
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * fillers: candidates from the app ({ track, start, end, cls, sources, enabled, text })
 * labelsByTrack: [[{ start, end, text, cls }]]
 */
export function evaluate(fillers, labelsByTrack, { from = 0, until = Infinity } = {}) {
  const rows = [];
  const all = { tp: 0, fp: 0, fn: 0 };
  const adopted = { tp: 0, fp: 0, fn: 0 };
  const bySource = {};
  const byLabelCls = {};
  const startErr = [];
  const endErr = [];
  const wrongCuts = [];
  const missed = [];
  let intoSpeech = 0;
  labelsByTrack.forEach((labels0, k) => {
    const inRange = (x) => x.start >= from && x.start < until;
    const labels = labels0.filter(inRange);
    const cands = fillers.filter((f) => f.track === k && inRange(f));
    const m = matchIntervals(cands, labels);
    const cm = new Map(m.map(([i, j]) => [i, j]));
    const lm = new Set(m.map(([, j]) => j));
    cands.forEach((c, i) => {
      const key = [...c.sources].sort().join('+');
      bySource[key] = bySource[key] || { n: 0, tp: 0 };
      bySource[key].n++;
      const hit = cm.has(i);
      if (hit) {
        bySource[key].tp++;
        all.tp++;
        const l = labels[cm.get(i)];
        startErr.push(Math.abs(c.start - l.start) * 1000);
        endErr.push(Math.abs(c.end - l.end) * 1000);
        if (c.start < l.start - 0.08 || c.end > l.end + 0.08) intoSpeech++;
        if (c.enabled) adopted.tp++;
      } else {
        all.fp++;
        if (c.enabled) {
          adopted.fp++;
          wrongCuts.push({ track: k, start: c.start, end: c.end, text: c.text, sources: c.sources.join('+') });
        }
      }
    });
    labels.forEach((l, j) => {
      byLabelCls[l.cls] = byLabelCls[l.cls] || { n: 0, found: 0, adopted: 0 };
      byLabelCls[l.cls].n++;
      if (lm.has(j)) {
        byLabelCls[l.cls].found++;
        const i = m.find(([, jj]) => jj === j)[0];
        if (cands[i].enabled) byLabelCls[l.cls].adopted++;
        else adopted.fn++;
      } else {
        all.fn++;
        adopted.fn++;
        missed.push({ track: k, start: l.start, end: l.end, text: l.text });
      }
    });
    rows.push({ track: k, labels: labels.length, candidates: cands.length, matched: m.length });
  });
  const pr = (x) => ({ ...x, precision: x.tp / Math.max(1, x.tp + x.fp), recall: x.tp / Math.max(1, x.tp + x.fn) });
  return {
    perTrack: rows,
    allCandidates: pr(all),
    adoptedByDefault: pr(adopted),
    bySource,
    byLabelClass: byLabelCls,
    boundaryMs: { startMedian: median(startErr), endMedian: median(endErr), reachingIntoSpeech: intoSpeech },
    wrongCuts,
    missed,
  };
}

function pct(x) {
  return `${(x * 100).toFixed(0)}%`;
}

function main() {
  const args = process.argv.slice(2);
  let until = Infinity;
  let from = 0;
  let jsonOut = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--until') until = parseFloat(args[++i]);
    else if (args[i] === '--from') from = parseFloat(args[++i]);
    else if (args[i] === '--json') jsonOut = args[++i];
    else files.push(args[i]);
  }
  if (files.length === 1) {
    const data = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    if (!data.evalRanges) {
      console.log('この文字起こしには評価の範囲と判定が入っていません（アプリの「正解を付ける」を使ってから書き出してください）');
      process.exit(1);
    }
    const r = evaluateVerdicts(data.fillers || [], data.evalRanges);
    const tr = data.transcript || {};
    console.log(`model: ${tr.model}  device: ${tr.device}`);
    console.log(`candidates ${r.candidates} (judged ${r.judged}, not judged ${r.unjudged}), fillers ${r.fillersFound}, not fillers ${r.notFillers}, added by hand ${r.addedByHand}`);
    console.log(`all candidates : precision ${pct(r.precision)}  recall ${pct(r.recall)}`);
    console.log(`cut by default : precision ${pct(r.cutByDefault.precision)}  recall ${pct(r.cutByDefault.recall)}  wrong cuts ${r.cutByDefault.wrong}`);
    for (const [k, v] of Object.entries(r.bySource)) console.log(`  source ${k.padEnd(16)} ${v.yes}/${v.n}`);
    for (const [k, v] of Object.entries(r.byClass)) console.log(`  class  ${k.padEnd(16)} ${v.yes}/${v.n}`);
    for (const w of r.wrongCuts) console.log(`  wrong cut: track ${w.track + 1} ${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text} [${w.sources}]`);
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ model: tr.model, ...r }, null, 2));
    return;
  }
  if (files.length < 2) {
    console.log('usage: node tests/eval_fillers.mjs <name>_transcript.json <labels1.txt> [labels2.txt ...] [--from SEC] [--until SEC] [--json out.json]');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  const labels = files.slice(1).map((f) => parseAudacityLabels(fs.readFileSync(f, 'utf8')));
  const r = evaluate(data.fillers || [], labels, { from, until });
  const tr = data.transcript || {};
  console.log(`model: ${tr.model}  device: ${tr.device}  audio ${Math.round(tr.audioSec || 0)} s in ${Math.round(tr.elapsedSec || 0)} s`);
  for (const t of r.perTrack) console.log(`track ${t.track + 1} (${(data.tracks && data.tracks[t.track] && data.tracks[t.track].name) || ''}): labels ${t.labels}, candidates ${t.candidates}, matched ${t.matched}`);
  const a = r.allCandidates;
  const d = r.adoptedByDefault;
  console.log(`\nall candidates      : precision ${pct(a.precision)}  recall ${pct(a.recall)}  (tp ${a.tp}, fp ${a.fp}, fn ${a.fn})`);
  console.log(`cut by default      : precision ${pct(d.precision)}  recall ${pct(d.recall)}  (wrong cuts ${d.fp})`);
  console.log('\nby source (candidates that are real fillers):');
  for (const [k, v] of Object.entries(r.bySource)) console.log(`  ${k.padEnd(16)} ${v.tp}/${v.n}  (${pct(v.tp / Math.max(1, v.n))})`);
  console.log('\nby label class (found / cut by default):');
  for (const [k, v] of Object.entries(r.byLabelClass)) console.log(`  ${k.padEnd(8)} ${v.found}/${v.n} found, ${v.adopted}/${v.n} cut by default`);
  const b = r.boundaryMs;
  console.log(`\nboundaries: start error median ${b.startMedian.toFixed(0)} ms, end error median ${b.endMedian.toFixed(0)} ms, ${b.reachingIntoSpeech} candidates reach >80 ms beyond the label`);
  if (r.wrongCuts.length) {
    console.log('\nwrong cuts (cut by default but not labelled):');
    for (const w of r.wrongCuts) console.log(`  track ${w.track + 1} ${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text} [${w.sources}]`);
  }
  if (r.missed.length) {
    console.log('\nmissed fillers:');
    for (const m of r.missed.slice(0, 40)) console.log(`  track ${m.track + 1} ${m.start.toFixed(2)}-${m.end.toFixed(2)} ${m.text}`);
    if (r.missed.length > 40) console.log(`  ... ${r.missed.length - 40} more`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ model: tr.model, device: tr.device, ...r }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
