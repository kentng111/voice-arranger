// Per-track "gate": lowers a track while its speaker is silent, which removes most of the
// background noise and the other people's voices leaking into that phone.

/**
 * actRef: Uint8Array activity on the common timeline (10 ms frames).
 * gateDb: attenuation while silent (e.g. -15). 0 disables the gate.
 * Returns linear gain per frame.
 */
export function gateEnvelope(actRef, gateDb, releaseMs = 200) {
  const n = actRef.length;
  const env = new Float32Array(n);
  if (!(gateDb < -0.01)) {
    env.fill(1);
    return env;
  }
  const step = -gateDb / (releaseMs / 10); // dB per frame while closing
  let cur = gateDb;
  for (let f = 0; f < n; f++) {
    const openSoon = actRef[f] || (f + 1 < n && actRef[f + 1]) || (f + 2 < n && actRef[f + 2]);
    if (openSoon) cur = 0;
    else cur = Math.max(gateDb, cur - step);
    env[f] = Math.pow(10, cur / 20);
  }
  return env;
}

/**
 * Gate envelopes with the plan's muted fillers silenced (copies only the tracks that change).
 * mutes: [{ track, start, end }] in frames on the common timeline.
 */
export function gatesWithMutes(gates, mutes = []) {
  if (!mutes || !mutes.length) return gates;
  const out = gates.slice();
  for (const m of mutes) {
    const env = out[m.track];
    if (!env) continue;
    if (env === gates[m.track]) out[m.track] = Float32Array.from(env);
    out[m.track].fill(0, Math.max(0, m.start), Math.min(env.length, m.end));
  }
  return out;
}
