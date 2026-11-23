"""Synthetic test recordings for Voice Arranger.

Simulates a remote conversation between several people. Each person's phone records
their own voice; recordings start at different times, one phone's clock can drift,
and one person can be set up without headphones so the others leak into their track.
Speech is synthetic (pitched, syllable-shaped bursts) — enough to test sync, pause
shortening and loudness, not speech recognition.

usage: python make_test_audio.py OUT_DIR [--minutes 10] [--sr 48000] [--seed 1]
       [--drift-ppm 0,0,60] [--starts 0,4.2,-2.7] [--bleed 0,0,1] [--m4a] [--wav16k]
"""
import argparse
import json
import os
import subprocess

import numpy as np

SPEAKERS = [
    {"name": "A", "f0": 120.0, "level": 0.30, "noise_db": -60.0},
    {"name": "B", "f0": 210.0, "level": 0.20, "noise_db": -54.0},
    {"name": "C", "f0": 165.0, "level": 0.36, "noise_db": -58.0, "hum": True},
    {"name": "D", "f0": 240.0, "level": 0.25, "noise_db": -57.0},
]


def synth_utterance(dur, f0, rng, sr):
    n = max(1, int(dur * sr))
    t = np.arange(n, dtype=np.float32) / sr
    env = np.zeros(n, dtype=np.float32)
    pos = 0
    while pos < n:
        syl = int(rng.uniform(0.12, 0.26) * sr)
        gap = int(rng.uniform(0.02, 0.07) * sr)
        syl = min(syl, n - pos)
        if syl <= 0:
            break
        a = rng.uniform(0.45, 1.0)
        env[pos:pos + syl] = a * np.sin(np.pi * np.arange(syl) / syl) ** 0.6
        pos += syl + gap
    contour = f0 * (1 + 0.08 * np.sin(2 * np.pi * 0.9 * t + rng.uniform(0, 6.28))) * (1 - 0.15 * t / max(dur, 1e-3))
    phase = 2 * np.pi * np.cumsum(contour) / sr
    H = int(min(12, (0.45 * sr) // f0))
    sig = np.zeros(n, dtype=np.float32)
    for h in range(1, H + 1):
        sig += (1.0 / h ** 1.1) * np.sin(h * phase).astype(np.float32)
    sig /= np.max(np.abs(sig)) + 1e-9
    noise = rng.normal(0, 0.08, n).astype(np.float32)
    noise[1:] -= noise[:-1].copy()
    return env * (0.85 * sig + noise)


def make_schedule(total, n_spk, rng, latency):
    events = []
    t = 2.0
    cur = 0
    while t < total - 6:
        turn_target = t + rng.lognormal(np.log(6.0), 0.6)
        last_end = t
        while t < turn_target and t < total - 4:
            d = rng.uniform(0.8, 3.5)
            events.append({"spk": cur, "start": t, "end": t + d, "kind": "speech"})
            for other in range(n_spk):
                if other != cur and rng.random() < 0.12:
                    bt = t + rng.uniform(0.3, d) + latency
                    events.append({"spk": other, "start": bt, "end": bt + rng.uniform(0.2, 0.4), "kind": "back"})
            last_end = t + d
            r = rng.random()
            if r < 0.65:
                pause = rng.uniform(0.2, 0.6)
            elif r < 0.93:
                pause = rng.uniform(0.8, 1.8)
            else:
                pause = rng.uniform(2.0, 3.5)
            t = last_end + pause
        nxt = int(rng.choice([k for k in range(n_spk) if k != cur]))
        gap = latency + max(-0.5, rng.normal(0.3, 0.3))
        t = last_end + gap
        cur = nxt
    return events


def lowpass(x, sr, fc=3500.0):
    """One-pole low-pass (laptop speaker colouring for leaked voices)."""
    from scipy.signal import lfilter
    a = np.exp(-2 * np.pi * fc / sr)
    return lfilter([1 - a], [1, -a], x).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--minutes", type=float, default=10)
    ap.add_argument("--sr", type=int, default=48000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--speakers", type=int, default=3)
    ap.add_argument("--latency", type=float, default=0.25)
    ap.add_argument("--drift-ppm", default="0,0,60")
    ap.add_argument("--starts", default="0,4.2,-2.7")
    ap.add_argument("--bleed", default="0,0,1")
    ap.add_argument("--m4a", action="store_true")
    ap.add_argument("--alac", action="store_true")
    ap.add_argument("--wav16k", action="store_true")
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    sr = args.sr
    n_spk = args.speakers
    total = args.minutes * 60
    drift = [float(x) for x in args.drift_ppm.split(",")][:n_spk]
    starts = [float(x) for x in args.starts.split(",")][:n_spk]
    bleed = [int(x) for x in args.bleed.split(",")][:n_spk]
    os.makedirs(args.out, exist_ok=True)

    margin = 10.0
    wall0 = min(starts) - 1.0  # wall time of array index 0
    n_wall = int((total + margin - wall0) * sr)
    events = make_schedule(total, n_spk, rng, args.latency)

    own = [np.zeros(n_wall, dtype=np.float32) for _ in range(n_spk)]
    for ev in events:
        spk = SPEAKERS[ev["spk"]]
        dur = ev["end"] - ev["start"]
        x = synth_utterance(dur, spk["f0"] * rng.uniform(0.95, 1.05), rng, sr)
        lvl = spk["level"] * (0.6 if ev["kind"] == "back" else 1.0) * 10 ** (rng.uniform(-3, 3) / 20)
        i0 = int((ev["start"] - wall0) * sr)
        i1 = min(n_wall, i0 + len(x))
        own[ev["spk"]][i0:i1] += lvl * x[: i1 - i0]

    tracks_meta = []
    for k in range(n_spk):
        spk = SPEAKERS[k]
        sig = own[k].copy()
        noise = rng.normal(0, 1, n_wall).astype(np.float32)
        from scipy.signal import lfilter
        noise = lfilter([0.05, 0.05], [1, -0.95], noise).astype(np.float32)  # brownish
        noise *= 10 ** (spk["noise_db"] / 20) / (np.std(noise) + 1e-9)
        sig += noise
        if spk.get("hum"):
            t = np.arange(n_wall, dtype=np.float32) / sr
            sig += (10 ** (-62 / 20)) * np.sin(2 * np.pi * 50 * t).astype(np.float32)
        if bleed[k]:
            d = int((args.latency + 0.01) * sr)
            for j in range(n_spk):
                if j == k:
                    continue
                leak = np.zeros(n_wall, dtype=np.float32)
                leak[d:] = own[j][:-d]
                sig += 10 ** (-26 / 20) * lowpass(leak, sr)
        # device recording: starts at starts[k], ends a few seconds after the talk
        r_start = starts[k]
        r_end = total + 2.0 + 1.5 * k
        eps = drift[k] * 1e-6
        n_file = int((r_end - r_start) * (1 + eps) * sr)
        tau = np.arange(n_file, dtype=np.float64) / sr
        r = r_start + tau / (1 + eps)
        pos = (r - wall0) * sr
        rec = np.interp(pos, np.arange(n_wall, dtype=np.float64), sig).astype(np.float32)
        rec = np.clip(rec, -1, 1)
        name = f"track{k + 1}_{spk['name']}"
        wav_path = os.path.join(args.out, name + ".wav")
        import wave
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((rec * 32767).astype("<i2").tobytes())
        files = {"wav": wav_path}
        if args.m4a:
            p = os.path.join(args.out, name + ".m4a")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-ar", "48000", "-c:a", "aac", "-b:a", "64k", p], check=True)
            files["m4a"] = p
        if args.alac:
            p = os.path.join(args.out, name + "_alac.m4a")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-ar", "48000", "-c:a", "alac", p], check=True)
            files["alac"] = p
        if args.wav16k:
            src = files.get("m4a", wav_path)
            p = os.path.join(args.out, name + "_16k.wav")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", p], check=True)
            files["wav16k"] = p
        tracks_meta.append({"name": name, "start_wall": r_start, "end_wall": r_end, "drift_ppm": drift[k], "bleed": bool(bleed[k]), "files": files})

    truth = {
        "minutes": args.minutes,
        "sr": sr,
        "latency": args.latency,
        "tracks": tracks_meta,
        "events": events,
    }
    with open(os.path.join(args.out, "truth.json"), "w") as f:
        json.dump(truth, f, indent=1)
    print(json.dumps({k: v for k, v in truth.items() if k != "events"}, indent=1))
    print("events:", len(events))


if __name__ == "__main__":
    main()
