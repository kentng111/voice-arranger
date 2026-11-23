// Scoring filler detection against a person's judgement. No browser APIs here.
//
// "Answer" mode (inside the app): within an evaluation range the user marks each candidate
// as a filler (verdict 'yes') or not ('no'), and adds the fillers that were missed
// (candidates with source 'manual'). From that:
//   precision = real fillers among the candidates
//   recall    = found fillers / (found + added by hand)
//   wrong cuts = candidates cut by default that are not fillers (the most harmful error)

const isManual = (f) => f.sources.includes('manual');

/**
 * fillers: [{ track, start, end, cls, sources, enabled, verdict?, defaultEnabled? }] (track time)
 * ranges: per track [start, end) in that track's own time
 */
export function evaluateVerdicts(fillers, ranges) {
  const inRange = (f) => {
    const r = ranges[f.track];
    return r && f.start >= r[0] && f.start < r[1];
  };
  const all = fillers.filter(inRange);
  const cands = all.filter((f) => !isManual(f));
  const added = all.filter((f) => isManual(f) && f.verdict !== 'no');
  const judged = cands.filter((f) => f.verdict === 'yes' || f.verdict === 'no');
  const yes = judged.filter((f) => f.verdict === 'yes');
  const no = judged.filter((f) => f.verdict === 'no');
  const byDefault = (f) => (f.defaultEnabled != null ? f.defaultEnabled : f.cls === 'auto');
  const cut = judged.filter(byDefault);
  const cutYes = cut.filter((f) => f.verdict === 'yes');
  const groups = (keyOf) => {
    const out = {};
    for (const f of judged) {
      const k = keyOf(f);
      out[k] = out[k] || { n: 0, yes: 0 };
      out[k].n++;
      if (f.verdict === 'yes') out[k].yes++;
    }
    return out;
  };
  const ratio = (a, b) => (b ? a / b : NaN);
  return {
    candidates: cands.length,
    judged: judged.length,
    unjudged: cands.length - judged.length,
    fillersFound: yes.length,
    notFillers: no.length,
    addedByHand: added.length,
    precision: ratio(yes.length, judged.length),
    recall: ratio(yes.length, yes.length + added.length),
    cutByDefault: { n: cut.length, correct: cutYes.length, wrong: cut.length - cutYes.length, precision: ratio(cutYes.length, cut.length), recall: ratio(cutYes.length, yes.length + added.length) },
    bySource: groups((f) => [...f.sources].sort().join('+')),
    byClass: groups((f) => f.cls),
    wrongCuts: cut.filter((f) => f.verdict === 'no').map((f) => ({ track: f.track, start: f.start, end: f.end, text: f.text, sources: f.sources.join('+') })),
  };
}

// ---------------------------------------------------------------- Audacity labels

export function parseAudacityLabels(text, classify = () => 'other') {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('\\')) continue; // "\" lines = frequency range of spectral labels
    const [a, b, ...rest] = line.split('\t');
    const start = parseFloat(a);
    const end = parseFloat(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const label = rest.join('\t').trim();
    out.push({ start, end: Math.max(end, start + 0.05), text: label, cls: classify(label) || 'other' });
  }
  return out;
}
