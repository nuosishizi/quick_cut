import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildResolveAss,
  buildResolveDcst,
  buildResolveFcpxml,
  buildResolveItt,
  buildResolveSrt,
  buildResolveVtt,
  fcpxTime,
  fileUrl,
  keptSourceSegments,
  normalizeTimelineClips,
  resolveTimebase,
  wrapCaptionText,
  writeResolveTimeline,
  buildResolveCaptionCues,
  applyCaptionTextCase,
  isCaptionWordMotion,
  resolveFormatName,
  alignExportToFirstClip,
  buildResolveXmeml,
} from "../src/resolve-export.mjs";

test("kept source segments skip removed rereads", () => {
  const segments = keptSourceSegments(10, [{ start: 2, end: 3.5 }]);
  assert.deepEqual(segments, [
    { sourceStart: 0, sourceEnd: 2 },
    { sourceStart: 3.5, sourceEnd: 10 },
  ]);
});

test("FCPXML uses source in/out so Resolve can reopen the cut timeline", () => {
  const xml = buildResolveFcpxml({
    inputPath: "C:\\Users\\newnew\\video.mp4",
    projectName: "God Hates These 3 Sins",
    sourceDuration: 10,
    width: 1080,
    height: 1920,
    fps: 30,
    clips: [
      { start: 0, end: 2, sourceStart: 0, sourceEnd: 2, name: "take-a" },
      { start: 2, end: 6, sourceStart: 3.5, sourceEnd: 7.5, name: "take-b" },
    ],
    captions: [
      { text: "Why I say to you", start: 0.2, end: 1.8 },
      { text: "All manner of sin", start: 2.1, end: 4.4 },
    ],
    captionStyle: { fontFamily: "Montserrat", fontSize: 64, fontWeight: 800, color: "#fff4d1", stroke: 4, highlightEnabled: false },
    captionTransform: { x: 0, y: 538, width: 860, scale: 1 },
  });
  assert.match(xml, /<fcpxml version="1.9">/);
  assert.match(xml, /file:\/\/localhost\/C:\/Users\/newnew\/video\.mp4/);
  assert.match(xml, /<media-rep kind="original-media"/);
  assert.match(xml, /FFVideoFormat1080x1920p30/);
  assert.match(xml, /width="1080" height="1920"/);
  assert.match(xml, /audioRole="dialogue"/);
  assert.match(xml, /offset="0\/30s"/);
  assert.match(xml, /offset="60\/30s"/);
  assert.match(xml, /value="105\/30s"/);
  assert.match(xml, /value="225\/30s"/);
  assert.match(xml, /Why I say to you/);
  assert.match(xml, /All manner of sin/);
  assert.match(xml, /font="Montserrat"/);
  assert.match(xml, /fontSize="64"/);
  assert.match(xml, /strokeWidth="4"/);
  assert.match(xml, /Position[^>]+value="0.0 -538.0"/);
  assert.match(xml, /<asset-clip /);
  assert.match(xml, /<effect id="r3" name="Basic Title"/);
  assert.match(xml, /<title ref="r3"/);
});

test("adjacent clips do not overlap after frame snapping", () => {
  const xml = buildResolveFcpxml({
    inputPath: "C:\\Users\\newnew\\video.mp4",
    sourceDuration: 10,
    fps: 30,
    clips: [
      { start: 0, end: 20.4, sourceStart: 0.76, sourceEnd: 21.16, name: "片段 1" },
      { start: 20.4, end: 20.733, sourceStart: 21.5, sourceEnd: 21.833, name: "片段 2" },
      { start: 20.7, end: 35.76, sourceStart: 21.9, sourceEnd: 36.96, name: "片段 3" },
    ],
    captions: [],
  });
  const clips = [...xml.matchAll(/offset="(\d+)\/30s"[^>]*duration="(\d+)\/30s"/g)].map((match) => ({
    offset: Number(match[1]),
    duration: Number(match[2]),
  }));
  assert.ok(clips.length >= 3);
  for (let index = 1; index < clips.length; index += 1)
    assert.ok(
      clips[index].offset >= clips[index - 1].offset + clips[index - 1].duration,
      `clip ${index} overlaps previous`,
    );
});

test("quoted caption titles stay well-formed after name truncation", () => {
  const xml = buildResolveFcpxml({
    inputPath: "C:\\Users\\newnew\\video.mp4",
    sourceDuration: 4,
    width: 1080,
    height: 1920,
    fps: 30,
    clips: [{ start: 0, end: 4, sourceStart: 0, sourceEnd: 4, name: "main" }],
    captions: [
      {
        text: `""I only stretched the truth a little.`,
        start: 0,
        end: 1.5,
        words: [
          { display: `""I`, start: 0, end: 0.23 },
          { display: "only", start: 0.23, end: 0.56 },
          { display: "stretched", start: 0.56, end: 0.96 },
          { display: "the", start: 0.96, end: 1.13 },
          { display: "truth", start: 1.13, end: 1.36 },
          { display: "a", start: 1.36, end: 1.6 },
          { display: "little.", start: 1.6, end: 1.67 },
        ],
      },
    ],
    captionStyle: { fontSize: 58, highlight: "#ffd21f", highlightEnabled: true },
  });
  assert.match(xml, /name="&quot;&quot;I only stretched the truth a · &quot;&quot;I"/);
  assert.doesNotMatch(xml, /&(?:quot|amp|lt|gt)(?!;)/);
  for (const name of [...xml.matchAll(/\bname="([^"]*)"/g)].map((match) => match[1])) {
    assert.doesNotMatch(
      name,
      /&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9A-Fa-f]+);)/,
      `broken entity in name="${name}"`,
    );
  }
});

test("word highlight is baked into sequential FCPXML titles", () => {
  const xml = buildResolveFcpxml({
    inputPath: "C:\\Users\\newnew\\video.mp4",
    sourceDuration: 4,
    width: 1080,
    height: 1920,
    fps: 30,
    clips: [{ start: 0, end: 4, sourceStart: 0, sourceEnd: 4, name: "main" }],
    captions: [
      {
        text: "Why I say",
        start: 0,
        end: 1.5,
        words: [
          { display: "Why", start: 0, end: 0.4 },
          { display: "I", start: 0.4, end: 0.75 },
          { display: "say", start: 0.75, end: 1.5 },
        ],
      },
    ],
    captionStyle: { fontSize: 58, highlight: "#ffd21f", highlightEnabled: true },
  });
  assert.equal((xml.match(/<title /g) || []).length, 3);
  assert.match(xml, /fontColor="1.000 0.824 0.122 1.000"/);
});

test("long captions wrap to two lines and keep font size in ASS", () => {
  const style = { fontFamily: "Helvetica", fontSize: 58 };
  const lines = wrapCaptionText(
    "We're treating as ordinary something He calls holy.",
    style,
    1080,
    720,
  );
  assert.ok(lines.length >= 2, `expected wrap, got ${JSON.stringify(lines)}`);
  const ass = buildResolveAss(
    [{ text: "We're treating as ordinary something He calls holy.", start: 0, end: 3 }],
    { width: 1080, height: 1920, captionStyle: style, captionTransform: { width: 720, y: 538 } },
  );
  assert.match(ass, /\\N/);
  assert.match(ass, /Style: Default,Helvetica,58,/);
  const srt = buildResolveSrt(
    [{ text: "We're treating as ordinary something He calls holy.", start: 0, end: 3 }],
    { width: 1080, height: 1920, captionStyle: style, captionTransform: { width: 720 } },
  );
  assert.match(srt, /\nWe're treating[\s\S]*\n/);
});

test("Resolve subtitle files keep color, size, outline, wrap and word highlight", () => {
  const input = {
    projectName: "测试2",
    width: 1080,
    height: 1920,
    fps: 30,
    captionStyle: {
      fontFamily: "Helvetica",
      fontSize: 58,
      fontWeight: 800,
      color: "#fff4d1",
      highlight: "#ffd21f",
      highlightEnabled: true,
      stroke: 3,
      strokeColor: "#000000",
      shadow: 3,
      animation: "karaoke",
    },
    captionTransform: { x: 0, y: 538, width: 720 },
    captions: [
      {
        text: "We're treating as ordinary something He calls holy.",
        start: 0,
        end: 2.4,
        words: [
          { display: "We're", start: 0, end: 0.3 },
          { display: "treating", start: 0.3, end: 0.6 },
          { display: "as", start: 0.6, end: 0.8 },
          { display: "ordinary", start: 0.8, end: 1.1 },
          { display: "something", start: 1.1, end: 1.4 },
          { display: "He", start: 1.4, end: 1.6 },
          { display: "calls", start: 1.6, end: 1.9 },
          { display: "holy.", start: 1.9, end: 2.4 },
        ],
      },
    ],
  };
  const ttml = buildResolveItt(input.captions, input);
  assert.match(ttml, /tts:color="#fff4d1"/);
  assert.match(ttml, /tts:fontSize="58px"/);
  assert.match(ttml, /tts:textOutline="#000000 3px"/);
  assert.match(ttml, /<br\/>/);
  assert.match(ttml, /style="hi"/);
  assert.match(ttml, /tts:wrapOption="wrap"/);
  assert.ok((ttml.match(/<p /g) || []).length >= 6);
  const dcst = buildResolveDcst(input.captions, input);
  assert.match(dcst, /<DCSubtitle Version="1.0">/);
  assert.match(dcst, /Color="FFFFF4D1"/);
  assert.match(dcst, /Size="58"/);
  assert.match(dcst, /Effect="border"/);
  assert.match(dcst, /<Font Color="FFFFD21F">/);
  assert.ok((dcst.match(/<Text /g) || []).length >= 2);
  const vtt = buildResolveVtt(input.captions, input);
  assert.match(vtt, /font-size: 58px/);
  assert.match(vtt, /color: #fff4d1/);
  assert.match(vtt, /<c\.hi>/);
  assert.match(vtt, /\nWe're treating[\s\S]*\n/);
});

test("SRT uses the edited timeline times", () => {
  const srt = buildResolveSrt([
    { text: "Why I say to you", start: 0.2, end: 1.8 },
  ]);
  assert.match(srt, /00:00:00,200 --> 00:00:01,800/);
  assert.match(srt, /Why I say to you/);
});

test("writeResolveTimeline saves xml and srt together", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-resolve-"));
  const outputPath = path.join(directory, "edit.fcpxml");
  const result = writeResolveTimeline({
    outputPath,
    inputPath: path.join(directory, "source.mp4"),
    sourceDuration: 5,
    fps: 24,
    removals: [{ start: 1, end: 2 }],
    captions: [{ text: "Hello", start: 0, end: 0.8 }],
  });
  assert.equal(result.clipCount, 2);
  assert.equal(result.captionCount, 1);
  assert.equal(fs.existsSync(result.xmlPath), true);
  assert.equal(fs.existsSync(result.xmemlPath), true);
  assert.match(fs.readFileSync(result.xmemlPath, "utf8"), /<xmeml version="5">/);
  assert.equal(fs.existsSync(result.srtPath), true);
  assert.equal(fs.existsSync(result.assPath), true);
  assert.equal(fs.existsSync(result.ittPath), true);
  assert.equal(fs.existsSync(result.ttmlPath), true);
  assert.equal(fs.existsSync(result.dfxpPath), true);
  assert.equal(fs.existsSync(result.vttPath), true);
  assert.equal(fs.existsSync(result.webvttPath), true);
  assert.equal(fs.existsSync(result.subtitleXmlPath), true);
  assert.match(fs.readFileSync(result.ttmlPath, "utf8"), /tts:fontSize="58px"|tts:color/);
  assert.match(fs.readFileSync(result.subtitleXmlPath, "utf8"), /<tt /);
  const xml = fs.readFileSync(result.xmlPath, "utf8");
  assert.match(xml, /<spine>/);
  assert.match(fs.readFileSync(result.assPath, "utf8"), /PlayResX: 1080/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("spoken highlight becomes karaoke events in the Resolve ASS", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-resolve-k-"));
  const outputPath = path.join(directory, "karaoke.fcpxml");
  const result = writeResolveTimeline({
    outputPath,
    inputPath: path.join(directory, "source.mp4"),
    sourceDuration: 3,
    width: 1080,
    height: 1920,
    fps: 30,
    captionStyle: {
      fontSize: 58,
      highlight: "#ffd21f",
      highlightEnabled: true,
      animation: "fade",
    },
    captionTransform: { x: 0, y: 538, width: 860, scale: 1 },
    captions: [
      {
        text: "Why I say",
        start: 0,
        end: 1.5,
        words: [
          { display: "Why", start: 0, end: 0.4 },
          { display: "I", start: 0.4, end: 0.75 },
          { display: "say", start: 0.75, end: 1.5 },
        ],
      },
    ],
  });
  assert.equal(result.karaoke, true);
  const ass = fs.readFileSync(result.assPath, "utf8");
  assert.equal((ass.match(/^Dialogue:/gm) || []).length >= 3, true);
  assert.match(ass, /\\1c/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("drop-frame rates stay on a Resolve-friendly timebase", () => {
  const timebase = resolveTimebase(29.97);
  assert.equal(timebase.num, 30000);
  assert.equal(fcpxTime(1, timebase), "30030/30000s");
  assert.match(fileUrl("/tmp/a b.mp4"), /a%20b\.mp4/);
  assert.equal(normalizeTimelineClips({ clips: [] , sourceDuration: 0 }).length, 0);
  assert.equal(resolveFormatName(1080, 1920, resolveTimebase(30)), "FFVideoFormat1080x1920p30");
  assert.equal(resolveFormatName(1920, 1080, resolveTimebase(30)), "FFVideoFormat1080p30");
});

test("FCP7 XML keeps timeline start at zero and source in/out separate", () => {
  const xml = buildResolveXmeml({
    inputPath: "C:\\Users\\newnew\\video.mp4",
    sourceDuration: 80,
    width: 1080,
    height: 1920,
    fps: 30,
    clips: [
      { start: 20 + 16 / 30, end: 80, sourceStart: 20 + 16 / 30, sourceEnd: 80, name: "take-a" },
    ],
  });
  assert.match(xml, /<xmeml version="5">/);
  assert.match(xml, /<start>0<\/start>/);
  assert.match(xml, /<in>616<\/in>/);
  assert.match(xml, /<out>2400<\/out>/);
  assert.match(xml, /<string>00:00:00:00<\/string>/);
});

test("trimmed source in-point stays at timeline zero instead of leaving a hole", () => {
  const sourceStart = 20 + 16 / 30;
  const xml = buildResolveFcpxml({
    inputPath: "C:\\Users\\newnew\\video.mp4",
    sourceDuration: 80,
    width: 1080,
    height: 1920,
    fps: 30,
    clips: [
      { start: 20 + 16 / 30, end: 80, sourceStart, sourceEnd: 80, name: "take-a" },
    ],
    captions: [{ text: "hello", start: 21, end: 22 }],
    captionStyle: { highlightEnabled: false },
  });
  assert.equal(alignExportToFirstClip([{ start: sourceStart, end: 80 }]).origin, sourceStart);
  assert.match(xml, /offset="0\/30s"/);
  assert.match(xml, /start="0\/30s"/);
  assert.match(xml, /value="616\/30s"/);
  assert.doesNotMatch(xml, /<gap name="空隙" offset="0\/30s"/);
  const firstClip = xml.match(/<asset-clip ref="r2"[^>]*>/);
  assert.ok(firstClip);
  assert.doesNotMatch(firstClip[0], /start="616\/30s"/);
});

test("FCPXML splits captions across cuts and keeps titles inside the parent clip", () => {
  const xml = buildResolveFcpxml({
    inputPath: "C:\\Users\\newnew\\video.mp4",
    sourceDuration: 8,
    width: 1080,
    height: 1920,
    fps: 30,
    clips: [
      { start: 0, end: 2, sourceStart: 0, sourceEnd: 2, name: "take-a" },
      { start: 2, end: 6, sourceStart: 3.5, sourceEnd: 7.5, name: "take-b" },
    ],
    captionStyle: { highlightEnabled: false },
    captions: [{ text: "spans the cut", start: 1.5, end: 3.5 }],
  });
  const titles = [...xml.matchAll(/<title [^>]*offset="(\d+)\/30s"[^>]*duration="(\d+)\/30s"/g)].map((match) => ({
    offset: Number(match[1]),
    duration: Number(match[2]),
  }));
  assert.equal(titles.length, 2);
  assert.equal(titles[0].offset, 45);
  assert.equal(titles[0].duration, 15);
  assert.equal(titles[1].offset, 0);
  assert.equal(titles[1].duration, 45);
  assert.match(xml, /spans the cut/);
});

test("FCPXML includes overlay video, image, text and audio as connected clips", () => {
  const xml = buildResolveFcpxml({
    inputPath: "C:\\Users\\newnew\\video.mp4",
    sourceDuration: 6,
    width: 1080,
    height: 1920,
    fps: 30,
    clips: [{ start: 0, end: 4, sourceStart: 0, sourceEnd: 4, name: "main" }],
    captions: [{ text: "hello", start: 0.2, end: 1 }],
    videoLayers: [
      { path: "C:\\Users\\newnew\\overlay.mp4", start: 2, end: 4, sourceStart: 0, name: "overlay" },
    ],
    images: [{ path: "C:\\Users\\newnew\\logo.png", start: 3, end: 4.5, x: 10, y: 20, name: "logo" }],
    titles: [{ text: "标题字", start: 1.5, end: 3, x: 0, y: -120 }],
    audioAssets: [{ path: "C:\\Users\\newnew\\music.mp3", start: 1, end: 5, volume: 0.5, name: "music" }],
  });
  assert.match(xml, /overlay\.mp4/);
  assert.match(xml, /logo\.png/);
  assert.match(xml, /music\.mp3/);
  assert.match(xml, /标题字/);
  assert.match(xml, /lane="-1"/);
  assert.match(xml, /adjust-transform/);
  assert.match(xml, /adjust-volume amount="-6.0dB"/);
  assert.match(xml, /<media-rep kind="original-media"/);
});

test("Resolve send cues match preview highlight, wrap, and word motion", () => {
  assert.equal(isCaptionWordMotion("word-pop"), true);
  assert.equal(applyCaptionTextCase("why I", "title"), "Why I");
  const wrapped = buildResolveCaptionCues(
    {
      text: "doesn't it feel like",
      start: 0,
      end: 2,
      words: [
        { display: "doesn't", start: 0, end: 0.4 },
        { display: "it", start: 0.4, end: 0.7 },
        { display: "feel", start: 0.7, end: 1.2 },
        { display: "like", start: 1.2, end: 2 },
      ],
    },
    {
      width: 1080,
      height: 1920,
      captionStyle: { fontSize: 58, highlightEnabled: true, animation: "word-pop" },
      captionTransform: { width: 280, y: 538 },
    },
  );
  assert.ok(wrapped.length >= 3);
  assert.ok(wrapped.some((cue) => cue.text.includes("\n") || cue.runs.some((run) => run.text.includes("\n"))));
  const active = wrapped[2];
  assert.equal(active.runs.some((run) => run.grow && run.highlight), true);
  const linePulse = buildResolveCaptionCues(
    {
      text: "doesn't it feel like",
      start: 0,
      end: 2,
      words: [
        { display: "doesn't", start: 0, end: 0.4 },
        { display: "it", start: 0.4, end: 0.7 },
        { display: "feel", start: 0.7, end: 1.2 },
        { display: "like", start: 1.2, end: 2 },
      ],
    },
    {
      width: 1080,
      height: 1920,
      captionStyle: { fontSize: 58, highlightEnabled: true, animation: "line-pulse" },
      captionTransform: { width: 860, y: 538 },
    },
  );
  const second = linePulse[1];
  const hotWords = second.runs.filter((run) => run.highlight).map((run) => run.text).join("");
  assert.match(hotWords, /doesn't/);
  assert.match(hotWords, /it/);
});
