(() => {
  "use strict";

  const A = window.MallowAnalysis;
  if (!A) throw new Error("Analysis core failed to load.");

  const $ = (id) => document.getElementById(id);
  const screens = {
    loading: $("loadingScreen"),
    empty: $("emptyScreen"),
    ready: $("readyScreen"),
    game: $("gameScreen"),
    result: $("resultScreen"),
  };
  const els = {
    loadingText: $("loadingText"), loadingBar: $("loadingBar"),
    readyTitle: $("readyTitle"), readySub: $("readySub"),
    segmentPill: $("segmentPill"), tempoPill: $("tempoPill"), chartPill: $("chartPill"),
    startButton: $("startButton"), songPicker: $("songPicker"), recurateButton: $("recurateButton"),
    percussionSelect: $("percussionSelect"), percussionVolume: $("percussionVolume"),
    percussionVolumeLabel: $("percussionVolumeLabel"), testPercussionButton: $("testPercussionButton"),
    canvas: $("gameCanvas"), hudTrack: $("hudTrack"), hudTime: $("hudTime"), scoreValue: $("scoreValue"),
    comboValue: $("comboValue"), bloomFill: $("bloomFill"), countdown: $("countdown"),
    pauseButton: $("pauseButton"), pauseOverlay: $("pauseOverlay"), resumeButton: $("resumeButton"), quitButton: $("quitButton"),
    rankSeal: $("rankSeal"), resultTitle: $("resultTitle"), resultTrack: $("resultTrack"),
    finalScore: $("finalScore"), finalAccuracy: $("finalAccuracy"), finalCombo: $("finalCombo"), finalPerfect: $("finalPerfect"),
    retryButton: $("retryButton"), newMixButton: $("newMixButton"), errorToast: $("errorToast"),
  };

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let audioContext = null;

  function ensureAudioContext() {
    if (audioContext && audioContext.state !== "closed") return audioContext;
    if (!AudioContextClass) return null;
    try { audioContext = new AudioContextClass({ latencyHint: "interactive" }); }
    catch (_) { audioContext = new AudioContextClass(); }
    return audioContext;
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function withTimeout(promise, ms, message) {
    let timer = 0;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function decodeAudioDataCompat(context, bytes) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (buffer) => { if (!settled) { settled = true; resolve(buffer); } };
      const fail = (error) => { if (!settled) { settled = true; reject(error || new Error("Audio decoding failed.")); } };
      try {
        const maybePromise = context.decodeAudioData(bytes.slice(0), ok, fail);
        if (maybePromise && typeof maybePromise.then === "function") maybePromise.then(ok, fail);
      } catch (error) { fail(error); }
    });
  }

  const ctx = els.canvas.getContext("2d", { alpha: false, desynchronized: true });
  let tracks = [];
  let selection = null;
  let currentTrackName = null;
  let mixVariation = 0;
  let animationFrame = 0;
  let toastTimer = 0;
  let game = null;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let dpr = 1;
  let noiseBuffer = null;
  let lastFrameTime = performance.now();

  const KEY_TO_LANE = new Map([
    ["KeyA", 0], ["KeyS", 1], ["KeyK", 2], ["KeyL", 3],
  ]);
  const LANE_KEYS = ["A", "S", "K", "L"];
  const LANE_COLORS = ["#e94f91", "#ee77a7", "#c94c88", "#f08aad"];
  const LANE_DARK = ["#96305e", "#a33f6c", "#83305a", "#9f4169"];
  const SHAPE_SCALE = [1.00, 1.08, 1.00, 0.98];

  const PREF_KEY = "mallowbeat.v2.percussion";
  const drumPrefs = loadDrumPrefs();

  function loadDrumPrefs() {
    const fallback = { preset: "jazz", volume: 16 };
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
      if (!saved || typeof saved !== "object") return fallback;
      const allowed = new Set(["jazz", "kick", "snare", "stick", "hat", "off"]);
      return {
        preset: allowed.has(saved.preset) ? saved.preset : fallback.preset,
        volume: A.clamp(Number(saved.volume) || fallback.volume, 0, 30),
      };
    } catch (_) {
      return fallback;
    }
  }

  function saveDrumPrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(drumPrefs)); }
    catch (_) { /* preferences are optional */ }
  }

  function syncDrumControls() {
    els.percussionSelect.value = drumPrefs.preset;
    els.percussionVolume.value = String(drumPrefs.volume);
    els.percussionVolumeLabel.value = `${drumPrefs.volume}%`;
    els.percussionVolumeLabel.textContent = `${drumPrefs.volume}%`;
  }

  function setState(name) {
    Object.values(screens).forEach((screen) => screen.classList.remove("active"));
    screens[name].classList.add("active");
    document.documentElement.dataset.mallowState = name;
  }

  function loading(message, progress) {
    els.loadingText.textContent = message;
    els.loadingBar.style.width = `${A.clamp(progress, 0.02, 1) * 100}%`;
    setState("loading");
  }

  function showToast(message, seconds = 5) {
    clearTimeout(toastTimer);
    els.errorToast.textContent = message;
    els.errorToast.classList.add("show");
    toastTimer = setTimeout(() => els.errorToast.classList.remove("show"), seconds * 1000);
  }

  function friendlyTitle(filename) {
    return filename
      .replace(/\.[^.]+$/, "")
      .replace(/[_]+/g, " ")
      .replace(/\s+-\s+/g, " — ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  async function decodeTrack(track, progressStart, progressEnd) {
    if (!track || !track.file) throw new Error("Choose a song from Files first.");
    const context = ensureAudioContext();
    if (!context) throw new Error("This browser does not support the Web Audio features needed by the game.");

    loading(`Opening ${friendlyTitle(track.name)}…`, progressStart);
    await nextPaint();
    const bytes = await withTimeout(
      track.file.arrayBuffer(),
      15000,
      "Mallowbeat could not finish reading this file. Try a smaller MP3 or M4A."
    );

    loading(`Decoding ${friendlyTitle(track.name)}…`, progressStart + (progressEnd - progressStart) * 0.45);
    await nextPaint();
    const decoded = await withTimeout(
      decodeAudioDataCompat(context, bytes),
      30000,
      "This song took too long to decode on this iPhone. Try another MP3/M4A or re-export the file."
    );
    if (!decoded || !Number.isFinite(decoded.duration) || decoded.duration < 1) {
      throw new Error("This audio file decoded incorrectly. Try another MP3 or M4A.");
    }
    els.loadingBar.style.width = `${progressEnd * 100}%`;
    return decoded;
  }

  function candidateTracks(excludeName) {
    let pool = tracks.filter((t) => t.name !== excludeName && t.size > 1024 && t.size < 220 * 1024 * 1024);
    if (!pool.length) pool = tracks.filter((t) => t.size > 1024 && t.size < 220 * 1024 * 1024);
    if (pool.length <= 5) return pool;
    const newest = pool.slice(0, 3);
    const remaining = pool.slice(3);
    const daySeed = Math.floor(Date.now() / 86400000) + mixVariation;
    const rng = A.mulberry32(A.hashString(String(daySeed)));
    while (newest.length < 5 && remaining.length) {
      newest.push(remaining.splice(Math.floor(rng() * remaining.length), 1)[0]);
    }
    return newest;
  }

  async function curate({ preferDifferent = false } = {}) {
    if (!ensureAudioContext()) {
      setState("empty");
      showToast("This browser does not support the Web Audio features needed by the game.", 10);
      return;
    }

    try {
      if (!tracks.length) { setState("empty"); return; }
      loading("Listening to your song…", 0.04);

      const pool = candidateTracks(preferDifferent ? currentTrackName : null);
      if (!pool.length) {
        setState("empty");
        showToast("No playable MP3 was found. Try a smaller standard MP3 file.");
        return;
      }

      let best = null;
      for (let i = 0; i < pool.length; i++) {
        const track = pool[i];
        const startP = 0.08 + (i / pool.length) * 0.55;
        const endP = 0.08 + ((i + 1) / pool.length) * 0.55;
        loading(`Listening to ${friendlyTitle(track.name)}…`, startP);
        try {
          const buffer = await decodeTrack(track, startP, endP);
          const score = pool.length === 1 ? 1 : A.quickTrackScore(buffer);
          if (!best || score > best.score) best = { track, buffer, score };
        } catch (error) {
          console.warn("Skipped track", track.name, error);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (!best) throw new Error("The MP3 files could not be decoded by this browser.");
      loading("Finding the rhythm across the whole song…", 0.72);
      await nextPaint();
      const analysis = A.analyzeAudioBuffer(best.buffer, `${best.track.name}|mix${mixVariation}`, { mobile: true });
      selection = { ...best, analysis };
      currentTrackName = best.track.name;
      loading("Shaping flowers, bows, clovers and stars…", 0.96);
      await new Promise((resolve) => setTimeout(resolve, 150));
      showReady();
    } catch (error) {
      console.error(error);
      setState("empty");
      showToast(error && error.message ? error.message : "The song could not be prepared.", 9);
    }
  }

  function showReady() {
    if (!selection) return;
    const { track, analysis } = selection;
    const title = friendlyTitle(track.name);
    els.readyTitle.textContent = title;
    els.readySub.textContent = `The entire track is mapped into a ${analysis.intensity.toLowerCase()} arrangement.`;
    els.segmentPill.textContent = formatTime(analysis.duration);
    els.tempoPill.textContent = `${Math.round(analysis.bpm)} BPM`;
    els.chartPill.textContent = `${analysis.notes.length} notes`;
    els.hudTrack.textContent = title;
    els.hudTime.textContent = `00:00 / ${formatTime(analysis.duration)}`;
    setState("ready");
  }

  function resizeCanvas() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = els.canvas.getBoundingClientRect();
    canvasWidth = Math.max(1, rect.width);
    canvasHeight = Math.max(1, rect.height);
    els.canvas.width = Math.round(canvasWidth * dpr);
    els.canvas.height = Math.round(canvasHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeRuntimeGame() {
    const analysis = selection.analysis;
    return {
      notes: analysis.notes.map((n) => ({ ...n, hit: false, missed: false })),
      envelope: analysis.envelope,
      duration: analysis.duration,
      segmentStart: 0,
      score: 0,
      combo: 0,
      maxCombo: 0,
      bloom: 42,
      weightedHits: 0,
      judged: 0,
      counts: { perfect: 0, sweet: 0, good: 0, miss: 0 },
      source: null,
      gain: null,
      startContextTime: 0,
      pausedElapsed: 0,
      paused: false,
      ending: false,
      missCursor: 0,
      laneFlash: [0, 0, 0, 0],
      laneDown: [false, false, false, false],
      particles: [],
      judgement: null,
      started: false,
      countdownToken: 0,
      lastHudSecond: -1,
    };
  }

  function scheduleAudio(elapsed, delay) {
    if (!game || !selection) return;
    if (game.source) {
      try { game.source.onended = null; game.source.stop(); } catch (_) { /* already stopped */ }
    }
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    source.buffer = selection.buffer;
    source.connect(gain);
    gain.connect(audioContext.destination);

    const when = audioContext.currentTime + delay;
    const remaining = Math.max(0.05, game.duration - elapsed);
    const fileOffset = elapsed;
    gain.gain.cancelScheduledValues(when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(1, when + Math.min(0.28, remaining * 0.2));
    if (remaining > 0.8) {
      gain.gain.setValueAtTime(1, when + remaining - 0.65);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + remaining);
    }
    source.start(when, fileOffset, remaining);
    source.onended = () => {
      if (game && !game.paused && !game.ending && currentSongTime() >= game.duration - 0.12) finishGame();
    };

    game.source = source;
    game.gain = gain;
    game.startContextTime = when - elapsed;
    game.started = true;
  }

  function currentSongTime() {
    if (!game) return 0;
    if (game.paused) return game.pausedElapsed;
    return audioContext.currentTime - game.startContextTime;
  }

  async function startGame() {
    if (!selection) return;
    const context = ensureAudioContext();
    if (!context) return showToast("Audio is unavailable in this browser.", 7);
    try {
      await withTimeout(context.resume(), 5000, "Tap Play again to enable audio on this iPhone.");
    } catch (error) {
      showToast(error.message, 7);
      return;
    }
    game = makeRuntimeGame();
    setState("game");
    els.pauseOverlay.classList.remove("active");
    resizeCanvas();
    updateHud(0);
    scheduleAudio(0, 3.0);
    runCountdown(["3", "2", "1", "♡"], 0, 650);
    lastFrameTime = performance.now();
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(frame);
  }

  function runCountdown(items, index, interval) {
    if (!game) return;
    const token = ++game.countdownToken;
    function step(i) {
      if (!game || token !== game.countdownToken || i >= items.length) return;
      els.countdown.textContent = items[i];
      els.countdown.classList.remove("show");
      void els.countdown.offsetWidth;
      els.countdown.classList.add("show");
      setTimeout(() => step(i + 1), interval);
    }
    step(index);
  }

  function pauseGame() {
    if (!game || game.paused || game.ending) return;
    game.pausedElapsed = A.clamp(currentSongTime(), 0, game.duration);
    game.paused = true;
    game.countdownToken++;
    if (game.source) {
      try { game.source.onended = null; game.source.stop(); } catch (_) { /* no-op */ }
    }
    els.pauseOverlay.classList.add("active");
  }

  async function resumeGame() {
    if (!game || !game.paused) return;
    const context = ensureAudioContext();
    if (!context) return;
    try {
      await withTimeout(context.resume(), 5000, "Tap Resume again to enable audio.");
    } catch (error) {
      showToast(error.message, 7);
      return;
    }
    els.pauseOverlay.classList.remove("active");
    const elapsed = game.pausedElapsed;
    game.paused = false;
    scheduleAudio(elapsed, 1.15);
    runCountdown(["1", "♡"], 0, 560);
  }

  function leaveGame() {
    if (game && game.source) {
      try { game.source.onended = null; game.source.stop(); } catch (_) { /* no-op */ }
    }
    game = null;
    cancelAnimationFrame(animationFrame);
    els.pauseOverlay.classList.remove("active");
    showReady();
  }

  function updateHud(songTime = currentSongTime()) {
    if (!game) return;
    els.scoreValue.textContent = String(Math.round(game.score)).padStart(6, "0");
    els.comboValue.textContent = String(game.combo);
    els.bloomFill.style.height = `${A.clamp(game.bloom, 0, 100)}%`;
    const second = Math.floor(A.clamp(songTime, 0, game.duration));
    if (second !== game.lastHudSecond) {
      game.lastHudSecond = second;
      els.hudTime.textContent = `${formatTime(second)} / ${formatTime(game.duration)}`;
    }
  }

  function ensureNoiseBuffer() {
    if (!audioContext || noiseBuffer) return noiseBuffer;
    const length = Math.max(1, Math.floor(audioContext.sampleRate * 0.35));
    noiseBuffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  function playKick(time, level) {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(108, time);
    osc.frequency.exponentialRampToValueAtTime(48, time + 0.115);
    gain.gain.setValueAtTime(Math.max(0.0001, level * 0.72), time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(time);
    osc.stop(time + 0.16);
  }

  function playSnare(time, level) {
    const noise = audioContext.createBufferSource();
    const filter = audioContext.createBiquadFilter();
    const gain = audioContext.createGain();
    noise.buffer = ensureNoiseBuffer();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1850, time);
    filter.Q.setValueAtTime(0.72, time);
    gain.gain.setValueAtTime(Math.max(0.0001, level * 0.42), time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.085);
    noise.connect(filter).connect(gain).connect(audioContext.destination);
    noise.start(time);
    noise.stop(time + 0.10);

    const tone = audioContext.createOscillator();
    const toneGain = audioContext.createGain();
    tone.type = "triangle";
    tone.frequency.setValueAtTime(176, time);
    toneGain.gain.setValueAtTime(Math.max(0.0001, level * 0.22), time);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);
    tone.connect(toneGain).connect(audioContext.destination);
    tone.start(time);
    tone.stop(time + 0.07);
  }

  function playStick(time, level) {
    const frequencies = [880, 1320];
    for (let i = 0; i < frequencies.length; i++) {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = i ? "square" : "triangle";
      osc.frequency.setValueAtTime(frequencies[i], time);
      gain.gain.setValueAtTime(Math.max(0.0001, level * (i ? 0.11 : 0.16)), time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.028 + i * 0.008);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(time);
      osc.stop(time + 0.05);
    }
  }

  function playHat(time, level) {
    const noise = audioContext.createBufferSource();
    const filter = audioContext.createBiquadFilter();
    const gain = audioContext.createGain();
    noise.buffer = ensureNoiseBuffer();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(6100, time);
    gain.gain.setValueAtTime(Math.max(0.0001, level * 0.22), time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    noise.connect(filter).connect(gain).connect(audioContext.destination);
    noise.start(time);
    noise.stop(time + 0.06);
  }

  function playPercussion(lane, when = null) {
    if (!audioContext || drumPrefs.preset === "off" || drumPrefs.volume <= 0) return;
    const time = when == null ? audioContext.currentTime + 0.004 : when;
    const level = (drumPrefs.volume / 100) * 0.52;
    let type = drumPrefs.preset;
    if (type === "jazz") type = ["kick", "stick", "hat", "snare"][lane] || "stick";
    if (type === "kick") playKick(time, level);
    else if (type === "snare") playSnare(time, level);
    else if (type === "stick") playStick(time, level);
    else if (type === "hat") playHat(time, level);
  }

  async function testPercussion() {
    const context = ensureAudioContext();
    if (!context) return;
    try { await withTimeout(context.resume(), 5000, "Tap Try again to enable audio."); }
    catch (error) { showToast(error.message, 7); return; }
    if (drumPrefs.preset === "off" || drumPrefs.volume <= 0) {
      showToast("Key sound is currently off.", 2.5);
      return;
    }
    const start = audioContext.currentTime + 0.03;
    for (let lane = 0; lane < 4; lane++) playPercussion(lane, start + lane * 0.16);
  }

  function hitLane(lane) {
    if (!game || game.paused || game.ending) return;
    const time = currentSongTime();
    if (time < -0.05 || time > game.duration + 0.2) return;
    playPercussion(lane);
    game.laneFlash[lane] = 1;
    let best = null;
    let bestDelta = Infinity;
    for (const note of game.notes) {
      if (note.hit || note.missed || note.lane !== lane) continue;
      const delta = Math.abs(note.time - time);
      if (delta < bestDelta && delta <= 0.195) { best = note; bestDelta = delta; }
      if (note.time > time + 0.21) break;
    }
    if (!best) {
      spawnParticles(lane, 4, 0.38);
      return;
    }

    best.hit = true;
    game.combo++;
    game.maxCombo = Math.max(game.maxCombo, game.combo);
    let label, factor, bloom;
    if (bestDelta <= 0.066) { label = "PERFECT"; factor = 1; bloom = 2.5; game.counts.perfect++; }
    else if (bestDelta <= 0.125) { label = "SWEET"; factor = 0.82; bloom = 1.7; game.counts.sweet++; }
    else { label = "GOOD"; factor = 0.57; bloom = 0.85; game.counts.good++; }
    game.judged++;
    game.weightedHits += factor;
    game.bloom = A.clamp(game.bloom + bloom, 0, 100);
    const comboBonus = 1 + Math.min(100, game.combo) * 0.0045;
    game.score += Math.round(1000 * factor * comboBonus * (0.94 + Math.min(1, best.strength) * 0.06));
    game.judgement = { label, alpha: 1, scale: 0.75, lane, time: performance.now() };
    spawnParticles(lane, label === "PERFECT" ? 18 : label === "SWEET" ? 12 : 8, factor);
    updateHud(time);
  }

  function processMisses(time) {
    if (!game) return;
    while (game.missCursor < game.notes.length) {
      const note = game.notes[game.missCursor];
      if (note.time >= time - 0.20) break;
      game.missCursor++;
      if (note.hit || note.missed) continue;
      note.missed = true;
      game.combo = 0;
      game.counts.miss++;
      game.judged++;
      game.bloom = A.clamp(game.bloom - 4.2, 0, 100);
      game.judgement = { label: "MISS", alpha: 0.85, scale: 0.9, lane: note.lane, time: performance.now() };
      updateHud(time);
    }
  }

  function laneGeometry() {
    const compact = canvasWidth < 720;
    const available = canvasWidth * (compact ? 0.88 : 0.62);
    const laneWidth = Math.min(compact ? 96 : 128, available / 4.94);
    const sideGap = laneWidth * 0.11;
    const centerGap = laneWidth * 0.50;
    const totalWidth = laneWidth * 4 + sideGap * 2 + centerGap;
    const left = (canvasWidth - totalWidth) / 2;
    const starts = [
      left,
      left + laneWidth + sideGap,
      left + laneWidth * 2 + sideGap + centerGap,
      left + laneWidth * 3 + sideGap * 2 + centerGap,
    ];
    const centers = starts.map((x) => x + laneWidth / 2);
    const targetY = canvasHeight * (compact ? 0.79 : 0.81);
    const spawnY = Math.max(80, canvasHeight * 0.105);
    return { totalWidth, laneWidth, sideGap, centerGap, left, starts, centers, targetY, spawnY };
  }

  function buildFlowerPath() {
    const path = new Path2D();
    const petals = 5;
    for (let i = 0; i < petals; i++) {
      const angle = -Math.PI / 2 + i * Math.PI * 2 / petals;
      const cx = Math.cos(angle) * 0.46;
      const cy = Math.sin(angle) * 0.46;
      path.ellipse(cx, cy, 0.40, 0.55, angle + Math.PI / 2, 0, Math.PI * 2);
    }
    path.ellipse(0, 0, 0.39, 0.39, 0, 0, Math.PI * 2);
    return path;
  }

  function buildCloverPath() {
    const path = new Path2D();
    for (let i = 0; i < 4; i++) {
      const angle = -Math.PI / 4 + i * Math.PI / 2;
      const cx = Math.cos(angle) * 0.43;
      const cy = Math.sin(angle) * 0.43;
      path.ellipse(cx, cy, 0.43, 0.52, angle + Math.PI / 2, 0, Math.PI * 2);
    }
    path.ellipse(0, 0, 0.36, 0.36, 0, 0, Math.PI * 2);
    return path;
  }

  function buildOutlineFlowerPath() {
    const path = new Path2D();
    const lobes = 5;
    const steps = 100;
    for (let i = 0; i <= steps; i++) {
      const angle = -Math.PI / 2 + i / steps * Math.PI * 2;
      const r = 0.80 + 0.20 * (0.5 + 0.5 * Math.cos(lobes * (angle + Math.PI / 2)));
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
    return path;
  }

  function buildBowPath() {
    const path = new Path2D();
    path.moveTo(-0.10, -0.10);
    path.bezierCurveTo(-0.40, -0.74, -1.02, -0.66, -1.00, -0.04);
    path.bezierCurveTo(-0.98, 0.58, -0.38, 0.69, -0.10, 0.16);
    path.bezierCurveTo(-0.03, 0.08, -0.03, -0.03, -0.10, -0.10);
    path.closePath();
    path.moveTo(0.10, -0.10);
    path.bezierCurveTo(0.40, -0.74, 1.02, -0.66, 1.00, -0.04);
    path.bezierCurveTo(0.98, 0.58, 0.38, 0.69, 0.10, 0.16);
    path.bezierCurveTo(0.03, 0.08, 0.03, -0.03, 0.10, -0.10);
    path.closePath();
    path.ellipse(0, 0.02, 0.24, 0.30, 0, 0, Math.PI * 2);
    return path;
  }

  function roundedPolygonPath(points, cornerDistance) {
    const path = new Path2D();
    const before = [];
    const after = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[(i - 1 + points.length) % points.length];
      const cur = points[i];
      const next = points[(i + 1) % points.length];
      const inDx = prev.x - cur.x;
      const inDy = prev.y - cur.y;
      const outDx = next.x - cur.x;
      const outDy = next.y - cur.y;
      const inLen = Math.hypot(inDx, inDy) || 1;
      const outLen = Math.hypot(outDx, outDy) || 1;
      const d = Math.min(cornerDistance, inLen * 0.32, outLen * 0.32);
      before.push({ x: cur.x + inDx / inLen * d, y: cur.y + inDy / inLen * d });
      after.push({ x: cur.x + outDx / outLen * d, y: cur.y + outDy / outLen * d });
    }
    path.moveTo(after[0].x, after[0].y);
    for (let i = 1; i <= points.length; i++) {
      const idx = i % points.length;
      path.lineTo(before[idx].x, before[idx].y);
      path.quadraticCurveTo(points[idx].x, points[idx].y, after[idx].x, after[idx].y);
    }
    path.closePath();
    return path;
  }

  function buildRoundedStarPath() {
    const points = [];
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + i * Math.PI / 5;
      const radius = i % 2 === 0 ? 1 : 0.53;
      points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    return roundedPolygonPath(points, 0.19);
  }

  const SHAPE_PATHS = [
    buildFlowerPath(),
    buildBowPath(),
    buildCloverPath(),
    buildRoundedStarPath(),
  ];
  const BG_FLOWER_PATH = buildOutlineFlowerPath();

  function drawNoteShape(lane, x, y, size, fill, alpha = 1, options = {}) {
    const path = SHAPE_PATHS[lane];
    const scale = size * SHAPE_SCALE[lane];
    const border = options.lineWidth == null ? 2.2 : options.lineWidth;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.shadowColor = options.shadowColor || "rgba(174,55,111,.26)";
    ctx.shadowBlur = options.shadowBlur == null ? size * 0.34 : options.shadowBlur;
    if (border > 0) {
      const borderScale = 1 + border / Math.max(12, size);
      ctx.save();
      ctx.scale(borderScale, borderScale);
      ctx.fillStyle = options.stroke || "rgba(113,40,76,.34)";
      ctx.fill(path);
      ctx.restore();
    }
    ctx.fillStyle = fill;
    ctx.fill(path);
    ctx.shadowBlur = 0;
    if (options.gloss) {
      ctx.globalAlpha = alpha * 0.42;
      ctx.fillStyle = "rgba(255,255,255,.94)";
      ctx.beginPath();
      ctx.ellipse(-0.25, -0.30, 0.13, 0.25, -0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawRoundedRect(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function spawnParticles(lane, count, strength) {
    if (!game) return;
    const g = laneGeometry();
    const x = g.centers[lane];
    const y = g.targetY;
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI * (0.15 + Math.random() * 0.7);
      const speed = (55 + Math.random() * 150) * (0.7 + strength * 0.4);
      game.particles.push({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: 0.45 + Math.random() * 0.45, age: 0,
        size: 2.5 + Math.random() * 5.2, spin: (Math.random() - 0.5) * 2.4,
        rotation: 0, lane,
      });
    }
  }

  function envelopeAt(time) {
    if (!game || !game.envelope || time < 0) return { energy: 0.15, onset: 0 };
    const e = game.envelope;
    const i = A.clamp(Math.round(time * e.fps), 0, e.energy.length - 1);
    return { energy: e.energy[i] || 0, onset: e.onset[i] || 0 };
  }

  const BG_MOTIFS = [
    { kind: "butterfly", x: .08, y: .18, s: .62, r: -.18, a: .050 },
    { kind: "flower", x: .19, y: .63, s: .82, r: .24, a: .045 },
    { kind: "butterfly", x: .31, y: .32, s: .42, r: .16, a: .042 },
    { kind: "flower", x: .41, y: .12, s: .52, r: -.36, a: .038 },
    { kind: "butterfly", x: .58, y: .70, s: .74, r: -.10, a: .045 },
    { kind: "flower", x: .70, y: .25, s: .95, r: .28, a: .048 },
    { kind: "butterfly", x: .86, y: .50, s: .50, r: .24, a: .043 },
    { kind: "flower", x: .93, y: .82, s: .58, r: -.22, a: .040 },
    { kind: "flower", x: .11, y: .88, s: .40, r: .42, a: .034 },
    { kind: "butterfly", x: .78, y: .90, s: .34, r: -.30, a: .034 },
  ];

  function drawButterflyOutline(x, y, size, rotation, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(size, size);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#8e4a70";
    ctx.lineWidth = 1.5 / Math.max(0.2, size);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-10, -28, -39, -34, -42, -12);
    ctx.bezierCurveTo(-44, 7, -20, 10, -2, 3);
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(10, -28, 39, -34, 42, -12);
    ctx.bezierCurveTo(44, 7, 20, 10, 2, 3);
    ctx.moveTo(-2, 4);
    ctx.bezierCurveTo(-26, 1, -34, 14, -26, 25);
    ctx.bezierCurveTo(-17, 35, -7, 18, 0, 7);
    ctx.moveTo(2, 4);
    ctx.bezierCurveTo(26, 1, 34, 14, 26, 25);
    ctx.bezierCurveTo(17, 35, 7, 18, 0, 7);
    ctx.moveTo(0, -8); ctx.lineTo(0, 20);
    ctx.stroke();
    ctx.restore();
  }

  function drawFlowerOutline(x, y, size, rotation, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(size, size);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#8e4a70";
    ctx.lineWidth = 1.5 / Math.max(0.2, size);
    ctx.stroke(BG_FLOWER_PATH);
    ctx.restore();
  }

  function drawBackground(time) {
    const musical = envelopeAt(time);
    const pulse = musical.energy * 0.72 + musical.onset * 0.28;
    const gradient = ctx.createLinearGradient(0, 0, canvasWidth, canvasHeight);
    gradient.addColorStop(0, `hsl(337 100% ${98 - pulse * 2.4}%)`);
    gradient.addColorStop(0.50, `hsl(334 86% ${92 - pulse * 3.0}%)`);
    gradient.addColorStop(1, `hsl(329 72% ${86 - pulse * 3.4}%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const baseSize = Math.min(canvasWidth, canvasHeight) * 0.10;
    for (const motif of BG_MOTIFS) {
      const x = motif.x * canvasWidth;
      const y = motif.y * canvasHeight;
      const s = baseSize * motif.s / 42;
      const alpha = motif.a * (0.86 + pulse * 0.20);
      if (motif.kind === "butterfly") drawButterflyOutline(x, y, s, motif.r, alpha);
      else drawFlowerOutline(x, y, baseSize * motif.s, motif.r, alpha);
    }

    const glow = ctx.createRadialGradient(canvasWidth / 2, canvasHeight * 0.48, 10, canvasWidth / 2, canvasHeight * 0.48, canvasWidth * 0.44);
    glow.addColorStop(0, `rgba(255,255,255,${0.22 + pulse * 0.10})`);
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  function drawLanes(time) {
    const g = laneGeometry();
    for (let lane = 0; lane < 4; lane++) {
      const x = g.starts[lane];
      const flash = game.laneFlash[lane];
      ctx.fillStyle = `rgba(255,255,255,${0.29 + flash * 0.20})`;
      drawRoundedRect(x, g.spawnY - 18, g.laneWidth, g.targetY - g.spawnY + 92, g.laneWidth * 0.24);
      ctx.fill();

      ctx.strokeStyle = `rgba(255,255,255,${0.72 + flash * 0.20})`;
      ctx.lineWidth = 2.2;
      drawRoundedRect(x, g.spawnY - 18, g.laneWidth, g.targetY - g.spawnY + 92, g.laneWidth * 0.24);
      ctx.stroke();

      ctx.globalAlpha = 0.34 + flash * 0.26;
      ctx.fillStyle = LANE_COLORS[lane];
      drawRoundedRect(x + g.laneWidth * 0.17, g.spawnY - 7, g.laneWidth * 0.66, 5, 3);
      ctx.fill();
      ctx.globalAlpha = 1;

      const cx = g.centers[lane];
      const targetSize = Math.min(37, g.laneWidth * 0.31) + flash * 3.5;
      drawNoteShape(lane, cx, g.targetY, targetSize, "rgba(255,255,255,.96)", 1, {
        stroke: LANE_COLORS[lane],
        lineWidth: 3.8,
        shadowColor: LANE_COLORS[lane],
        shadowBlur: 14 + flash * 14,
      });

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.fillStyle = "rgba(255,255,255,.84)";
      drawRoundedRect(cx - 17, g.targetY + 46, 34, 25, 8);
      ctx.fill();
      ctx.strokeStyle = "rgba(155,70,112,.18)";
      ctx.lineWidth = 1;
      drawRoundedRect(cx - 17, g.targetY + 46, 34, 25, 8);
      ctx.stroke();
      ctx.fillStyle = LANE_DARK[lane];
      ctx.font = `900 11px "Avenir Next", sans-serif`;
      ctx.fillText(LANE_KEYS[lane], cx, g.targetY + 59);

      game.laneFlash[lane] *= 0.84;
    }

    const progress = A.clamp(time / game.duration, 0, 1);
    const barW = Math.min(520, canvasWidth * 0.52);
    const barX = (canvasWidth - barW) / 2;
    const barY = canvasHeight - 19;
    ctx.fillStyle = "rgba(255,255,255,.52)";
    drawRoundedRect(barX, barY, barW, 6, 3); ctx.fill();
    if (progress > 0) {
      const pg = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      pg.addColorStop(0, "#fff"); pg.addColorStop(1, "#d7538d");
      ctx.fillStyle = pg;
      drawRoundedRect(barX, barY, barW * progress, 6, 3); ctx.fill();
    }
  }

  function drawNotes(time) {
    const g = laneGeometry();
    const travel = canvasHeight < 650 ? 1.78 : 2.12;
    for (const note of game.notes) {
      if (note.hit || note.missed) continue;
      const until = note.time - time;
      if (until > travel + 0.15) continue;
      if (until < -0.24) continue;
      const p = 1 - until / travel;
      const eased = A.clamp(p, -0.05, 1.12);
      const y = g.spawnY + (g.targetY - g.spawnY) * eased;
      const x = g.centers[note.lane];
      const size = Math.min(35, g.laneWidth * 0.28) * (0.84 + Math.max(0, eased) * 0.17);
      const alpha = A.clamp((travel - until) / 0.28, 0, 1) * A.clamp((until + 0.28) / 0.20, 0, 1);
      drawNoteShape(note.lane, x, y, size, LANE_COLORS[note.lane], alpha, {
        stroke: "rgba(103,31,70,.42)",
        lineWidth: 2.2,
        shadowColor: "rgba(173,51,108,.32)",
        shadowBlur: 13,
        gloss: true,
      });
    }
  }

  function updateParticles(dt) {
    if (!game) return;
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const p = game.particles[i];
      p.age += dt;
      if (p.age >= p.life) { game.particles.splice(i, 1); continue; }
      p.vy += 190 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
      const alpha = 1 - p.age / p.life;
      drawNoteShape(p.lane, p.x, p.y, p.size, p.age % 0.2 < 0.1 ? "#fff" : LANE_COLORS[p.lane], alpha, {
        stroke: "rgba(130,45,85,.18)",
        lineWidth: 0.8,
        shadowBlur: 0,
      });
    }
  }

  function drawJudgement() {
    if (!game || !game.judgement) return;
    const j = game.judgement;
    const age = (performance.now() - j.time) / 1000;
    if (age > 0.58) { game.judgement = null; return; }
    const alpha = 1 - age / 0.58;
    const scale = 0.82 + Math.sin(Math.min(1, age / 0.18) * Math.PI / 2) * 0.23;
    const g = laneGeometry();
    const x = g.centers[j.lane];
    const y = g.targetY - 78 - age * 34;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y); ctx.scale(scale, scale);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `950 ${j.label === "PERFECT" ? 20 : 17}px "Avenir Next", sans-serif`;
    ctx.lineWidth = 6; ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.strokeText(j.label, 0, 0);
    ctx.fillStyle = j.label === "MISS" ? "#8e5270" : "#cb3f7f";
    ctx.fillText(j.label, 0, 0);
    ctx.restore();
  }

  function frame(now) {
    if (!game) return;
    const dt = Math.min(0.05, Math.max(0, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    const time = currentSongTime();
    if (!game.paused) processMisses(time);

    drawBackground(time);
    drawLanes(time);
    drawNotes(time);
    updateParticles(dt);
    drawJudgement();
    updateHud(time);

    if (!game.paused && !game.ending && time >= game.duration + 0.18) finishGame();
    if (game) animationFrame = requestAnimationFrame(frame);
  }

  function finishGame() {
    if (!game || game.ending) return;
    game.ending = true;
    for (const note of game.notes) {
      if (!note.hit && !note.missed) {
        note.missed = true; game.counts.miss++; game.judged++;
      }
    }
    const total = Math.max(1, game.notes.length);
    const accuracy = (game.weightedHits / total) * 100;
    let rank = "D", title = "A sweet first bloom";
    if (accuracy >= 93) { rank = "S"; title = "A dazzling bloom!"; }
    else if (accuracy >= 84) { rank = "A"; title = "Beautiful timing!"; }
    else if (accuracy >= 72) { rank = "B"; title = "Lovely rhythm!"; }
    else if (accuracy >= 58) { rank = "C"; title = "The shapes are opening"; }

    if (game.source) {
      try { game.source.onended = null; game.source.stop(); } catch (_) { /* no-op */ }
    }
    cancelAnimationFrame(animationFrame);
    els.rankSeal.textContent = rank;
    els.resultTitle.textContent = title;
    els.resultTrack.textContent = friendlyTitle(selection.track.name);
    els.finalScore.textContent = Math.round(game.score).toLocaleString();
    els.finalAccuracy.textContent = `${accuracy.toFixed(1)}%`;
    els.finalCombo.textContent = String(game.maxCombo);
    els.finalPerfect.textContent = String(game.counts.perfect);
    setTimeout(() => setState("result"), 260);
  }

  function laneFromPointer(x) {
    const g = laneGeometry();
    let bestLane = -1;
    let bestDistance = Infinity;
    for (let lane = 0; lane < 4; lane++) {
      const distance = Math.abs(x - g.centers[lane]);
      if (distance < bestDistance) { bestDistance = distance; bestLane = lane; }
    }
    return bestDistance <= g.laneWidth * 0.72 ? bestLane : -1;
  }

  async function bootstrap() {
    syncDrumControls();
    resizeCanvas();
    setState("empty");
  }

  async function chooseLocalSong(file) {
    if (!file) return;
    if (file.size < 1024 || file.size > 220 * 1024 * 1024) {
      showToast("Please choose an audio file smaller than 220 MB.", 7);
      return;
    }
    loading(`Opening ${friendlyTitle(file.name)}…`, 0.02);
    await nextPaint();
    const context = ensureAudioContext();
    if (!context) {
      setState("empty");
      showToast("This browser does not support the Web Audio features needed by the game.", 10);
      return;
    }
    // On iOS Safari, resume() can remain pending after a file-picker change event.
    // Ask it to resume, but never block file decoding/analysis on that promise.
    context.resume().catch(() => {});
    tracks = [{ name: file.name, size: file.size, file }];
    currentTrackName = null;
    mixVariation = 0;
    await curate();
  }

  els.songPicker.addEventListener("change", () => chooseLocalSong(els.songPicker.files && els.songPicker.files[0]));
  els.recurateButton.addEventListener("click", () => { els.songPicker.value = ""; els.songPicker.click(); });
  els.startButton.addEventListener("click", startGame);
  els.pauseButton.addEventListener("click", pauseGame);
  els.resumeButton.addEventListener("click", resumeGame);
  els.quitButton.addEventListener("click", leaveGame);
  els.retryButton.addEventListener("click", startGame);
  els.newMixButton.addEventListener("click", () => { els.songPicker.value = ""; els.songPicker.click(); });
  els.testPercussionButton.addEventListener("click", testPercussion);
  els.percussionSelect.addEventListener("change", () => {
    drumPrefs.preset = els.percussionSelect.value;
    saveDrumPrefs();
  });
  els.percussionVolume.addEventListener("input", () => {
    drumPrefs.volume = A.clamp(Number(els.percussionVolume.value) || 0, 0, 30);
    els.percussionVolumeLabel.value = `${drumPrefs.volume}%`;
    els.percussionVolumeLabel.textContent = `${drumPrefs.volume}%`;
    saveDrumPrefs();
  });

  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("keydown", (event) => {
    if (!screens.game.classList.contains("active")) return;
    if (event.code === "Escape") {
      event.preventDefault();
      if (game && game.paused) resumeGame(); else pauseGame();
      return;
    }
    const lane = KEY_TO_LANE.get(event.code);
    if (lane === undefined) return;
    event.preventDefault();
    if (event.repeat || (game && game.laneDown[lane])) return;
    if (game) game.laneDown[lane] = true;
    hitLane(lane);
  });
  window.addEventListener("keyup", (event) => {
    const lane = KEY_TO_LANE.get(event.code);
    if (lane !== undefined && game) game.laneDown[lane] = false;
  });
  window.addEventListener("blur", () => {
    if (game && !game.paused && !game.ending && screens.game.classList.contains("active")) pauseGame();
  });
  els.canvas.addEventListener("pointerdown", (event) => {
    if (!game || game.paused) return;
    event.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    const lane = laneFromPointer(event.clientX - rect.left);
    if (lane >= 0) hitLane(lane);
  });

  window.__MALLOW_DEBUG__ = {
    get state() { return document.documentElement.dataset.mallowState; },
    get selection() { return selection; },
    get game() { return game; },
    get drumPrefs() { return { ...drumPrefs }; },
    curate,
    startGame,
    finishGame,
    hitLane,
    laneGeometry,
  };

  bootstrap();
})();
