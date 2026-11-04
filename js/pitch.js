/**
 * Monophonic pitch detector for guitar, E2 through A4.
 * Time-domain YIN on a 4x averaged copy of the microphone buffer.
 */

const DECIMATE = 4;
const THRESHOLD = 0.15;

export function detectPitch(input, sampleRate) {
  const n = input.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += input[i] * input[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.004) {
    return { rms, frequency: null, confidence: 0 };
  }

  const sr = sampleRate / DECIMATE;
  const m = Math.floor(n / DECIMATE);
  const buf = new Float32Array(m);
  let mean = 0;
  for (let i = 0; i < m; i++) {
    const base = i * DECIMATE;
    let sum = 0;
    for (let k = 0; k < DECIMATE; k++) sum += input[base + k];
    buf[i] = sum / DECIMATE;
    mean += buf[i];
  }
  mean /= m;
  for (let i = 0; i < m; i++) buf[i] -= mean;

  const tauMin = Math.max(2, Math.floor(sr / 520));
  const tauMax = Math.min(m - 2, Math.floor(sr / 70));
  if (tauMax <= tauMin) {
    return { rms, frequency: null, confidence: 0 };
  }

  const diff = new Float32Array(tauMax + 1);
  const compare = m - tauMax;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < compare; i++) {
      const delta = buf[i] - buf[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau];
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < THRESHOLD) {
      tau = t;
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      break;
    }
  }

  if (tau < 0) {
    let best = 1;
    let bestTau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < best) {
        best = cmnd[t];
        bestTau = t;
      }
    }
    if (bestTau < 0 || best > 0.22) {
      return { rms, frequency: null, confidence: 1 - best };
    }
    tau = bestTau;
  }

  const s0 = cmnd[tau - 1];
  const s1 = cmnd[tau];
  const s2 = cmnd[tau + 1];
  const denom = 2 * (s0 - 2 * s1 + s2);
  let better = tau;
  if (denom !== 0) better = tau + (s0 - s2) / denom;
  if (!Number.isFinite(better) || better < tau - 1 || better > tau + 1) better = tau;

  return {
    rms,
    frequency: sr / better,
    confidence: Math.max(0, 1 - s1),
  };
}

function synthesize(freq, sampleRate, length, harmonics) {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (let h = 0; h < harmonics.length; h++) {
      sample += harmonics[h] * Math.sin(2 * Math.PI * freq * (h + 1) * t);
    }
    buf[i] = sample;
  }
  return buf;
}

export function runPitchSelfTest() {
  const sampleRate = 48000;
  const length = 4096;
  const targets = [82.41, 87.31, 110, 146.83, 164.81, 196, 246.94, 329.63, 369.99, 440];
  const kinds = [
    { name: "pure", harmonics: [0.8] },
    { name: "harmonic", harmonics: [0.55, 0.35, 0.22, 0.12] },
    { name: "thin-fundamental", harmonics: [0.2, 0.55, 0.4, 0.25, 0.15] },
    { name: "missing-fundamental", harmonics: [0, 0.35, 0.55, 0.28, 0.18] },
  ];
  const failures = [];

  for (const freq of targets) {
    for (const kind of kinds) {
      const found = detectPitch(synthesize(freq, sampleRate, length, kind.harmonics), sampleRate);
      const ok = found.frequency != null && Math.abs(found.frequency - freq) / freq < 0.02;
      if (!ok) {
        failures.push({
          freq,
          kind: kind.name,
          got: found.frequency,
          confidence: found.confidence,
        });
      }
    }
  }

  let state = 1;
  const noise = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    state = (state * 16807) % 2147483647;
    noise[i] = ((state / 2147483647) * 2 - 1) * 0.2;
  }
  const noiseResult = detectPitch(noise, sampleRate);
  if (noiseResult.frequency != null && noiseResult.confidence > 0.85) {
    failures.push({ freq: 0, kind: "noise", got: noiseResult.frequency, confidence: noiseResult.confidence });
  }

  const silence = detectPitch(new Float32Array(length), sampleRate);
  if (silence.frequency != null) {
    failures.push({ freq: 0, kind: "silence", got: silence.frequency, confidence: silence.confidence });
  }

  return failures;
}
