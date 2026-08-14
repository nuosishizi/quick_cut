import fs from "node:fs";
import {
  Whisper,
  WhisperFullParams,
  WhisperAlignmentHeadsPreset,
  WhisperSamplingStrategy,
  decodeAudioAsync,
} from "@napi-rs/whisper";

const [modelPath, audioPath] = process.argv.slice(2);
if (!modelPath || !audioPath) throw new Error("缺少本地语音模型或音频文件。");
const bytes = fs.readFileSync(audioPath);
const samples = await decodeAudioAsync(bytes, audioPath);
const whisper = new Whisper(modelPath, {
  useGpu: true,
  flashAttn: true,
  dtwTokenTimestamps: true,
  dtwAheadsPreset: WhisperAlignmentHeadsPreset.LargeV3,
});
const sampleRate = 16000;
const chunkSeconds = 45;
const overlapSeconds = 1.1;
const chunkSamples = Math.round(chunkSeconds * sampleRate);
const stepSamples = Math.round((chunkSeconds - overlapSeconds) * sampleRate);
const starts = [];
for (let start = 0; start < samples.length; start += stepSamples) {
  starts.push(start);
  if (start + chunkSamples >= samples.length) break;
}
const transcripts = [];

function words(text) {
  return String(text || "").match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) || [];
}

function fallbackSegments(text, start, end, chunkIndex) {
  const tokens = words(text);
  if (!tokens.length) return [];
  const groups = [];
  for (let index = 0; index < tokens.length; index += 12)
    groups.push(tokens.slice(index, index + 12));
  let consumed = 0;
  return groups.map((group) => {
    const segmentStart = start + ((end - start) * consumed) / tokens.length;
    consumed += group.length;
    const segmentEnd = start + ((end - start) * consumed) / tokens.length;
    return {
      text: group.join(" "),
      start: segmentStart,
      end: Math.max(segmentStart + 0.04, segmentEnd),
      chunkIndex,
      chunkOffset: start,
      timebase: "seconds",
      recovered: true,
    };
  });
}

process.stdout.write(`${JSON.stringify({ type: "progress", value: 3 })}\n`);
for (let chunkIndex = 0; chunkIndex < starts.length; chunkIndex += 1) {
  const sampleStart = starts[chunkIndex];
  const sampleEnd = Math.min(samples.length, sampleStart + chunkSamples);
  const offsetSeconds = sampleStart / sampleRate;
  const params = new WhisperFullParams(WhisperSamplingStrategy.BeamSearch);
  params.language = "en";
  params.translate = false;
  // Each window is grounded in its own audio. A hallucination or reading
  // error in one window can never become the text prompt for all later audio.
  params.noContext = true;
  params.singleSegment = false;
  params.printProgress = false;
  params.printRealtime = false;
  params.printTimestamps = false;
  params.tokenTimestamps = true;
  params.splitOnWord = true;
  params.maxLen = 24;
  params.suppressBlank = true;
  params.suppressNonSpeechTokens = true;
  params.nThreads = 8;
  params.onProgress = (value) => {
    const overall =
      ((chunkIndex + Math.max(0, Math.min(100, value)) / 100) /
        Math.max(1, starts.length)) *
      100;
    process.stdout.write(
      `${JSON.stringify({ type: "progress", value: overall })}\n`,
    );
  };
  const callbackSegments = [];
  params.onNewSegment = (segment) => callbackSegments.push(segment);
  const fullText = String(
    whisper.full(params, samples.subarray(sampleStart, sampleEnd)) || "",
  ).trim();

  // @napi-rs/whisper forwards whisper.cpp's raw t0/t1 values. Those values
  // are centiseconds (10 ms ticks), not seconds. The old implementation used
  // them as seconds, so a 3.2 second first sentence ended at 320 seconds and
  // every later caption was filtered beyond the video duration.
  // The native callback is non-blocking as well; yield twice so every queued
  // segment reaches JavaScript before this worker exits or starts a new pass.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const chunkDuration = (sampleEnd - sampleStart) / sampleRate;
  let emitted = callbackSegments
    .map((segment) => ({
      text: String(segment?.text || "").trim(),
      start:
        offsetSeconds +
        Math.max(0, Math.min(chunkDuration, Number(segment?.start || 0) / 100)),
      end:
        offsetSeconds +
        Math.max(0, Math.min(chunkDuration, Number(segment?.end || 0) / 100)),
      chunkIndex,
      chunkOffset: offsetSeconds,
      timebase: "seconds",
    }))
    .filter((segment) => segment.text && segment.end > segment.start);

  // Some native builds can return the complete text from full() while their
  // realtime callback delivers only its first segment. Never silently accept
  // that partial callback: rebuild safe timed groups for this window so the
  // complete recording still reaches forced alignment.
  const callbackWordCount = words(emitted.map((item) => item.text).join(" ")).length;
  const fullWordCount = words(fullText).length;
  const callbackCoverage = fullWordCount
    ? callbackWordCount / fullWordCount
    : emitted.length
      ? 1
      : 0;
  if (fullWordCount && (callbackCoverage < 0.82 || !emitted.length))
    emitted = fallbackSegments(
      fullText,
      offsetSeconds,
      offsetSeconds + chunkDuration,
      chunkIndex,
    );

  for (const segment of emitted)
    process.stdout.write(
      `${JSON.stringify({ type: "segment", segment })}\n`,
    );
  transcripts.push(fullText);
}
process.stdout.write(
  `${JSON.stringify({ type: "fallback", text: transcripts.filter(Boolean).join(" ") })}\n`,
);
process.stdout.write(`${JSON.stringify({ type: "done" })}\n`);
