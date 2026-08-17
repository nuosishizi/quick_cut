const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * clamp(ratio, 0, 1))];
}

export function samplesToFrames(samples, sampleRate = 8000, frameMs = 20) {
  const size = Math.max(16, Math.round((sampleRate * frameMs) / 1000));
  const frames = [];
  for (let offset = 0; offset < samples.length; offset += size) {
    let squares = 0;
    let peak = 0;
    let crossings = 0;
    let absoluteDelta = 0;
    let previous = samples[offset] || 0;
    const end = Math.min(samples.length, offset + size);
    for (let index = offset; index < end; index += 1) {
      const value = samples[index] || 0;
      squares += value * value;
      peak = Math.max(peak, Math.abs(value));
      if (value >= 0 !== previous >= 0) crossings += 1;
      absoluteDelta += Math.abs(value - previous);
      previous = value;
    }
    frames.push({
      start: offset / sampleRate,
      end: end / sampleRate,
      rms: Math.sqrt(squares / Math.max(1, end - offset)),
      peak,
      zcr: crossings / Math.max(1, end - offset),
      delta: absoluteDelta / Math.max(1, end - offset),
      crest: peak / Math.max(0.000001, Math.sqrt(squares / Math.max(1, end - offset))),
    });
  }
  return frames;
}

function bridgeShortRuns(flags, maxFrames) {
  const output = [...flags];
  let index = 0;
  while (index < output.length) {
    if (output[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < output.length && !output[index]) index += 1;
    if (start > 0 && index < output.length && index - start <= maxFrames) {
      for (let cursor = start; cursor < index; cursor += 1)
        output[cursor] = true;
    }
  }
  return output;
}

function sustainedVoiceFlags(frames, floor, quiet, voice) {
  const energyThreshold = Math.max(
    0.0008,
    floor * 2.15,
    quiet * 1.22,
    voice * 0.075,
  );
  const raw = frames.map((frame, index) => {
    const neighborhood = frames.slice(Math.max(0, index - 3), index + 4),
      localMin = Math.max(0.000001, Math.min(...neighborhood.map((item) => item.rms))),
      localMax = Math.max(...neighborhood.map((item) => item.rms)),
      modulation = localMax / localMin,
      deltaRatio = Number(frame.delta || 0) / Math.max(0.000001, frame.rms),
      speechBand = frame.zcr >= 0.012 && frame.zcr <= 0.34,
      speechShape = speechBand || modulation >= 1.24 || (frame.crest >= 2.1 && frame.zcr < 0.42);
    return frame.rms >= energyThreshold && speechShape && deltaRatio >= 0.035;
  });
  // A click or a single noise burst is not speech.  Require 60 ms of evidence
  // inside a 100 ms window, then retain the natural 100 ms voice hangover.
  const sustained = raw.map((_, index) => {
    let count = 0;
    for (let cursor = Math.max(0, index - 2); cursor <= Math.min(raw.length - 1, index + 2); cursor += 1)
      if (raw[cursor]) count += 1;
    return count >= 3;
  });
  return bridgeShortRuns(sustained, 5);
}

export function analyzePauseFrames(frames, options = {}) {
  const keepSeconds = clamp(Number(options.keepSeconds ?? 0.3), 0.05, 1);
  const minPauseSeconds = clamp(Number(options.minPauseSeconds ?? options.keepSeconds ?? 0.3), 0.1, 5);
  const edgeKeepSeconds = clamp(
    Number(options.edgeKeepSeconds ?? 0.1),
    0.05,
    0.5,
  );
  const sensitivity = clamp(Number(options.sensitivity ?? 0.42), 0, 1);
  const preRollSeconds = Number(options.preRollSeconds);
  const postRollSeconds = Number(options.postRollSeconds);
  const startPad = Number.isFinite(preRollSeconds)
    ? clamp(preRollSeconds, 0, 1)
    : keepSeconds / 2;
  const endPad = Number.isFinite(postRollSeconds)
    ? clamp(postRollSeconds, 0, 1)
    : keepSeconds / 2;
  if (!frames.length) return { removals: [], pauses: [], diagnostics: {} };
  const rmsValues = frames.map((frame) => frame.rms);
  const peakValues = frames.map((frame) => frame.peak);
  const floor = percentile(rmsValues, 0.1);
  const quiet = percentile(rmsValues, 0.25);
  const voice = Math.max(percentile(rmsValues, 0.78), quiet * 2.4, 0.002);
  // Higher sensitivity raises the silence threshold to overcome steady room/mic noise
  let rmsThreshold = clamp(
    floor * (1.5 + sensitivity * 1.5) + voice * (0.015 + sensitivity * 0.025),
    0.0007,
    voice * 0.20,
  );
  if (Number.isFinite(Number(options.thresholdDb))) {
    const fromDb = 10 ** (Number(options.thresholdDb) / 20);
    rmsThreshold = clamp(Math.max(rmsThreshold, fromDb * 0.35), 0.0007, voice * 0.35);
  }
  const peakThreshold = Math.max(
    percentile(peakValues, 0.2) * 2.1,
    rmsThreshold * 3.2,
  );
  const voiceFlags = sustainedVoiceFlags(frames, floor, quiet, voice),
    firstVoiceIndex = voiceFlags.findIndex(Boolean),
    lastVoiceIndex = voiceFlags.findLastIndex(Boolean),
    hasVoice = firstVoiceIndex >= 0 && lastVoiceIndex >= firstVoiceIndex,
    voiceStart = hasVoice ? frames[firstVoiceIndex].start : 0,
    voiceEnd = hasVoice ? frames[lastVoiceIndex].end : frames.at(-1).end;

  let speech = frames.map(
    (frame, index) =>
      (voiceFlags[index] || frame.rms > rmsThreshold * 1.8 || frame.peak > peakThreshold * 1.5) &&
      (frame.rms > rmsThreshold || frame.peak > peakThreshold || (frame.zcr > 0.08 && frame.rms > rmsThreshold * 0.55)),
  );
  const frameDuration = Math.max(0.005, frames[0].end - frames[0].start);
  speech = bridgeShortRuns(speech, Math.round(0.12 / frameDuration));

  const pauses = [];
  let index = 0;
  while (index < speech.length) {
    if (speech[index]) {
      index += 1;
      continue;
    }
    const startIndex = index;
    while (index < speech.length && !speech[index]) index += 1;
    const start = frames[startIndex].start;
    const end = frames[Math.min(frames.length - 1, index - 1)].end;
    const duration = end - start;
    const boundary = start <= voiceStart + frameDuration || end >= voiceEnd - frameDuration;
    if (!boundary && duration > Math.max(keepSeconds, minPauseSeconds) - 0.02)
      pauses.push({ start, end, duration, boundary: false });
  }
  const removals = pauses
    .map((pause) => {
      const start = pause.start + startPad;
      const end = pause.end - endPad;
      return {
        start,
        end,
        duration: Math.max(0, end - start),
        source: "pause",
      };
    })
    .filter((range) => range.duration > 0.035);
  if (hasVoice && voiceStart > edgeKeepSeconds + 0.035)
    removals.unshift({
      start: 0,
      end: voiceStart - edgeKeepSeconds,
      duration: voiceStart - edgeKeepSeconds,
      source: "edge",
    });
  if (hasVoice && frames.at(-1).end - voiceEnd > edgeKeepSeconds + 0.035)
    removals.push({
      start: voiceEnd + edgeKeepSeconds,
      end: frames.at(-1).end,
      duration: frames.at(-1).end - voiceEnd - edgeKeepSeconds,
      source: "edge",
    });
  const leadingEdge = removals.find(
    (range) => range.source === "edge" && range.start <= frameDuration,
  );
  const trailingEdge = removals.find(
    (range) =>
      range.source === "edge" &&
      range.end >= frames.at(-1).end - frameDuration,
  );
  return {
    removals,
    pauses,
    // Keep explicit edge values as well as the removal ranges.  The editor
    // consumes the ranges, while diagnostics/tests can verify that opening
    // and closing silence are treated independently from internal pauses.
    headTrim: leadingEdge?.duration || 0,
    tailTrim: trailingEdge?.duration || 0,
    diagnostics: {
      floor,
      quiet,
      voice,
      rmsThreshold,
      peakThreshold,
      edgeKeepSeconds,
      voiceStart,
      voiceEnd,
      voiceDetected: hasVoice,
    },
  };
}

export function waveformPeaks(samples, points = 1600) {
  if (!samples.length || points <= 0) return [];
  const bucket = Math.max(1, Math.ceil(samples.length / points));
  const result = [];
  for (let offset = 0; offset < samples.length; offset += bucket) {
    let min = 1;
    let max = -1;
    for (
      let index = offset;
      index < Math.min(samples.length, offset + bucket);
      index += 1
    ) {
      const value = samples[index] || 0;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    result.push([Number(min.toFixed(4)), Number(max.toFixed(4))]);
  }
  return result;
}

export function mergeRanges(ranges, duration = Infinity) {
  const sorted = ranges
    .map((range) => ({
      ...range,
      start: clamp(Number(range.start), 0, duration),
      end: clamp(Number(range.end), 0, duration),
    }))
    .filter((range) => range.end - range.start > 0.001)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 0.008) {
      previous.end = Math.max(previous.end, range.end);
      previous.sources = [
        ...new Set(
          [...(previous.sources || [previous.source]), range.source].filter(
            Boolean,
          ),
        ),
      ];
      previous.duration = previous.end - previous.start;
    } else
      merged.push({
        ...range,
        duration: range.end - range.start,
        sources: range.sources || [range.source].filter(Boolean),
      });
  }
  return merged;
}

export function mapSourceTime(time, removals) {
  let removed = 0;
  for (const range of removals) {
    if (time >= range.end) removed += range.end - range.start;
    else if (time > range.start) return range.start - removed;
    else break;
  }
  return Math.max(0, time - removed);
}
