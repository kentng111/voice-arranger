// Unit tests for phase 2 (transcript, fillers, plan with fillers). Called from core.test.mjs.

import { frameLevels, FRAME_RATE, padActivity } from '../js/core/vad.js';
import { collateWhisperTokens, cleanupUnits, dropLeakedUnits, fillerClass, findTextFillers, buildCues, cuesToSrt, cuesToVtt, cuesToText } from '../js/core/transcript.js';
import { acousticFeatures, steadyVoicedRuns, findFillerCandidates } from '../js/core/filler.js';
import { planAsrChunks, chunkSamples } from '../js/core/asrplan.js';
import { buildPlan, DEFAULT_SETTINGS } from '../js/core/plan.js';
import { gatesWithMutes } from '../js/core/gate.js';
import { parseAudacityLabels, evaluate } from './eval_fillers.mjs';
import { evaluateVerdicts } from '../js/core/evaluate.js';
import { manualFillerAt } from '../js/core/filler.js';

export function runFillerTests(check) {
  {
    // A character split over two tokens (decode gives U+FFFD until both are present).
    const vocab = { 1: 'え', 2: 'と', 3: '�', 4: '、', 5: '今日' };
    const decode = (ids) => (ids.length === 2 && ids[0] === 3 && ids[1] === 3 ? '編' : ids.map((i) => vocab[i]).join(''));
    const units = collateWhisperTokens([50258, 1, 2, 4, 3, 3, 5, 50257], [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1.1, 1.5], decode, 50257, 10);
    check(
      'Whisper tokens -> units (split characters joined, offset applied)',
      JSON.stringify(units.map((u) => [u.text, u.start, u.end])) === JSON.stringify([['え', 10.2, 10.4], ['と', 10.4, 10.6], ['、', 10.6, 10.8], ['編', 10.8, 11.1], ['今日', 11.1, 11.5]]),
      JSON.stringify(units.map((u) => [u.text, u.start, u.end])),
    );
    const loop = cleanupUnits(Array.from({ length: 20 }, (_, i) => ({ text: 'あ', start: i, end: i + 1 })));
    check('repeated-text loops are cut off', loop.length === 6, `${loop.length} units kept`);
  }
  {
    const cases = [['えー', 'auto'], ['えっと', 'auto'], ['エート', 'auto'], ['あー', 'auto'], ['うーん', 'auto'], ['A', 'auto'], ['あの', 'review'], ['あのー', 'review'], ['まあ', 'review'], ['なんか', 'review'], ['その', 'review'], ['うん', null], ['ええ', 'review'], ['ああ', 'review'], ['ん', 'review'], ['んー', 'auto'], ['んん', 'auto'], ['ええと', 'auto'], ['おお', null], ['今日', null]];
    const bad = cases.filter(([t, c]) => fillerClass(t) !== c);
    check('filler words are classified (auto / review / none)', !bad.length, bad.map(([t]) => `${t}=${fillerClass(t)}`).join(' '));
    // Units as Whisper (base) produced them for a synthetic sentence.
    const U = (t, s, e) => ({ text: t, start: s, end: e });
    const units = [U('A', 0.26, 0.44), U('と', 0.44, 0.88), U('、', 0.88, 1.18), U('今日は', 1.18, 1.62), U('ですね', 1.62, 2.24), U('、', 2.24, 2.44),
      U('あの', 2.44, 3.04), U('ポ', 3.04, 3.16), U('ッ', 3.16, 3.22), U('ド', 3.22, 3.4), U('の', 3.74, 3.94), U('。', 6.58, 6.98),
      U('まあ', 7.08, 7.58), U('、', 7.58, 8.0), U('なんか', 8.0, 8.54), U('、', 8.54, 8.72), U('A', 8.72, 9.56), U('最近', 9.56, 9.78), U('は', 9.78, 10.04),
      U('、', 11.48, 11.56), U('う', 11.56, 11.8), U('ーん', 11.8, 12.28), U('、', 12.28, 12.38), U('あ', 12.38, 12.5), U('りがとう', 12.5, 13)];
    const got = findTextFillers(units).map((x) => `${x.text}:${x.cls}`).join(' ');
    check('text fillers found in a transcript', got === 'Aと:auto あの:review まあ:review なんか:review A:auto うーん:auto', got);
    // whisper-small output for the same sentence: no punctuation, contiguous token times
    const small = [['えー', 0.28, 0.48], ['と', 0.48, 1.18], ['今日は', 1.18, 1.66], ['ですね', 1.66, 2.38], ['あの', 2.38, 3.06], ['ポ', 3.06, 3.14], ['ッ', 3.14, 3.28],
      ['ま', 7.06, 7.24], ['あ', 7.24, 7.92], ['なんか', 7.92, 8.68], ['a', 8.68, 9.14], ['最近', 9.56, 9.8], ['は', 9.8, 10.0], ['う', 11.6, 11.8], ['ーん', 11.8, 12.32], ['って', 12.68, 12.82],
      ['その', 13, 13.2], ['時', 13.2, 13.5], ['ありがとう', 14, 14.5]].map(([t, s, e]) => U(t, s, e));
    const got2 = findTextFillers(small).map((x) => `${x.text}:${x.cls}`).join(' ');
    check('text fillers found without punctuation', got2 === 'えーと:auto あの:review まあ:review なんか:review a:auto うーん:auto', got2);
  }
  {
    // Acoustic: a steady "えー" (flat pitch, one vowel) next to syllable-like speech.
    const sr = 16000;
    const x = new Float32Array(sr * 4);
    let ph = 0;
    for (let i = 0; i < sr; i++) { // 1.0-2.0 s: steady vowel at 140 Hz
      ph += (2 * Math.PI * 140) / sr;
      let v = 0;
      for (let h = 1; h <= 12; h++) v += (Math.sin(h * ph) * (h === 3 || h === 4 ? 1.2 : 1)) / h;
      x[sr + i] = 0.15 * v * Math.min(1, i / 400, (sr - i) / 400);
    }
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let s = 2.4 * sr; s < 3.9 * sr;) { // 2.4-3.9 s: syllables with gliding pitch and changing vowels
      const len = Math.round((0.12 + 0.1 * rnd()) * sr);
      const f0 = 110 + 80 * rnd();
      const formant = 2 + Math.floor(rnd() * 5);
      let p = 0;
      for (let i = 0; i < len && s + i < x.length; i++) {
        p += (2 * Math.PI * f0 * (1 + (0.5 * i) / len)) / sr;
        let v = 0;
        for (let h = 1; h <= 12; h++) v += (Math.sin(h * p) * (h === formant ? 3 : 1)) / h;
        x[s + i] = 0.15 * v * Math.sin((Math.PI * i) / len);
      }
      s += len + Math.round(0.03 * sr);
    }
    for (let i = 0; i < x.length; i++) x[i] += (rnd() - 0.5) * 0.002;
    const levels = frameLevels(x, sr);
    const active = Uint8Array.from(levels, (l) => (l > -45 ? 1 : 0));
    const feat = acousticFeatures(x, sr, active);
    const runs = steadyVoicedRuns(feat, active);
    const hit = runs.filter((r) => r.start < 2.0 && r.end > 1.0);
    const wrong = runs.filter((r) => r.start >= 2.2);
    check('steady voiced sound is found, syllable speech is not', hit.length === 1 && hit[0].end - hit[0].start > 0.7 && !wrong.length,
      runs.map((r) => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join(' '));
    const pitchMed = Float32Array.from(feat.pitch.slice(110, 190)).sort()[40];
    check('pitch estimate of the steady vowel', Math.abs(pitchMed - 140) < 5, `${pitchMed.toFixed(1)} Hz`);
    const cands = findFillerCandidates({ units: [], core: active, levels, feat });
    const vowel = cands.find((c) => c.start < 1.5 && c.end > 1.5);
    check('steady sound without text becomes an automatic candidate', vowel && vowel.cls === 'auto' && vowel.sources.includes('sound'),
      JSON.stringify(cands.map((c) => [c.start, c.end, c.cls, c.sources.join('+')])));
  }
  {
    // Leaked voice: track 1 hears track 0 quietly; text in track 1 at that moment is dropped.
    const n = 1000;
    const lv0 = new Float32Array(n).fill(-70);
    const lv1 = new Float32Array(n).fill(-70);
    lv0.fill(-20, 100, 300); // track 0 speaks 1-3 s
    lv1.fill(-46, 100, 300); // ...and leaks into track 1 at -26 dB
    lv1.fill(-22, 500, 700); // track 1 speaks 5-7 s
    const maps = [{ a: 1, b: 0 }, { a: 1, b: 0 }];
    const core0 = Uint8Array.from(lv0, (v) => (v > -30 ? 1 : 0));
    const core1 = Uint8Array.from(lv1, (v) => (v > -50 ? 1 : 0)); // the leak is (wrongly) detected as speech
    lv0.fill(-20, 640, 900); // track 0 talks on after track 1 stopped
    const units = [{ text: '漏れ', start: 1.2, end: 2.5 }, { text: '本人', start: 5.2, end: 6.5 }, { text: 'えー', start: 6.6, end: 8.9 }];
    const kept = dropLeakedUnits(units, 1, [lv0, lv1], [core0, core1], [-20, -22], maps).map((u) => u.text).join();
    check('text from a leaked voice is dropped, own speech kept (also when its time runs on)', kept === '本人,えー', kept);
    // A text filler whose times run on over a long silence is trimmed to the actual sound.
    const core = new Uint8Array(2000);
    core.fill(1, 100, 140); // "うーん" 1.0-1.4 s
    core.fill(1, 700, 900); // next words 7-9 s
    const levels = Float32Array.from(core, (c) => (c ? -20 : -70));
    const c = findFillerCandidates({ units: [{ text: 'うーん', start: 1.0, end: 6.9 }, { text: '、', start: 6.9, end: 7.0 }, { text: 'では', start: 7.0, end: 7.5 }], core, levels });
    const u = c.find((x) => x.text === 'うーん');
    check('a filler is trimmed to the detected sound', u && u.end - u.start < 0.6, JSON.stringify(c));
  }
  {
    const fr = FRAME_RATE;
    const segs = [];
    for (let t = 1; t < 170; t += 4) segs.push([t * fr, (t + 2.5) * fr]);
    segs.push([175 * fr, 240 * fr]); // 65 s monologue
    const levels = new Float32Array(250 * fr).fill(-30);
    const chunks = planAsrChunks(segs, levels);
    const longest = Math.max(...chunks.map((c) => c.end - c.start));
    const covered = segs.every(([s, e]) => s >= 175 * fr || chunks.some((c) => c.start <= s / fr + 1e-9 && c.end >= e / fr - 1e-9));
    const mono = chunks.filter((c) => c.end > 175).reduce((a, c) => a + (Math.min(c.end, 240) - Math.max(c.start, 175)), 0);
    check('ASR chunks fit the 30 s window and cover all speech', longest <= 28.0001 && covered && mono >= 64.9, `${chunks.length} chunks, longest ${longest.toFixed(1)} s`);
    const pcm = new Float32Array(16000 * 3).fill(0.5);
    const act = new Uint8Array(300);
    act.fill(1, 100, 200);
    const y = chunkSamples(pcm, 16000, { start: 0, end: 3 }, act);
    check('outside the owner speech the chunk is turned down', Math.abs(y[16000 * 1.5] - 0.5) < 1e-6 && y[1000] < 0.02 && y[16000 * 2.8] < 0.02);
  }
  {
    // Plan with fillers on a 3-track toy conversation (frames at 100 fps).
    const n = 3000;
    const core = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    core[0].fill(1, 100, 500); // A speaks 1-5 s
    core[0].fill(1, 540, 580); // A: "えー" 5.4-5.8 s, alone
    core[0].fill(1, 600, 900); // A continues 6-9 s
    core[1].fill(1, 1000, 1500); // B speaks 10-15 s
    core[2].fill(1, 1200, 1250); // C: "あー" 12-12.5 s while B speaks
    core[0].fill(1, 1600, 2000);
    const acts = core.map((c) => padActivity(c));
    const fillers = [
      { id: 'a1', track: 0, start: 540, end: 580, enabled: true },
      { id: 'c1', track: 2, start: 1200, end: 1250, enabled: true },
    ];
    const base = buildPlan(acts, n, DEFAULT_SETTINGS, { coresRef: core, fillers: [] });
    const plan = buildPlan(acts, n, DEFAULT_SETTINGS, { coresRef: core, fillers });
    const fc = plan.cuts.filter((c) => c.type === 'filler');
    const a1 = plan.fillers.find((f) => f.id === 'a1');
    const c1 = plan.fillers.find((f) => f.id === 'c1');
    check('filler alone in a silence is cut out of the timeline', a1.mode === 'cut' && fc.length === 1 && fc[0].start >= 540 && fc[0].end <= 580, JSON.stringify(fc));
    const removed = plan.inputDuration - plan.outputDuration - (base.inputDuration - base.outputDuration);
    check('cutting a filler removes about its length', removed > 0.3 && removed <= 0.41, `${removed.toFixed(2)} s`);
    check("filler over someone else's speech is only muted on its own track", c1.mode === 'mute' && plan.mutes.filter((m) => m.track === 2).length === 1);
    const env = gatesWithMutes([new Float32Array(n).fill(1), new Float32Array(n).fill(1), new Float32Array(n).fill(1)], plan.mutes);
    check('muted frames are silent, other tracks untouched', env[2][1220] === 0 && env[2][1300] === 1 && env[1][1220] === 1 && env[0][560] === 0);
    // a short filler between two words of the same person (no real pause) is still cut
    const core2 = core.map((c) => Uint8Array.from(c));
    core2[0].fill(1, 1600, 2000);
    core2[0].fill(0, 1710, 1715); // "えーっと" 1.715-2.215 s with only tiny dips around it
    core2[0].fill(0, 1765, 1770);
    const acts2 = core2.map((c) => padActivity(c));
    const p2 = buildPlan(acts2, n, DEFAULT_SETTINGS, { coresRef: core2, fillers: [{ id: 'x', track: 0, start: 1715, end: 1765, enabled: true }] });
    const xc = p2.cuts.filter((c) => c.type === 'filler');
    check('a filler squeezed between words is cut, leaving the set gap', xc.length === 1 && xc[0].end - xc[0].start === 30, JSON.stringify(xc));
    const off = buildPlan(acts, n, DEFAULT_SETTINGS, { coresRef: core, fillers: fillers.map((f) => ({ ...f, enabled: false })) });
    check('rejected fillers change nothing', off.outputDuration === base.outputDuration && !off.mutes.length);
  }
  {
    const tracks = [
      { name: 'A', map: { a: 1, b: 0 }, units: [{ text: 'えー', start: 1, end: 1.4 }, { text: '、', start: 1.4, end: 1.5 }, { text: 'こんにちは', start: 1.5, end: 2.2 }, { text: '。', start: 2.2, end: 2.3 }] },
      { name: 'B', map: { a: 1, b: -1 }, units: [{ text: 'どうも', start: 2.5, end: 3.0 }] },
    ];
    const cues = buildCues(tracks, [{ track: 0, start: 1, end: 1.4, enabled: true }], (T) => T);
    check('cues skip adopted fillers and use the common timeline', cues.length === 2 && cues[0].text === 'こんにちは。' && Math.abs(cues[1].start - 3.5) < 1e-9, JSON.stringify(cues));
    const srt = cuesToSrt(cues);
    check('SRT format', srt.startsWith('1\n00:00:01,500 --> 00:00:02,200\nA: こんにちは。'), JSON.stringify(srt.slice(0, 60)));
    check('VTT format', cuesToVtt(cues).startsWith('WEBVTT\n\n00:00:01.500 --> 00:00:02.200\n<v A>'));
    check('text format', cuesToText(cues).startsWith('[00:00:01] A: こんにちは。'));
    // last word whose time runs on into a cut pause is kept; punctuation does not stretch the cue
    const tr2 = [{ name: 'A', map: { a: 1, b: 0 }, units: [{ text: '作って', start: 1, end: 1.5 }, { text: 'みました', start: 1.5, end: 4.0 }, { text: '。', start: 4.0, end: 9.0 }] }];
    const toOut = (T) => (T > 2.5 && T < 8 ? null : T < 2.5 ? T : T - 5.5);
    const toClamp = (T) => (T > 2.5 && T < 8 ? 2.5 : T < 2.5 ? T : T - 5.5);
    const c2 = buildCues(tr2, [], toOut, { toOutClamp: toClamp });
    check('a word running into a cut pause is kept, cue ends at the cut', c2.length === 1 && c2[0].text === '作ってみました。' && Math.abs(c2[0].end - 2.5) < 1e-9, JSON.stringify(c2));
  }
  {
    // evaluation helper: labels from Audacity, scoring of candidates
    const labels = parseAudacityLabels(['1.00\t1.40\tえー', '\\\t100\t2000', '5.0\t5.3\tあの', '9.0\t9.5\tえっと', ''].join('\n'));
    check('Audacity labels are read (spectral lines skipped)', labels.length === 3 && labels[0].cls === 'auto' && labels[1].cls === 'review', JSON.stringify(labels));
    const cands = [
      { track: 0, start: 1.05, end: 1.42, cls: 'auto', sources: ['text'], enabled: true, text: 'えー' }, // hit, cut
      { track: 0, start: 5.0, end: 5.25, cls: 'review', sources: ['text'], enabled: false, text: 'あの' }, // hit, kept
      { track: 0, start: 7.0, end: 7.3, cls: 'auto', sources: ['gap', 'sound'], enabled: true, text: '（伸ばす音）' }, // wrong cut
    ];
    const r = evaluate(cands, [labels]);
    check('evaluation counts hits, wrong cuts and misses', r.allCandidates.tp === 2 && r.allCandidates.fp === 1 && r.allCandidates.fn === 1 && r.adoptedByDefault.fp === 1 && r.wrongCuts.length === 1 && r.missed[0].text === 'えっと',
      JSON.stringify({ a: r.allCandidates, d: r.adoptedByDefault }));
  }
  {
    // scoring from in-app answers
    const F = (track, start, cls, sources, verdict, defaultEnabled) => ({ track, start, end: start + 0.4, cls, sources, verdict, defaultEnabled, text: 'x' });
    const fillers = [
      F(0, 610, 'auto', ['text'], 'yes', true),
      F(0, 620, 'auto', ['gap', 'sound'], 'no', true), // wrong cut
      F(0, 630, 'review', ['text'], 'yes', false),
      F(1, 640, 'review', ['gap'], undefined, false), // not judged
      F(1, 650, 'auto', ['manual'], 'yes', false), // missed, added by hand
      F(0, 100, 'auto', ['text'], 'no', true), // outside the range
    ];
    const r = evaluateVerdicts(fillers, [[600, 900], [600, 900]]);
    check('scores from answers: precision, recall, wrong cuts', r.judged === 3 && r.unjudged === 1 && Math.abs(r.precision - 2 / 3) < 1e-9 && Math.abs(r.recall - 2 / 3) < 1e-9 && r.cutByDefault.wrong === 1 && Math.abs(r.cutByDefault.recall - 1 / 3) < 1e-9,
      JSON.stringify({ p: r.precision, rc: r.recall, cut: r.cutByDefault }));
    // a key press 0.3 s after a short sound picks that sound
    const core = new Uint8Array(1000);
    core.fill(1, 100, 300); // words 1-3 s
    core.fill(1, 340, 380); // "えー" 3.4-3.8 s
    const levels = Float32Array.from(core, (c) => (c ? -20 : -70));
    const m = manualFillerAt(4.1, core, levels);
    check('a missed filler added by key press snaps to the sound just before', m.start >= 3.3 && m.start <= 3.45 && m.end >= 3.75 && m.end <= 3.9, JSON.stringify(m));
  }
  {
    // hand edits from the track editor
    const n = 2000;
    const core = [new Uint8Array(n), new Uint8Array(n)];
    core[0].fill(1, 100, 500);
    core[1].fill(1, 800, 1200); // 3 s pause between 5 s and 8 s
    core[0].fill(1, 1400, 1800);
    const acts = core.map((c) => padActivity(c));
    const base = buildPlan(acts, n, DEFAULT_SETTINGS, { coresRef: core });
    const pause = base.cuts.find((c) => c.type === 'pause' && c.start > 500 && c.end < 800);
    const p = buildPlan(acts, n, DEFAULT_SETTINGS, {
      coresRef: core,
      manualCuts: [{ id: 'c1', start: 1000, end: 1100 }],
      manualMutes: [{ id: 'm1', track: 0, start: 1500, end: 1550 }],
      disabledCuts: new Set([pause.key]),
    });
    const d = (p.inputDuration - p.outputDuration) - (base.inputDuration - base.outputDuration);
    const expect = 1.0 - (pause.end - pause.start) / 100;
    check('a hand cut shortens the programme; a restored pause is kept', Math.abs(d - expect) < 1e-9 && p.cuts.find((c) => c.key === pause.key).enabled === false, `${d.toFixed(2)} vs ${expect.toFixed(2)}`);
    check('a hand mute silences only that track and keeps the time', p.mutes.some((m) => m.mode === 'manual' && m.track === 0 && m.start === 1500) && p.counts.manualMute === 1);
    const env = gatesWithMutes([new Float32Array(n).fill(1), new Float32Array(n).fill(1)], p.mutes);
    check('hand-muted frames are silent', env[0][1520] === 0 && env[1][1520] === 1);
    const same = buildPlan(acts, n, DEFAULT_SETTINGS, { coresRef: core });
    check('automatic cut keys stay the same between rebuilds', same.cuts.map((c) => c.key).join() === base.cuts.map((c) => c.key).join());
  }
}
