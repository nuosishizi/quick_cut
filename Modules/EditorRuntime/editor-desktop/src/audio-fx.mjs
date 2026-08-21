const EFFECT_TYPES = new Set([
  "voice-isolation",
  "noise-reduction",
  "de-hummer",
  "dialogue-separator",
  "de-esser",
  "expander-gate",
  "parametric-eq",
  "compressor-limiter",
]);

const clamp = (value, minimum, maximum, fallback = minimum) => {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
};

const dbToLinear = (db) => Math.pow(10, Number(db || 0) / 20);

const DEFAULT_EQ_BANDS = Object.freeze([
  { type: "lowshelf", frequency: 90, gain: 0, q: 0.7, enabled: true },
  { type: "bell", frequency: 180, gain: 0, q: 1.0, enabled: true },
  { type: "bell", frequency: 500, gain: 0, q: 1.1, enabled: true },
  { type: "bell", frequency: 2500, gain: 0, q: 1.0, enabled: true },
  { type: "bell", frequency: 6500, gain: 0, q: 1.2, enabled: true },
  { type: "highshelf", frequency: 12000, gain: 0, q: 0.7, enabled: true },
]);

export const AUDIO_FX_MAX_SLOTS = 6;

export const AUDIO_FX_LABELS = Object.freeze({
  "voice-isolation": "人声隔离",
  "noise-reduction": "噪声降低",
  "de-hummer": "电流嗡声消除",
  "dialogue-separator": "对话分离",
  "de-esser": "去齿音",
  "expander-gate": "扩展器 / 噪声门",
  "parametric-eq": "六段参数均衡器",
  "compressor-limiter": "压缩器 / 限幅器",
});

export function defaultAudioFxParams(type) {
  switch (type) {
    case "voice-isolation":
      return { amount: 0.82, voiceProtect: 0.68, artifactControl: 0.5 };
    case "noise-reduction":
      return {
        mode: "auto", reductionDb: 12, noiseFloorDb: -48, sensitivity: 0.55,
        smoothing: 12, attackMs: 20, releaseMs: 180, learnedBands: [],
        learnedAt: 0, learnedDuration: 0,
      };
    case "de-hummer":
      return { frequency: "auto", detectedFrequency: 0, reductionDb: 18, harmonics: 4, q: 28 };
    case "dialogue-separator":
      return { voiceDb: 1.5, backgroundDb: -10, ambienceDb: -6, focus: 0.7 };
    case "de-esser":
      return { frequency: 0.58, threshold: 0.38, reduction: 0.55, listen: false };
    case "expander-gate":
      return { thresholdDb: -42, ratio: 2.2, rangeDb: -18, attackMs: 12, holdMs: 70, releaseMs: 220 };
    case "parametric-eq":
      return { bands: DEFAULT_EQ_BANDS.map((band) => ({ ...band })) };
    case "compressor-limiter":
      return {
        thresholdDb: -18, ratio: 3, attackMs: 12, releaseMs: 180,
        makeupDb: 1.5, mix: 1, limiter: true, ceilingDb: -0.8,
      };
    default:
      return {};
  }
}

export function normalizeAudioFx(effect = {}, index = 0) {
  const type = EFFECT_TYPES.has(String(effect.type || ""))
    ? String(effect.type)
    : "noise-reduction";
  const defaults = defaultAudioFxParams(type);
  const params = { ...defaults, ...(effect.params || {}) };
  if (type === "parametric-eq") {
    params.bands = DEFAULT_EQ_BANDS.map((fallback, bandIndex) => ({
      ...fallback,
      ...(Array.isArray(effect.params?.bands) ? effect.params.bands[bandIndex] : {}),
    }));
  }
  return {
    id: String(effect.id || `audio-fx-${index + 1}`),
    type,
    name: String(effect.name || AUDIO_FX_LABELS[type]),
    enabled: effect.enabled !== false,
    expanded: effect.expanded !== false,
    params,
  };
}

export function normalizeAudioFxRack(rack = []) {
  return (Array.isArray(rack) ? rack : [])
    .slice(0, AUDIO_FX_MAX_SLOTS)
    .map(normalizeAudioFx);
}

function escapeFilterPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function eqBandFilter(band = {}) {
  if (band.enabled === false) return "";
  const frequency = Math.round(clamp(band.frequency, 20, 20000, 1000));
  const gain = clamp(band.gain, -18, 18, 0);
  const q = clamp(band.q, 0.1, 20, 1);
  if (Math.abs(gain) < 0.01 && !["highpass", "lowpass"].includes(band.type)) return "";
  if (band.type === "highpass") return `highpass=f=${frequency}:p=2`;
  if (band.type === "lowpass") return `lowpass=f=${frequency}:p=2`;
  if (band.type === "lowshelf") return `lowshelf=f=${frequency}:t=q:w=${q.toFixed(3)}:g=${gain.toFixed(2)}`;
  if (band.type === "highshelf") return `highshelf=f=${frequency}:t=q:w=${q.toFixed(3)}:g=${gain.toFixed(2)}`;
  return `equalizer=f=${frequency}:t=q:w=${q.toFixed(3)}:g=${gain.toFixed(2)}`;
}

export function audioFxFilters(effect = {}, context = {}) {
  const normalized = normalizeAudioFx(effect);
  if (!normalized.enabled || context.bypass) return [];
  const params = normalized.params;
  switch (normalized.type) {
    case "voice-isolation": { // RNNoise plus a deliberately light residual spectral pass.
      const amount = clamp(params.amount, 0, 1, 0.82);
      const protect = clamp(params.voiceProtect, 0, 1, 0.68);
      const artifact = clamp(params.artifactControl, 0, 1, 0.5);
      const filters = ["aresample=48000"];
      if (context.rnnoiseModel) {
        const mix = clamp(0.28 + amount * 0.67 - artifact * 0.08, 0.15, 0.94, 0.8);
        filters.push(`arnndn=m='${escapeFilterPath(context.rnnoiseModel)}':mix=${mix.toFixed(3)}`);
      }
      const reduction = clamp(4 + amount * 10 - protect * 2.5, 2, 15, 9);
      filters.push(`afftdn=nr=${reduction.toFixed(2)}:nf=-50:tn=1:tr=1:ad=${(0.72 + artifact * 0.18).toFixed(3)}:gs=${Math.round(8 + artifact * 12)}`);
      return filters;
    }
    case "noise-reduction": {
      const reduction = clamp(params.reductionDb, 0.01, 32, 12);
      const floor = clamp(params.noiseFloorDb, -80, -20, -48);
      const sensitivity = clamp(params.sensitivity, 0, 1, 0.55);
      const smoothing = Math.round(clamp(params.smoothing, 0, 50, 12));
      // afftdn does not expose separate attack/release controls.  Map the UI
      // envelope to its adaptivity and temporal gain smoothing so both knobs
      // remain meaningful without inserting a gate that could clip speech.
      const attackMs = clamp(params.attackMs, 1, 500, 20);
      const releaseMs = clamp(params.releaseMs, 20, 3000, 180);
      const attackFactor = Math.log10(attackMs + 9) / Math.log10(509);
      const releaseFactor = Math.log10(releaseMs + 80) / Math.log10(3080);
      const adaptivity = clamp(
        0.84 - sensitivity * 0.34 + attackFactor * 0.12 + releaseFactor * 0.08,
        0.25, 1, 0.65,
      );
      const gainSmoothing = Math.round(clamp(
        smoothing + attackFactor * 5 + releaseFactor * 9,
        0, 50, smoothing,
      ));
      const learned = Array.isArray(params.learnedBands) && params.learnedBands.length === 15
        ? params.learnedBands.map((value) => clamp(value, -80, -20, -50).toFixed(2))
        : [];
      if (String(params.mode) === "learn" && learned.length)
        return [`afftdn=nt=c:bn=${learned.join("|")}:nr=${reduction.toFixed(2)}:nf=${floor.toFixed(2)}:tn=0:tr=1:ad=${adaptivity.toFixed(3)}:gs=${gainSmoothing}`];
      return [`afftdn=nr=${reduction.toFixed(2)}:nf=${floor.toFixed(2)}:tn=1:tr=1:ad=${adaptivity.toFixed(3)}:gs=${gainSmoothing}`];
    }
    case "de-hummer": {
      const forced = Number(params.frequency);
      const frequency = [50, 60].includes(forced) ? forced : Number(params.detectedFrequency || context.detectedHumFrequency || 0);
      if (![50, 60].includes(frequency)) return [];
      const gain = -clamp(params.reductionDb, 1, 36, 18);
      const q = clamp(params.q, 4, 80, 28);
      const harmonics = Math.round(clamp(params.harmonics, 1, 8, 4));
      return Array.from({ length: harmonics }, (_, index) => frequency * (index + 1))
        .filter((value) => value < 1200)
        .map((value) => `equalizer=f=${value}:t=q:w=${q.toFixed(2)}:g=${gain.toFixed(2)}`);
    }
    case "dialogue-separator": { // Open dialogue extraction plus center/side remix; no Blackmagic model is used.
      const voice = clamp(dbToLinear(params.voiceDb), 0.015625, 3.981, 1);
      const background = clamp(dbToLinear(params.backgroundDb), 0.015625, 1.995, 0.316);
      const ambience = clamp(dbToLinear(params.ambienceDb), 0.015625, 1.995, 0.501);
      const focus = clamp(params.focus, 0, 1, 0.7);
      if (context.dialogueEnhance === false) {
        const side = Math.sqrt(background * ambience);
        return [
          `stereotools=mlev=${(1 + (voice - 1) * focus).toFixed(4)}:slev=${(1 + (side - 1) * focus).toFixed(4)}:softclip=1`,
          `equalizer=f=2600:t=q:w=1.1:g=${(focus * 1.4).toFixed(2)}`,
        ];
      }
      return [
        `dialoguenhance=original=1:enhance=${(0.35 + focus * 2.25).toFixed(3)}:voice=${(2 + focus * 18).toFixed(2)}`,
        `pan=stereo|c0=${background.toFixed(5)}*FL+${(voice * 0.7071).toFixed(5)}*FC|c1=${background.toFixed(5)}*FR+${(voice * 0.7071).toFixed(5)}*FC`,
        `stereotools=mlev=1:slev=${ambience.toFixed(4)}:softclip=1`,
        `equalizer=f=2600:t=q:w=1.1:g=${(focus * 1.4).toFixed(2)}`,
      ];
    }
    case "de-esser":
      return [`deesser=i=${clamp(params.threshold, 0, 1, 0.38).toFixed(3)}:m=${clamp(params.reduction, 0, 1, 0.55).toFixed(3)}:f=${clamp(params.frequency, 0, 1, 0.58).toFixed(3)}:s=${params.listen ? "e" : "o"}`];
    case "expander-gate":
      return [`agate=threshold=${clamp(dbToLinear(params.thresholdDb), 0.0001, 1, 0.008).toFixed(6)}:ratio=${clamp(params.ratio, 1, 20, 2.2).toFixed(2)}:range=${clamp(dbToLinear(params.rangeDb), 0.001, 1, 0.126).toFixed(6)}:attack=${clamp(params.attackMs, 0.1, 1000, 12).toFixed(2)}:release=${clamp(Number(params.releaseMs || 220) + Number(params.holdMs || 0), 1, 9000, 290).toFixed(2)}:detection=rms`];
    case "parametric-eq":
      return (params.bands || []).map(eqBandFilter).filter(Boolean);
    case "compressor-limiter": { const filters = [];
      const threshold = clamp(dbToLinear(params.thresholdDb), 0.000976563, 1, 0.126);
      const makeup = clamp(dbToLinear(params.makeupDb), 1, 8, 1.19);
      filters.push(`acompressor=threshold=${threshold.toFixed(6)}:ratio=${clamp(params.ratio, 1, 20, 3).toFixed(2)}:attack=${clamp(params.attackMs, 0.1, 2000, 12).toFixed(2)}:release=${clamp(params.releaseMs, 1, 9000, 180).toFixed(2)}:makeup=${makeup.toFixed(4)}:mix=${clamp(params.mix, 0, 1, 1).toFixed(3)}`);
      if (params.limiter !== false)
        filters.push(`alimiter=limit=${clamp(dbToLinear(params.ceilingDb), 0.0625, 1, 0.912).toFixed(5)}:attack=5:release=80:level=0`);
      return filters;
    }
    default:
      return [];
  }
}

export function buildAudioFxFilterChain(rack = [], context = {}) {
  if (context.bypass) return "";
  return normalizeAudioFxRack(rack)
    .flatMap((effect) => audioFxFilters(effect, context))
    .filter(Boolean)
    .join(",");
}

const PROFILE_CENTERS = Object.freeze([80, 120, 180, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000, 5600, 8000, 12000]);

function goertzelMagnitude(samples, sampleRate, frequency) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0, previous2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, samples.length - 1));
    const current = Number(samples[index] || 0) * window + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  const power = Math.max(0, previous2 * previous2 + previous * previous - coefficient * previous * previous2);
  return 2 * Math.sqrt(power) / Math.max(1, samples.length);
}

export function learnNoiseBandProfile(samples, sampleRate = 24000) {
  if (!samples?.length) throw new Error("没有可用于学习的噪声样本。");
  const bands = PROFILE_CENTERS.map((frequency) => {
    const probes = [frequency * 0.88, frequency, frequency * 1.12]
      .filter((value) => value < sampleRate / 2 - 10)
      .map((value) => goertzelMagnitude(samples, sampleRate, value));
    const magnitude = Math.max(1e-8, ...probes);
    return Number(clamp(20 * Math.log10(magnitude), -80, -20, -60).toFixed(2));
  });
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + Number(value || 0) ** 2, 0) / samples.length);
  return {
    bands,
    centers: [...PROFILE_CENTERS],
    noiseFloorDb: Number(clamp(20 * Math.log10(rms + 1e-12), -80, -20, -55).toFixed(2)),
  };
}
