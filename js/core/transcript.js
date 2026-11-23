// Common transcript format shared by every recognition engine (browser Whisper now,
// possibly a cloud API later), plus filler words and subtitle export.
// No browser APIs here.
//
// Transcript:
//   { version: 1, engine, model, language: 'ja', createdAt,
//     tracks: [{ units: [{ text, start, end }] }] }
// Times are seconds in the track's OWN file (not the common timeline), so the transcript
// stays valid when the sync is adjusted. A "unit" is the smallest piece of text an engine
// gives a time for (for Whisper on Japanese: one or a few characters).

export const TRANSCRIPT_VERSION = 1;

// ---------------------------------------------------------------- Whisper tokens -> units

/**
 * Turn Whisper output tokens + per-token times into units.
 * decode(ids) -> string. Token i is spoken from times[i] to times[i + 1].
 * Special tokens (>= specialFrom, e.g. <|endoftext|>, language tags, timestamps) are skipped.
 * Tokens are grouped until they decode to complete characters (Japanese characters are often
 * split across byte-level tokens).
 */
export function collateWhisperTokens(tokens, times, decode, specialFrom, offset = 0) {
  const units = [];
  let cur = [];
  let curStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = Number(tokens[i]);
    if (t >= specialFrom) {
      cur = [];
      continue;
    }
    if (!cur.length) curStart = times[i];
    cur.push(t);
    const text = decode(cur);
    if (text.includes('�') && cur.length < 6) continue;
    const end = i + 1 < times.length && times[i + 1] > curStart ? times[i + 1] : curStart + 0.08;
    const clean = text.replace(/�/g, '');
    if (clean.trim()) units.push({ text: clean.trim(), start: round3(curStart + offset), end: round3(end + offset) });
    cur = [];
  }
  return units;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Whisper sometimes loops ("ありがとうありがとう…") on noise. Drop a chunk's tail once the
 * same short text repeats too often, and drop units that run faster than speech can.
 */
export function cleanupUnits(units) {
  const out = [];
  let rep = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (out.length && out[out.length - 1].text === u.text) {
      if (++rep >= 6) break;
    } else rep = 0;
    out.push(u);
  }
  // monotonic times
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
    if (out[i].end < out[i].start) out[i].end = out[i].start;
  }
  return out;
}

/**
 * Drop units that are really another person's voice leaking into this phone.
 * Only the frames where this track's own speech detector is on are looked at (Whisper's
 * times run on into silences); a unit is dropped when it has no such frames, or when in
 * most of them some other track is much louder relative to its own speech level.
 * levels / cores: per-track frame levels (dB) and speech flags (track-local, 10 ms);
 * speechDb: per-track speech level; maps: per-track { a, b } (fileTime = a * T + b).
 */
export function dropLeakedUnits(units, k, levels, cores, speechDb, maps, { share = 0.7, frameRate = 100, foreign = null } = {}) {
  const fm = foreign || foreignFrames(k, levels, cores, speechDb, maps, { frameRate });
  return units.filter((u) => {
    if (isPunct(u.text)) return true;
    const f0 = Math.floor(u.start * frameRate);
    const f1 = Math.max(f0 + 1, Math.ceil(u.end * frameRate));
    let own = 0;
    let louder = 0;
    for (let f = f0; f < f1; f++) {
      if (!cores[k][f]) continue;
      own++;
      if (fm[f]) louder++;
    }
    if (!own) return u.end - u.start < 0.15; // tiny units at speech edges are kept
    return louder / own < share;
  });
}

/**
 * Frames of track k (track-local) where what this phone picks up is most likely someone
 * else's voice: it is quiet compared with this person's normal speech, and at the same
 * moment another track is much louder compared with that person's normal speech.
 */
export function foreignFrames(k, levels, cores, speechDb, maps, { marginDb = 10, quietDb = -15, frameRate = 100 } = {}) {
  const n = levels[k].length;
  const out = new Uint8Array(n);
  for (let f = 0; f < n; f++) {
    if (!cores[k][f]) continue;
    const mine = levels[k][f] - speechDb[k];
    if (mine > quietDb) continue; // clearly this person's own voice
    const T = (f / frameRate - maps[k].b) / maps[k].a;
    for (let j = 0; j < levels.length; j++) {
      if (j === k) continue;
      const g = Math.round((maps[j].a * T + maps[j].b) * frameRate);
      if (g < 0 || g >= levels[j].length) continue;
      if (levels[j][g] - speechDb[j] - mine > marginDb) { out[f] = 1; break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- text normalisation

const PUNCT = /^[、。，．,.!?！？…・「」『』（）()\[\]{}"'“”‘’\s〜～-]+$/;

export function isPunct(text) {
  return PUNCT.test(text);
}

/** Katakana -> hiragana, full-width ASCII -> ASCII, long vowel marks unified, lower case. */
export function normalizeJa(text) {
  let s = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x30a1 && c <= 0x30f6) s += String.fromCodePoint(c - 0x60);
    else if (c >= 0xff01 && c <= 0xff5e) s += String.fromCodePoint(c - 0xfee0);
    else s += ch;
  }
  return s
    .toLowerCase()
    .replace(/[〜～~－―‐-]/g, 'ー')
    .replace(/[、。，．,.!?！？…・\s]/g, '')
    .replace(/ー+/g, 'ー');
}

// ---------------------------------------------------------------- filler words

// "auto": almost always a filler -> proposed for removal.
// "review": often a filler, but also an ordinary word -> needs a human decision.
// Whisper tends to write a drawn-out "えー" as a Latin letter ("A", "E"), so single
// letters count as fillers too.
const AUTO = [
  /^えー$/, /^ええー+$/, /^えーと$/, /^えっと$/, /^えーっと$/, /^えと$/, /^ええ?っ?と$/,
  /^あー$/, /^あーあ$/, /^うーん$/, /^うーむ$/, /^うー$/, /^ん+ー$/, /^んん+$/, /^うん?ーん$/,
  /^ま[ーあ]ー$/,
  /^[aeu]ー?$/, /^[ae]ー?っ?と$/, /^え$/, /^あ$/,
];
// "ええ" (yes) and "ああ" (I see) are often real answers, so they are only suggestions.
// a lone short "ん" is usually a "yes" (backchannel), not a filler
const REVIEW = [/^ん$/, /^あの[ーお]?$/, /^その[ーお]?$/, /^まあ$/, /^まー$/, /^なんか[ーあ]?$/, /^ま$/, /^ええ$/, /^ああ$/];

/** 'auto' | 'review' | null for a piece of text. */
export function fillerClass(text) {
  const n = normalizeJa(text);
  if (!n) return null;
  if (AUTO.some((r) => r.test(n))) return 'auto';
  if (REVIEW.some((r) => r.test(n))) return 'review';
  return null;
}

/** Group units into phrases separated by punctuation or by silences longer than gapSec. */
export function phrasesOf(units, gapSec = 0.6) {
  const phrases = [];
  let cur = null;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (isPunct(u.text)) {
      if (cur) cur.punctAfter = true;
      cur = null;
      continue;
    }
    if (cur && u.start - cur.end > gapSec) cur = null;
    if (!cur) {
      cur = { first: i, last: i, start: u.start, end: u.end, punctAfter: false };
      phrases.push(cur);
    } else {
      cur.last = i;
      cur.end = u.end;
    }
  }
  return phrases;
}

/**
 * Filler words found in the text. Returns [{ first, last, start, end, text, cls }] (unit indices).
 * Whisper often leaves out punctuation, so fillers are also searched inside phrases:
 * - a whole phrase that is a filler ("まあ、", "えー、")
 * - an unmistakable filler anywhere ("えー", "えっと", "うーん", a lone Latin "A" = "えー")
 * - other fillers ("あの", "まあ", a lone "あ") only at the start of a phrase or right after
 *   another filler, and only when a pause or a drawn-out sound follows them
 *   ("あの　ポッドキャスト" yes, "あのポッドキャスト" no, "ありがとう" never)
 */
export function findTextFillers(units, { pauseAfter = 0.15, longSec = 0.5 } = {}) {
  const found = [];
  for (const p of phrasesOf(units)) {
    let prevFiller = false;
    let i = p.first;
    while (i <= p.last) {
      let best = null;
      let txt = '';
      for (let j = i; j <= Math.min(p.last, i + 3); j++) {
        txt += units[j].text;
        const c = fillerClass(txt);
        if (!c) continue;
        const n = normalizeJa(txt);
        const atStart = i === p.first || prevFiller;
        const gap = j < p.last ? units[j + 1].start - units[j].end : Infinity;
        const long = units[j].end - units[j].start > longSec;
        const tailOk = j === p.last || gap >= pauseAfter || long;
        const sure = c === 'auto' && ((n.length >= 2 && !/^[aeu]/.test(n)) || /^[aeu]ー?(っ?と)?$/.test(n) && /^[A-Za-zＡ-Ｚａ-ｚ]/.test(units[i].text.trim()));
        const ok = (i === p.first && j === p.last) || sure || (atStart && tailOk) || (c === 'review' && long);
        if (ok) best = { first: i, last: j, start: units[i].start, end: units[j].end, text: txt, cls: c };
      }
      if (best) {
        found.push(best);
        prevFiller = true;
        i = best.last + 1;
      } else {
        prevFiller = false;
        i++;
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------- subtitles / text export

/**
 * Build cues on the edited timeline.
 * tracks: [{ name, units, map }]  (map: fileTime = a * T + b)
 * fillers: [{ track, start, end, enabled }] in track time; enabled fillers are left out of the text.
 * toOut(T) -> edited time, or null when T is inside a cut. A unit is kept when its START is
 * kept (Whisper's end times often run on into a pause that was cut).
 * toOutClamp(T) -> edited time, mapping times inside a cut to the cut point (for end times).
 */
export function buildCues(tracks, fillers, toOut, { toOutClamp = toOut, maxDur = 7, maxChars = 42, gapSec = 1.0, maxUnitSec = 1.2 } = {}) {
  const cues = [];
  tracks.forEach((t, k) => {
    const removed = fillers.filter((f) => f.track === k && f.enabled);
    const isRemoved = (u) => {
      const mid = (u.start + u.end) / 2;
      return removed.some((f) => mid >= (f.textStart ?? f.start) && mid <= (f.textEnd ?? f.end));
    };
    let cur = null;
    const flush = () => {
      if (cur && cur.text.replace(/[、。？！?!\s]/g, '')) cues.push({ ...cur, text: cur.text.replace(/^[、。]+/, '').replace(/、$/, '') });
      cur = null;
    };
    let afterRemoved = false;
    for (const u of t.units) {
      if (isRemoved(u)) {
        afterRemoved = true;
        continue;
      }
      const punct = isPunct(u.text);
      // the comma that followed a removed filler ("えー、") goes with it
      if (afterRemoved && /^[、,]$/.test(u.text)) continue;
      afterRemoved = false;
      const T0 = (u.start - t.map.b) / t.map.a;
      const o0 = toOut(T0);
      if (o0 == null) {
        if (punct && cur) cur.text += u.text;
        continue;
      }
      const dur = Math.min(u.end - u.start, punct ? 0 : maxUnitSec);
      const o1raw = toOutClamp(T0 + dur / t.map.a);
      const o1 = o1raw == null ? o0 + dur : Math.max(o0, o1raw);
      if (cur && !punct && (o0 - cur.end > gapSec || o1 - cur.start > maxDur || cur.text.length >= maxChars)) flush();
      if (!cur) {
        if (punct) continue;
        cur = { track: k, speaker: t.name, start: o0, end: o1, text: '' };
      }
      cur.text += u.text;
      if (!punct) cur.end = Math.max(cur.end, o1);
      if (/[。？！?!]$/.test(u.text)) flush();
    }
    flush();
  });
  cues.sort((a, b) => a.start - b.start || a.track - b.track);
  return cues;
}

function tc(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(f).padStart(3, '0')}`;
}

export function cuesToSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${tc(c.start, ',')} --> ${tc(c.end, ',')}\n${c.speaker}: ${c.text}\n`).join('\n');
}

export function cuesToVtt(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${tc(c.start, '.')} --> ${tc(c.end, '.')}\n<v ${c.speaker}>${c.text}\n`).join('\n');
}

/** Plain text: consecutive cues of the same speaker are joined into one paragraph. */
export function cuesToText(cues) {
  const lines = [];
  let last = null;
  for (const c of cues) {
    if (last && last.track === c.track && c.start - last.end < 2.5) {
      last.text += c.text;
      last.end = c.end;
    } else {
      last = { ...c };
      lines.push(last);
    }
  }
  return lines.map((l) => `[${tc(l.start, '.').slice(0, 8)}] ${l.speaker}: ${l.text}`).join('\n') + '\n';
}
