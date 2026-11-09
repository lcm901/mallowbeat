(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MallowAnalysis = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EPS = 1e-9;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mean(values) {
    if (!values.length) return 0;
    let total = 0;
    for (const v of values) total += v;
    return total / values.length;
  }
  function standardDeviation(values, knownMean) {
    if (!values.length) return 0;
    const m = Number.isFinite(knownMean) ? knownMean : mean(values);
    let total = 0;
    for (const v of values) { const d = v - m; total += d * d; }
    return Math.sqrt(total / values.length);
  }
  function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = Array.from(values).sort((a, b) => a - b);
    const index = clamp(p, 0, 1) * (sorted.length - 1);
    const lo = Math.floor(index);
    const hi = Math.ceil(index);
    if (lo === hi) return sorted[lo];
    return lerp(sorted[lo], sorted[hi], index - lo);
  }
  function movingAverage(values, radius) {
    const out = new Float32Array(values.length);
    const prefix = new Float64Array(values.length + 1);
    for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
    for (let i = 0; i < values.length; i++) {
      const a = Math.max(0, i - radius);
      const b = Math.min(values.length, i + radius + 1);
      out[i] = (prefix[b] - prefix[a]) / Math.max(1, b - a);
    }
    return out;
  }
  function robustNormalize(values, lowP = 0.08, highP = 0.95) {
    if (!values.length) return new Float32Array(0);
    const lo = percentile(values, lowP);
    const hi = percentile(values, highP);
    const span = Math.max(EPS, hi - lo);
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = clamp((values[i] - lo) / span, 0, 1.25);
    return out;
  }
  function hashString(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function monoSample(buffer, index) {
    const i = clamp(index | 0, 0, buffer.length - 1);
    let v = 0;
    const channels = Math.max(1, buffer.numberOfChannels || 1);
    for (let c = 0; c < channels; c++) v += buffer.getChannelData(c)[i] || 0;
    return v / channels;
  }

  /**
   * Extract low-cost musical descriptors. This deliberately samples each frame
   * instead of copying/resampling the entire song, keeping long MP3s manageable.
   */
  function extractEnvelope(buffer, options = {}) {
    const fps = options.fps || 50;
    const start = clamp(options.start || 0, 0, Math.max(0, buffer.duration - 0.01));
    const duration = clamp(options.duration || (buffer.duration - start), 0.01, buffer.duration - start);
    const probes = options.probes || 72;
    const frameCount = Math.max(1, Math.floor(duration * fps));
    const energyRaw = new Float32Array(frameCount);
    const textureRaw = new Float32Array(frameCount);
    const asymmetryRaw = new Float32Array(frameCount);
    const sampleRate = buffer.sampleRate;
    const frameSamples = sampleRate / fps;
    const baseSample = Math.floor(start * sampleRate);

    let previousFrameValue = 0;
    for (let f = 0; f < frameCount; f++) {
      const frameStart = baseSample + Math.floor(f * frameSamples);
      const frameEnd = Math.min(buffer.length - 1, baseSample + Math.floor((f + 1) * frameSamples));
      const span = Math.max(1, frameEnd - frameStart);
      const count = Math.max(8, Math.min(probes, span));
      const step = span / count;
      let sumSq = 0;
      let diff = 0;
      let positive = 0;
      let last = previousFrameValue;
      for (let p = 0; p < count; p++) {
        const sample = monoSample(buffer, frameStart + Math.floor((p + 0.5) * step));
        sumSq += sample * sample;
        diff += Math.abs(sample - last);
        if (sample > 0) positive++;
        last = sample;
      }
      previousFrameValue = last;
      energyRaw[f] = Math.sqrt(sumSq / count);
      textureRaw[f] = diff / count;
      asymmetryRaw[f] = Math.abs((positive / count) - 0.5) * 2;
    }

    const energySmooth = movingAverage(energyRaw, Math.max(1, Math.round(fps * 0.055)));
    const textureSmooth = movingAverage(textureRaw, Math.max(1, Math.round(fps * 0.035)));
    const energy = robustNormalize(energySmooth, 0.06, 0.96);
    const texture = robustNormalize(textureSmooth, 0.06, 0.96);
    const onsetRaw = new Float32Array(frameCount);

    for (let i = 1; i < frameCount; i++) {
      const shortRise = Math.max(0, energySmooth[i] - energySmooth[Math.max(0, i - 2)]);
      const longRise = Math.max(0, energySmooth[i] - energySmooth[Math.max(0, i - Math.round(fps * 0.18))]);
      const textureRise = Math.max(0, textureSmooth[i] - textureSmooth[Math.max(0, i - 2)]);
      onsetRaw[i] = shortRise * 0.74 + longRise * 0.48 + textureRise * 0.22;
    }

    const onset = robustNormalize(movingAverage(onsetRaw, 1), 0.20, 0.985);
    const brightness = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      brightness[i] = clamp(texture[i] * 0.84 + asymmetryRaw[i] * 0.16, 0, 1);
    }

    return { fps, start, duration, energy, onset, brightness };
  }

  function quickTrackScore(buffer) {
    const duration = buffer.duration || 0;
    if (!Number.isFinite(duration) || duration < 8) return -Infinity;
    const env = extractEnvelope(buffer, { fps: 18, probes: 40 });
    const eMean = mean(env.energy);
    const eVar = standardDeviation(env.energy, eMean);
    const oMean = mean(env.onset);
    const oHigh = percentile(env.onset, 0.86);
    let silent = 0;
    for (const e of env.energy) if (e < 0.055) silent++;
    const silenceRatio = silent / env.energy.length;
    const durationFit = duration >= 90 ? 1 : clamp((duration - 8) / 82, 0, 1);
    const extremePenalty = duration > 25 * 60 ? Math.min(0.38, (duration - 25 * 60) / 3600) : 0;
    const score =
      eMean * 0.23 +
      eVar * 0.24 +
      oMean * 0.20 +
      oHigh * 0.24 +
      durationFit * 0.09 -
      silenceRatio * 0.44 -
      extremePenalty;
    return score;
  }

  function prefix(values, transform) {
    const out = new Float64Array(values.length + 1);
    for (let i = 0; i < values.length; i++) {
      const v = transform ? transform(values[i]) : values[i];
      out[i + 1] = out[i] + v;
    }
    return out;
  }
  function rangeMean(pref, a, b) {
    const lo = clamp(a | 0, 0, pref.length - 1);
    const hi = clamp(b | 0, lo + 1, pref.length - 1);
    return (pref[hi] - pref[lo]) / Math.max(1, hi - lo);
  }

  function selectSegment(overview, targetSeconds = 120) {
    const { fps, duration, energy, onset } = overview;
    const playDuration = Math.min(targetSeconds, duration);
    if (duration <= targetSeconds + 1.5) return { start: 0, duration: playDuration, score: 1 };

    const window = Math.max(1, Math.floor(targetSeconds * fps));
    const step = Math.max(1, Math.floor(fps));
    const ePref = prefix(energy);
    const e2Pref = prefix(energy, (v) => v * v);
    const oPref = prefix(onset);
    const silentPref = prefix(energy, (v) => (v < 0.07 ? 1 : 0));
    let best = { startFrame: 0, score: -Infinity };

    for (let a = 0; a + window <= energy.length; a += step) {
      const b = a + window;
      const eMean = rangeMean(ePref, a, b);
      const e2Mean = rangeMean(e2Pref, a, b);
      const eStd = Math.sqrt(Math.max(0, e2Mean - eMean * eMean));
      const oMean = rangeMean(oPref, a, b);
      const silence = rangeMean(silentPref, a, b);

      // Structural contrast between broad 8-second phrases.
      const block = Math.max(1, Math.floor(8 * fps));
      const blockMeans = [];
      for (let p = a; p < b; p += block) blockMeans.push(rangeMean(ePref, p, Math.min(b, p + block)));
      let structure = 0;
      for (let i = 1; i < blockMeans.length; i++) structure += Math.abs(blockMeans[i] - blockMeans[i - 1]);
      structure /= Math.max(1, blockMeans.length - 1);

      const firstThird = rangeMean(ePref, a, a + Math.floor(window / 3));
      const lastThird = rangeMean(ePref, b - Math.floor(window / 3), b);
      const arc = clamp((lastThird - firstThird + 0.35) / 0.7, 0, 1);
      const edgeDistance = Math.min(a / fps, duration - b / fps);
      const edgeComfort = clamp(edgeDistance / 9, 0, 1);

      const score =
        eMean * 0.27 + oMean * 0.25 + eStd * 0.22 + structure * 0.18 +
        arc * 0.04 + edgeComfort * 0.04 - silence * 0.48;
      if (score > best.score) best = { startFrame: a, score };
    }

    // Snap near a plausible phrase entrance: a low-energy breath followed by activity.
    const base = best.startFrame;
    const radius = Math.floor(fps * 4.5);
    let snapped = base;
    let boundaryBest = -Infinity;
    for (let i = Math.max(0, base - radius); i <= Math.min(energy.length - window, base + radius); i++) {
      const after = rangeMean(oPref, i, Math.min(onset.length, i + Math.floor(fps * 1.3)));
      const before = rangeMean(ePref, Math.max(0, i - Math.floor(fps * 0.7)), i + 1);
      const local = onset[i] || 0;
      const distancePenalty = Math.abs(i - base) / Math.max(1, radius) * 0.18;
      const score = after * 0.72 + local * 0.28 - before * 0.30 - distancePenalty;
      if (score > boundaryBest) { boundaryBest = score; snapped = i; }
    }

    const maxStart = Math.max(0, duration - playDuration);
    return {
      start: clamp(snapped / fps, 0, maxStart),
      duration: playDuration,
      score: best.score,
    };
  }

  function estimateTempo(env) {
    const { fps, onset, energy } = env;
    const centered = new Float32Array(onset.length);
    const base = percentile(onset, 0.42);
    for (let i = 0; i < onset.length; i++) centered[i] = Math.max(0, onset[i] - base);

    let bestLag = Math.round(fps * 0.5);
    let bestScore = -Infinity;
    const minBpm = 68;
    const maxBpm = 182;
    const minLag = Math.max(2, Math.floor((60 * fps) / maxBpm));
    const maxLag = Math.min(centered.length - 2, Math.ceil((60 * fps) / minBpm));

    for (let lag = minLag; lag <= maxLag; lag++) {
      let dot = 0, left = 0, right = 0, count = 0;
      for (let i = lag; i < centered.length; i++) {
        const a = centered[i];
        const b = centered[i - lag];
        dot += a * b;
        left += a * a;
        right += b * b;
        count++;
      }
      let corr = dot / (Math.sqrt(left * right) + EPS);
      const bpm = (60 * fps) / lag;
      // Very mild preference for human-friendly dance tempos, never a hard rule.
      const prior = Math.exp(-Math.pow((bpm - 122) / 68, 2));
      corr *= 0.91 + prior * 0.09;

      // Reward a stable metrical family at two and four beats.
      if (lag * 2 < centered.length) {
        let harmonic = 0, hCount = 0;
        for (let i = lag * 2; i < centered.length; i += 2) {
          harmonic += centered[i] * centered[i - lag * 2];
          hCount++;
        }
        corr += (harmonic / Math.max(1, hCount)) * 0.025;
      }
      if (corr > bestScore) { bestScore = corr; bestLag = lag; }
    }

    let bpm = (60 * fps) / bestLag;
    if (bpm < 76) { bpm *= 2; bestLag = Math.max(2, Math.round(bestLag / 2)); }
    if (bpm > 176) { bpm /= 2; bestLag *= 2; }
    bpm = clamp(bpm, 72, 176);

    let bestOffset = 0;
    let phaseScore = -Infinity;
    for (let offset = 0; offset < bestLag; offset++) {
      let score = 0;
      for (let i = offset; i < centered.length; i += bestLag) {
        score += centered[i] * (0.8 + (energy[i] || 0) * 0.2);
      }
      if (score > phaseScore) { phaseScore = score; bestOffset = offset; }
    }

    return {
      bpm,
      period: 60 / bpm,
      phase: bestOffset / fps,
      confidence: clamp(bestScore, 0, 1),
    };
  }

  function valueAt(series, time, fps, radius = 0) {
    const center = Math.round(time * fps);
    let best = 0;
    for (let i = center - radius; i <= center + radius; i++) {
      if (i >= 0 && i < series.length) best = Math.max(best, series[i]);
    }
    return best;
  }

  function generateChart(env, tempo, seedText) {
    const rng = mulberry32(hashString(seedText));
    const { duration, fps, onset, energy, brightness } = env;
    const beat = clamp(tempo.period, 0.34, 0.84);
    const grid = beat / 2;
    const onsetStrong = percentile(onset, 0.84);
    const energyLow = percentile(energy, 0.14);
    const phraseEnergy = movingAverage(energy, Math.max(1, Math.round(fps * 2.4)));
    const phraseOnset = movingAverage(onset, Math.max(1, Math.round(fps * 1.7)));
    const phraseSeconds = clamp(beat * 16, 5.5, 9.5);
    const candidates = [];

    let index = 0;
    for (let t = Math.max(0.62, tempo.phase); t < duration - 0.28; t += grid, index++) {
      const o = valueAt(onset, t, fps, Math.max(1, Math.round(fps * 0.035)));
      const e = valueAt(energy, t, fps, 1);
      const b = valueAt(brightness, t, fps, 1);
      const pe = valueAt(phraseEnergy, t, fps, 1);
      const po = valueAt(phraseOnset, t, fps, 1);
      const activity = clamp(pe * 0.58 + po * 0.42, 0, 1.1);
      const isBeat = index % 2 === 0;
      const isBar = index % 8 === 0;
      const priority =
        o * 0.56 + e * 0.16 + activity * 0.12 +
        (isBeat ? 0.105 : 0) + (isBar ? 0.055 : 0) + rng() * 0.032;
      candidates.push({
        time: t,
        onset: o,
        energy: e,
        brightness: b,
        activity,
        isBeat,
        isBar,
        priority,
        phrase: Math.floor(t / phraseSeconds),
      });
    }

    const selectedIndices = new Set();
    const phrases = new Map();
    for (let i = 0; i < candidates.length; i++) {
      const key = candidates[i].phrase;
      if (!phrases.has(key)) phrases.set(key, []);
      phrases.get(key).push(i);
    }

    for (const indices of phrases.values()) {
      if (!indices.length) continue;
      let activity = 0;
      let audible = 0;
      for (const i of indices) {
        activity += candidates[i].activity;
        if (candidates[i].energy > energyLow * 0.72 || candidates[i].onset > 0.08) audible++;
      }
      activity /= indices.length;
      const span = Math.max(grid, candidates[indices[indices.length - 1]].time - candidates[indices[0]].time + grid);
      let rate;
      if (audible / indices.length < 0.16 && activity < 0.08) rate = 0.24;
      else rate = clamp(1.12 + activity * 1.18 + (tempo.bpm - 90) / 205, 1.05, 2.78);
      const desired = Math.min(indices.length, Math.max(1, Math.round(span * rate)));
      indices
        .map((i) => ({ i, p: candidates[i].priority }))
        .sort((a, b) => b.p - a.p)
        .slice(0, desired)
        .forEach((x) => selectedIndices.add(x.i));
    }

    // Keep the whole song alive without forcing notes into true silence.
    let lastSelected = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (selectedIndices.has(i)) {
        lastSelected = c.time;
        continue;
      }
      const maxGap = 1.22 + (1 - clamp(c.activity, 0, 1)) * 0.58;
      if (c.time - lastSelected > maxGap && (c.energy > energyLow * 0.76 || c.onset > 0.10)) {
        let best = i;
        for (let j = i; j < candidates.length && candidates[j].time - c.time < Math.min(0.88, maxGap); j++) {
          if (candidates[j].priority > candidates[best].priority) best = j;
        }
        selectedIndices.add(best);
        lastSelected = candidates[best].time;
      }
    }

    const selected = Array.from(selectedIndices)
      .sort((a, b) => a - b)
      .map((i) => candidates[i]);

    const notes = [];
    let previousLane = -1;
    let repeatCount = 0;
    let pattern = 0;
    let patternStep = 0;
    let patternLength = 14;
    let lastTime = -10;

    function chooseLane(c, order) {
      if (patternStep >= patternLength || c.isBar || order === 0) {
        pattern = Math.floor(rng() * 6);
        patternStep = 0;
        patternLength = 10 + Math.floor(rng() * 13);
      }
      let lane;
      switch (pattern) {
        case 0: lane = patternStep % 4; break;                              // sweep
        case 1: lane = [0, 1, 2, 3, 2, 1][patternStep % 6]; break;         // ribbon
        case 2: lane = [1, 2, 0, 3][patternStep % 4]; break;               // inside-out
        case 3: lane = [0, 2, 1, 3, 1, 2][patternStep % 6]; break;         // hand-cross rhythm
        case 4: lane = c.brightness < 0.27 ? 0 : c.brightness < 0.49 ? 1 : c.brightness < 0.70 ? 2 : 3; break;
        default: {
          const step = rng() < 0.5 ? 1 : -1;
          lane = previousLane < 0 ? Math.floor(rng() * 4) : clamp(previousLane + step, 0, 3);
          if (lane === previousLane) lane = (lane + 2) % 4;
        }
      }
      patternStep++;

      const spectralLane = clamp(Math.floor(c.brightness * 4), 0, 3);
      if (rng() < 0.26) lane = spectralLane;
      if (lane === previousLane) repeatCount++; else repeatCount = 0;
      if (repeatCount >= 2) {
        lane = (lane + (rng() < 0.5 ? 1 : 3)) % 4;
        repeatCount = 0;
      }
      if (c.time - lastTime < 0.32 && lane === previousLane) lane = (lane + 1 + Math.floor(rng() * 2)) % 4;
      previousLane = lane;
      lastTime = c.time;
      return lane;
    }

    for (let i = 0; i < selected.length; i++) {
      const c = selected[i];
      const lane = chooseLane(c, i);
      const accent = c.onset >= onsetStrong && c.activity > 0.34;
      notes.push({ id: notes.length, time: c.time, lane, strength: clamp(c.priority, 0, 1.4), kind: "tap" });

      const nextGap = i + 1 < selected.length ? selected[i + 1].time - c.time : 1;
      const prevGap = i > 0 ? c.time - selected[i - 1].time : 1;
      const chordChance = c.activity > 0.80 ? 0.22 : c.activity > 0.55 ? 0.16 : 0.10;
      if (accent && nextGap > 0.31 && prevGap > 0.29 && rng() < chordChance) {
        let second = 3 - lane;
        if (second === lane || Math.abs(second - lane) < 2) second = (lane + 2) % 4;
        notes.push({ id: notes.length, time: c.time, lane: second, strength: clamp(c.priority + 0.08, 0, 1.4), kind: "tap" });
      }
    }

    notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
    for (let i = 0; i < notes.length; i++) notes[i].id = i;
    const noteRate = notes.length / Math.max(1, duration);
    const intensity = noteRate < 1.45 ? "Gentle" : noteRate < 2.18 ? "Flowing" : "Sparkling";
    return { notes, noteRate, intensity };
  }

  function analyzeAudioBuffer(buffer, seedText) {
    const detailed = extractEnvelope(buffer, {
      fps: 50,
      probes: 84,
      start: 0,
      duration: buffer.duration,
    });
    const tempo = estimateTempo(detailed);
    const chart = generateChart(detailed, tempo, `${seedText}|full|${buffer.duration.toFixed(3)}`);
    return {
      segmentStart: 0,
      duration: buffer.duration,
      bpm: tempo.bpm,
      confidence: tempo.confidence,
      notes: chart.notes,
      noteRate: chart.noteRate,
      intensity: chart.intensity,
      envelope: detailed,
    };
  }

  return {
    clamp,
    mean,
    percentile,
    standardDeviation,
    extractEnvelope,
    quickTrackScore,
    selectSegment,
    estimateTempo,
    generateChart,
    analyzeAudioBuffer,
    hashString,
    mulberry32,
  };
});
