import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = fs.readFileSync(path.join(root, "src/ui.html"), "utf8");
const main = fs.readFileSync(path.join(root, "src/main.mjs"), "utf8");
const media = fs.readFileSync(path.join(root, "src/media.mjs"), "utf8");
const whisper = fs.readFileSync(path.join(root, "src/whisper.mjs"), "utf8");
const whisperWorker = fs.readFileSync(
  path.join(root, "src/whisper-worker.mjs"),
  "utf8",
);

test("all embedded UI scripts parse", () => {
  const scripts = [...ui.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const script of scripts) new Function(script[1]);
});

test("sidebar tabs cannot collapse or wrap", () => {
  assert.match(ui, /\.tabs\s*\{[\s\S]*?min-height:\s*39px;[\s\S]*?flex:\s*0 0 39px;/);
  assert.match(ui, /\.tab\s*\{[\s\S]*?white-space:\s*nowrap;/);
  assert.doesNotMatch(ui, /\.topbar \.toolbar \.btn:nth-child/);
});

test("new main media resets prior material modifiers", () => {
  assert.match(ui, /function resetMainMediaModifiers\(\)[\s\S]*?videoTransform\s*=\s*\{\s*x:\s*0,\s*y:\s*0,\s*scale:\s*1,\s*rotation:\s*0,\s*opacity:\s*1,\s*blendMode:\s*"normal"\s*\}/);
  assert.match(ui, /function resetMainMediaModifiers\(\)[\s\S]*?mainVideoClipSettings\s*=\s*\{\}/);
  assert.match(ui, /function resetMainMediaModifiers\(\)[\s\S]*?speed:\s*1/);
  assert.match(ui, /resetMainMediaModifiers\(\);\s*state\.video\s*=\s*\{\s*\.\.\.asset\s*\}/);
});

test("main timeline drag is smooth and persisted", () => {
  assert.match(ui, /mainTimelineOffset:\s*0/);
  assert.match(ui, /state\.mainVideoClipOffsets\[clipKey\]\s*=/);
  assert.match(ui, /state\.mainAudioClipOffsets\[clipKey\]\s*=/);
  assert.match(ui, /mainTimelineOffset:\s*state\.mainTimelineOffset/);
  assert.match(ui, /snapClipStart\(/);
});

test("project cards are vertical and preset previews stay contrasting", () => {
  assert.match(ui, /\.projectthumb\s*\{[\s\S]*?aspect-ratio:\s*9 \/ 16/);
  assert.match(ui, /function presetPreviewStroke/);
  assert.match(ui, /presetPreviewStroke\(p\.style, i\)/);
});

test("embedded editor runtime binds to loopback and leaves native window sizing to SwiftUI", () => {
  assert.match(main, /127\.0\.0\.1/);
  assert.match(main, /QUICKCUT_EMBED_PORT/);
  assert.doesNotMatch(main, /setMaximized\(true\)/);
});

test("project entry and panel resize avoid duplicate heavy rendering", () => {
  assert.match(ui, /await new Promise\(\(resolve\) => requestAnimationFrame\(resolve\)\)/);
  assert.match(ui, /function updateFrameSize\(force = false\)/);
  assert.match(ui, /if \(force\) renderPreviewObjects\(true\);[\s\S]*?else updatePreviewTransformOnly\(\);/);
});

test("manuscript gaps are locally cut and ripple every linked track", () => {
  assert.match(ui, /function cutScriptIssue\(id\)/);
  assert.match(ui, /data-cut-review/);
  assert.match(ui, /data-insert-review/);
  assert.match(ui, /function insertReviewSegment\(id\)/);
  assert.match(ui, /state\.removals\.push\(/);
  assert.match(ui, /shiftTracks\(start, end - start\)/);
  assert.match(ui, /rippleSubtitleTimeline\(at, at \+ len\)/);
  assert.doesNotMatch(ui, />⌫<\/button>/);
  assert.doesNotMatch(ui, /text: item\.type === "missing" \? "需补录" : "⌫"/);
  assert.match(ui, /function reviewClipText/);
  assert.match(ui, /未识别出文字/);
});

test("timeline zoom stays anchored to the playhead", () => {
  assert.match(ui, /function setTimelineZoomAroundPlayhead\(nextZoom\)/);
  assert.match(ui, /playheadTime \* state\.zoom - anchorX/);
  assert.match(ui, /scheduleTimelineZoomCommit\(\)/);
  assert.match(ui, /timelineZoom"\)\.oninput[\s\S]*?setTimelineZoomAroundPlayhead/);
});

test("timeline follows the playhead, stacks overlaps, and keeps clip names visible", () => {
  assert.match(ui, /function keepPlayheadInView/);
  assert.match(ui, /function assignOverlapLanes/);
  assert.match(ui, /id="followPlayhead"/);
  assert.match(ui, /startPlaybackAnimationLoop[\s\S]*keepPlayheadInView\("play"\)/);
  assert.match(ui, /scroll\.scrollLeft = next/);
  assert.match(ui, /function skipDeadSource/);
  assert.match(ui, /function jumpPlaybackSource/);
  assert.match(ui, /clip-sticky/);
  assert.match(ui, /laneCount > 1/);
});

test("subtitle side handles change wrapping width without changing font scale", () => {
  assert.match(ui, /data-width-handle="w"/);
  assert.match(ui, /data-width-handle="e"/);
  assert.match(ui, /function applyTextBoxWidth\(/);
  assert.match(ui, /objectDrag\.widthResize/);
  assert.match(ui, /objectDrag\.obj\.width = nextWidth/);
  assert.match(ui, /function captionTwoLineBreak\(/);
  assert.match(ui, /scheduleObjectDragMove\(e\.clientX, e\.clientY\)/);
});

test("export ends at visible production material instead of the timeline ruler", () => {
  const dynamicEnd = ui.match(
    /function dynamicContentEnd\(\) \{([\s\S]*?)\n\s*\}\n\s*function trackIsVisible/,
  )?.[1];
  assert.ok(dynamicEnd);
  assert.doesNotMatch(dynamicEnd, /reviewCaptions|state\.issues/);
  assert.match(ui, /function exportContentEnd\(audioOnly = false\)/);
  assert.match(ui, /const exportDuration = exportContentEnd\(format === "mp3"\)/);
  assert.match(ui, /outputDuration:\s*exportDuration/);
  assert.doesNotMatch(ui, /outputDuration:\s*state\.duration/);
  assert.match(ui, /timelineDuration = Math\.max\(60, state\.duration \+ 10\)/);
});

test("a 267 minute diagnostic track cannot extend a 178 second export", () => {
  const functions = ui.match(
    /(function trackIsVisible[\s\S]*?)(?=\n\s*function visibleTimelineDuration)/,
  )?.[1];
  assert.ok(functions);
  const calculate = new Function(
    "state",
    "mainClips",
    "mainAudioClips",
    `${functions}; return exportContentEnd();`,
  );
  const state = {
    trackVisibility: {
      video: true,
      audio: true,
      caption: true,
      text: true,
      "text-hidden": false,
    },
    mainVideoTrackMap: {},
    mainAudioTrackMap: {},
    videoLayers: [],
    audioAssets: [],
    images: [],
    titles: [{ start: 0, end: 16_038, trackId: "text-hidden" }],
    captions: [{ start: 175, end: 178.3, trackId: "caption" }],
    reviewCaptions: [{ start: 0, end: 16_038 }],
    issues: [{ start: 0, end: 16_038 }],
  };
  const result = calculate(
    state,
    () => [{ id: "v1", start: 0, end: 178 }],
    () => [{ id: "a1", start: 0, end: 178 }],
  );
  assert.equal(result, 178);
});

test("timeline scrolling keeps clips mounted and redraws only the cached waveform", () => {
  const timelineRenderer = ui.match(
    /function renderTimeline\(\) \{([\s\S]*?)\n\s*\}\n\s*let timelineRenderFrame/,
  )?.[1];
  assert.ok(timelineRenderer);
  assert.doesNotMatch(timelineRenderer, /timelineItemVisible/);
  assert.match(
    ui,
    /timelineScroll"\)\.addEventListener\("scroll",[\s\S]*?scheduleWaveformRender\(\)/,
  );
  assert.doesNotMatch(
    ui,
    /timelineScroll"\)\.addEventListener\("scroll",[\s\S]{0,180}?scheduleTimelineRender\(\)/,
  );
});

test("text inspector owns fonts, spacing, and every range has step buttons", () => {
  assert.match(ui, /id="fontFamilySelect"/);
  assert.match(ui, /id="letterSpacing"/);
  assert.match(ui, /id="lineHeight"/);
  assert.doesNotMatch(ui, /data-side="font"|id="side-font"|id="localFonts"/);
  assert.match(ui, /function installRangeSteppers\(/);
  assert.match(ui, /data-button-step="5"/);
  assert.match(media, /letterSpacing\.toFixed\(2\)/);
  assert.match(media, /line_spacing=/);
});

test("text and image animation libraries are complete, previewable, saved and exported", () => {
  assert.match(ui, /data-inspect="animation"/);
  assert.match(ui, /const textAnimations = \[/);
  assert.match(ui, /const imageAnimations = \[/);
  const textBlock = ui.match(/const textAnimations = \[([\s\S]*?)\]\.map/)?.[1] || "";
  const imageBlock = ui.match(/const imageAnimations = \[([\s\S]*?)\]\.map/)?.[1] || "";
  assert.equal((textBlock.match(/\["/g) || []).length, 40);
  assert.equal((imageBlock.match(/\["/g) || []).length, 40);
  assert.match(ui, /onpointerover[\s\S]*?previewing/);
  assert.match(ui, /enterAnimation/);
  assert.match(ui, /exitAnimation/);
  assert.match(media, /function animatedPosition/);
  assert.match(media, /function animatedAlpha/);
});

test("line pulse captions and the real LUT filter library are previewed and exported", () => {
  assert.match(ui, /逐行跳动/);
  assert.match(ui, /data-animation="line-pulse"/);
  assert.match(media, /function linePulseAssEvents/);
  assert.match(ui, /const filterLooks = \[/);
  const looks = ui.match(/const filterLooks = \[([\s\S]*?)\]\.map/)?.[1] || "";
  assert.equal((looks.match(/\["/g) || []).length, 30);
  assert.match(ui, /id="importLut"/);
  assert.match(ui, /nativeCall\("importLut"/);
  assert.match(media, /lut3d=file=.*interp=tetrahedral/);
  assert.match(media, /blend=all_expr/);
});

test("preview objects snap to the temporary vertical center guide", () => {
  assert.match(ui, /class="center-guide" id="centerGuide"/);
  assert.match(ui, /objectDrag\.obj\.x = 0/);
  assert.match(ui, /centerGuide"\)\.classList\.toggle\("on", centered\)/);
  assert.match(ui, /centerGuide"\)\.classList\.remove\("on"\)/);
});

test("left subtitle page edits lines and replaces the exact manuscript without changing timestamps", () => {
  assert.match(ui, /字幕断行列表/);
  assert.match(ui, /id="captionInspectorList"/);
  assert.match(ui, /id="replaceCaptionsFromScript"/);
  assert.match(ui, /function replaceCaptionsFromManuscript\(\)/);
  assert.match(ui, /caption\.words = timedCaptionWords\(text, caption\)/);
  assert.match(ui, /全部时间戳保持不变/);
  assert.doesNotMatch(ui, /data-inspect="captions"/);
});

test("filter cards have differentiated thumbnails and beauty includes whitening", () => {
  assert.match(ui, /class="filter-thumb"/);
  assert.match(ui, /function filterPreviewCss\(look\)/);
  assert.match(ui, /__QUICKCUT_FILTER_PREVIEW__/);
  assert.match(main, /filter-preview-portrait\.jpg/);
  assert.match(main, /replaceAll\("__QUICKCUT_FILTER_PREVIEW__", filterPreviewUrl\)/);
  assert.ok(fs.statSync(path.join(root, "assets/filter-preview-portrait.jpg")).size > 50_000);
  assert.match(ui, /\["whitening", "自然美白"/);
  assert.match(ui, /scale\(1\.3\)/);
});

test("beauty preview uses a bounded GPU edge-preserving pass", () => {
  assert.match(ui, /id="beautyPreviewCanvas"/);
  assert.match(ui, /powerPreference:\s*"high-performance"/);
  assert.match(ui, /function drawBeautyPreview/);
  assert.match(ui, /maxSide = 720/);
  assert.match(ui, /exp\(-dot\(a-c,a-c\)\*edge\)/);
  assert.match(ui, /beautyFallback/);
  assert.match(ui, /beautyGLUnavailable/);
  assert.doesNotMatch(ui, /blur\(\$\{\(smooth \* 0\.045\)/);
});

test("subtitle strokes paint completely outside the glyph", () => {
  assert.match(ui, /webkitTextStroke = `\$\{Math\.max\(0, Number\(s\.stroke \|\| 0\)\) \* px \* 2\}px/);
  assert.match(ui, /el\.style\.paintOrder = "stroke fill"/);
  assert.match(ui, /\.captionobject[\s\S]*?paint-order: stroke fill/);
});

test("ripple deletion owns subtitle removal and timestamp shifting", () => {
  assert.match(ui, /function rippleSubtitleTimeline\(start, end\)/);
  assert.match(ui, /rippleSubtitleTimeline\(at, at \+ len\)/);
  assert.match(ui, /captionInspectorKey = ""/);
  assert.doesNotMatch(ui, /function rippleCaptionWordTimes/);
  assert.match(ui, /删除的词句不会恢复/);
});

test("export beauty path avoids the former bilateral bottleneck and reports preparation", () => {
  assert.match(media, /hqdn3d=/);
  assert.doesNotMatch(media, /bilateral=sigmaS/);
  assert.match(media, /progress: 0\.01/);
  assert.match(media, /out_time_\(\?:ms\|us\)/);
});

test("preview dragging updates only the selected compositor layer", () => {
  const drag = ui.match(/function applyObjectDragMove\(clientX, clientY\) \{([\s\S]*?)\n\s*\}\n\s*function scheduleObjectDragMove/)?.[1] || "";
  assert.ok(drag);
  assert.doesNotMatch(drag, /updatePreviewTransformOnly/);
  assert.match(drag, /selectedElement\.style\.transform = transform/);
  assert.match(ui, /frame\.object-dragging/);
});

test("advanced typography controls include per-slider reset and both background modes", () => {
  for (const id of [
    "wordSpacing",
    "shadowColor",
    "shadowOpacity",
    "shadowBlur",
    "shadowDistance",
    "shadowAngle",
    "backgroundWidth",
    "backgroundHeight",
    "backgroundX",
    "backgroundY",
  ]) assert.match(ui, new RegExp(`id="${id}"`));
  assert.match(ui, /data-background-mode="block"/);
  assert.match(ui, /data-background-mode="line"/);
  assert.match(ui, /data-text-align="left"/);
  assert.match(ui, /data-vertical-align="bottom"/);
  assert.match(ui, /range-reset-button/);
  assert.match(ui, /reset\.textContent = "↺"/);
  assert.match(media, /style\.wordSpacing/);
  assert.match(media, /style\.shadowAngle/);
});

test("export defaults balance Apple hardware speed and Rec. 709 quality", () => {
  assert.match(ui, /推荐（自动匹配分辨率）/);
  assert.match(ui, /跟随素材（推荐）/);
  assert.match(ui, /跟随素材（极速\/零损失）/);
  assert.match(ui, /function projectCanSmartRemux/);
  assert.match(ui, /极速原码流直出（零损失）/);
  assert.match(media, /function canSmartCopy/);
  assert.match(media, /mode:\s*"smart-copy"/);
  assert.match(ui, /Rec\. 709 SDR（推荐）/);
  assert.match(media, /h264_videotoolbox/);
  assert.match(media, /h264_nvenc/);
  assert.match(media, /preferredVideoEncoder/);
  assert.match(media, /bt709:\s*\{\s*space:\s*"bt709"/);
  assert.match(media, /arib-std-b67/);
  assert.match(media, /smpte2084/);
  assert.match(media, /out_time_\(\?:ms\|us\)=/);
  assert.match(ui, /id="exportDurationText"/);
  assert.match(ui, /id="exportModeText"/);
  assert.match(ui, /id="exportSizeText"/);
  assert.match(ui, /function formatFileSize/);
  assert.match(ui, /function recommendedExportBitrate/);
});

test("per-clip visual transforms, track locks and smooth animation playback are wired", () => {
  assert.match(ui, /mainVideoClipSettings:\s*\{\}/);
  assert.match(ui, /function mainVideoSettings\(/);
  assert.match(ui, /rotation:\s*x\.rotation \|\| 0/);
  assert.match(ui, /blendMode:\s*x\.blendMode \|\| "normal"/);
  assert.match(ui, /<button class="tracklock \$\{locked \? "on" : ""\}"/);
  assert.match(ui, /function selectionIsLocked\(/);
  assert.match(ui, /playbackAnimationFrame = requestAnimationFrame\(tick\)/);
  assert.doesNotMatch(ui, /scheduleAutoSave\(/);
  assert.match(media, /lanczos\+accurate_rnd/);
});

test("add menu creates a real independent text item and animation cards stay visible", () => {
  assert.match(ui, /id="addTrack" title="添加文本"/);
  assert.match(ui, /\$\("addTrack"\)\.onclick = \(\) => \{[\s\S]*?addText\(\)/);
  assert.match(ui, /trackId:\s*createDynamicTrack\("text"/);
  assert.match(ui, /state\.titles\.filter\(keep\)/);
  assert.match(ui, /data-add-track-kind="text"/);
  assert.match(ui, /\$\("animationGrid"\)\.innerHTML = list/);
});

test("linked media, offline relinking and current-project cache clearing are real", () => {
  const imported = main.match(/async function importedAsset[\s\S]*?function rehydrateMedia/)?.[0] || "";
  assert.match(imported, /originalPath:\s*managed \? "" : selected/);
  assert.match(imported, /linked:\s*!managed/);
  assert.match(main, /clearProjectCache:\s*safe/);
  assert.match(main, /relinkAsset:\s*safe/);
  assert.match(ui, /id="clearProjectCache"/);
  assert.match(ui, /素材已移动或删除 · 右键重新关联/);
});

test("preview workspace zoom, rotated selection and app context menus are wired", () => {
  assert.match(ui, /state\.canvasZoom = clamp/);
  assert.match(ui, /frame\.style\.transform = `scale\(\$\{state\.canvasZoom/);
  assert.match(ui, /box\.style\.transform = element\.style\.transform/);
  assert.match(ui, /function showContextMenu/);
  assert.match(ui, /timelineScroll"\)\.addEventListener\("contextmenu"/);
  assert.match(ui, /stage"\)\.addEventListener\("contextmenu"/);
});

test("first script match automatically resumes and validates the speech model", () => {
  assert.match(ui, /if \(!model\.ready && !model\.installed\) \{[\s\S]*?groqKeyInput/);
  assert.match(ui, /id="groqKeyInput"/);
  assert.match(ui, /saveGroqApiKey/);
  assert.match(ui, /id="aiReviewStrict"/);
  assert.match(ui, /id="openReviewSettings"/);
  assert.match(ui, /id="reviewSettingsModal"/);
  assert.match(ui, /id="refreshGeminiModels"/);
  assert.match(ui, /refreshGeminiModels/);
  assert.match(ui, /gemini-3\.7-flash/);
  assert.match(ui, /项目接口不接受 API Key/);
  assert.match(main, /refreshGeminiModels: safe\(\(\) => listReviewModels\(\{ refresh: true \}\)/);
  assert.match(ui, /blockingScriptureOnTimeline/);
  assert.match(ui, /id="aiReviewNatural"/);
  assert.match(ui, /async function reviewScriptWithAi/);
  assert.match(ui, /mode: strict \? "strict" : "natural"/);
  const matchOnly = whisper.slice(
    whisper.indexOf("async function finalizeScriptAnalysis"),
    whisper.indexOf("export async function reviewScriptIssues"),
  );
  assert.match(matchOnly, /job\.result = \{/);
  assert.doesNotMatch(matchOnly, /judgeAlignmentIssues/);
  assert.match(whisper, /export async function reviewScriptIssues[\s\S]*judgeAlignmentIssues/);
  assert.match(whisper, /api\.groq\.com\/openai\/v1\/audio\/transcriptions/);
  assert.match(whisper, /headers:\s*existing \? \{ Range:/);
  assert.match(whisper, /flags:\s*resumed \? "a" : "w"/);
  assert.match(whisper, /下载内容不是有效模型/);
});

test("long speech recognition resets context and re-anchors after local errors", () => {
  assert.match(whisperWorker, /params\.noContext = true/);
  assert.match(whisperWorker, /const chunkSeconds = 45/);
  assert.match(whisperWorker, /const overlapSeconds = 1\.1/);
  assert.match(whisper, /export function stitchTranscriptSegments/);
  assert.match(
    whisper,
    /let unique = stitchTranscriptSegments\([\s\S]*?normalizeTranscriptTimebase\(segments, duration\)/,
  );
});

test("native Whisper timestamps are converted from 10 ms ticks before captioning", () => {
  assert.match(whisperWorker, /Number\(segment\?\.start \|\| 0\) \/ 100/);
  assert.match(whisperWorker, /Number\(segment\?\.end \|\| 0\) \/ 100/);
  assert.match(whisperWorker, /await new Promise\(\(resolve\) => setImmediate\(resolve\)\)/);
  assert.match(whisperWorker, /callbackCoverage < 0\.82/);
  assert.match(whisper, /normalizeTranscriptTimebase\(segments, duration\)/);
});

test("text backgrounds are actual fills and underline is never implied by an animation", () => {
  assert.match(ui, /s\.backgroundEnabled && backgroundMode === "block"[\s\S]*?\? backgroundColor/);
  assert.match(ui, /s\.backgroundEnabled && backgroundMode === "line"[\s\S]*?\? backgroundColor/);
  assert.doesNotMatch(media, /fontUnderline \|\| animation === "underline"/);
});

test("media import is optimistic and export offers mainstream color spaces", () => {
  assert.match(main, /analysisPending:\s*true/);
  assert.doesNotMatch(main.match(/async function importedAsset[\s\S]*?function rehydrateMedia/)?.[0] || "", /await probeMediaAsync\(staged\)/);
  for (const value of ["p3", "bt2020", "hlg", "pq"])
    assert.match(ui, new RegExp(`<option value="${value}"`));
});
