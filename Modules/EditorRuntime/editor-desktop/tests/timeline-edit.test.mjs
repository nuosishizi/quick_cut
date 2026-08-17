import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IMAGE_SCALE,
  collectClipsUnderPlayhead,
  collectOverlayRippleHoles,
  expandSelectionWithLinks,
  joinCaptionWords,
  linkedGroupPartners,
  overlaySourceStartAfterSplit,
  playheadInside,
  resolveBareMainSelection,
  resolveImageExportScale,
  rippleItemsOnTrack,
  clipInsideRange,
  clipOverlapsRange,
  marqueeTimeRange,
  selectionMainCutRange,
  shiftTimedOverlay,
  snapClipEdges,
  snapGroupDelta,
  snapThresholdSeconds,
  snapValue,
  collectSnapPoints,
  rulerTickPlan,
  applyMainTrimEdge,
  rollingEditMainClips,
  slipClipSource,
  rippleShiftAllTracks,
  splitTimedItem,
} from "../src/timeline-edit.mjs";

test("linked selection only follows the same-source A/V group", () => {
  const video = {
    id: "v1",
    linkGroupId: "g1",
    start: 1,
    end: 4,
    linkedAudioId: "a1",
  };
  const audio = {
    id: "a1",
    linkGroupId: "g1",
    start: 1,
    end: 4,
    linkedVideoId: "v1",
  };
  const other = { id: "v2", linkGroupId: "g2", start: 1.5, end: 3 };
  const collections = {
    videoLayers: [video, other],
    audioAssets: [audio],
  };
  const partners = linkedGroupPartners(
    { type: "videolayer", id: "v1" },
    collections,
    true,
  );
  assert.deepEqual(
    partners.map((item) => item.id),
    ["a1"],
  );
  assert.deepEqual(
    linkedGroupPartners({ type: "videolayer", id: "v1" }, collections, false),
    [],
  );
});

test("overlapping titles and captions are not auto-linked", () => {
  const collections = {
    videoLayers: [{ id: "v1", linkGroupId: "g1", start: 0, end: 5 }],
    audioAssets: [{ id: "a1", linkGroupId: "g1", start: 0, end: 5 }],
  };
  const selected = expandSelectionWithLinks(
    [{ type: "videolayer", id: "v1" }],
    collections,
    true,
  );
  assert.deepEqual(
    selected.map((item) => `${item.type}:${item.id}`),
    ["videolayer:v1", "audioasset:a1"],
  );
});

test("image export fallback is 100 percent, not 35 percent", () => {
  assert.equal(DEFAULT_IMAGE_SCALE, 1);
  assert.equal(resolveImageExportScale({}), 1);
  assert.equal(resolveImageExportScale({ scale: 0.5 }), 0.5);
  assert.ok(resolveImageExportScale({ scale: 0 }) >= 0.03);
});

test("overlay ripple only slides later clips on the same track", () => {
  const images = [
    { id: "keep-before", trackId: "image-a", start: 0, end: 1 },
    { id: "later-same", trackId: "image-a", start: 4, end: 6 },
    { id: "other-track", trackId: "image-b", start: 4, end: 6 },
    { id: "overlap-not-eaten", trackId: "image-a", start: 1.5, end: 2.5 },
  ];
  rippleItemsOnTrack(images, "image", "image-a", 1, 3);
  assert.equal(images[0].start, 0);
  assert.equal(images[1].start, 2);
  assert.equal(images[1].end, 4);
  assert.equal(images[2].start, 4);
  assert.equal(images[3].start, 1.5);
});

test("caption ripple keeps later words and does not swallow them", () => {
  const captions = [
    {
      id: "next",
      trackId: "caption",
      start: 5,
      end: 7,
      words: [
        { display: "my", start: 5, end: 5.4 },
        { display: "family", start: 5.4, end: 6.2 },
      ],
    },
  ];
  rippleItemsOnTrack(captions, "caption", "caption", 1, 3);
  assert.equal(captions[0].start, 3);
  assert.equal(captions[0].end, 5);
  assert.equal(captions[0].words[0].start, 3);
  assert.equal(captions[0].words[1].display, "family");
});

test("marquee range only keeps the inside A/V piece, later audio stays unselected", () => {
  const range = marqueeTimeRange(120, 180, 0, 10);
  assert.equal(range.start, 12);
  assert.equal(range.end, 18);
  const before = { id: "keep-before", start: 0, end: 12 };
  const inside = { id: "selected", start: 12, end: 18 };
  const later = { id: "later-audio", start: 18, end: 180 };
  assert.equal(clipOverlapsRange({ start: 0, end: 180 }, 12, 18), true);
  assert.equal(clipInsideRange(before, 12, 18), false);
  assert.equal(clipInsideRange(inside, 12, 18), true);
  assert.equal(clipInsideRange(later, 12, 18), false);
});

test("selecting a long A/V clip with a short caption only cuts that shared range", () => {
  const range = selectionMainCutRange(
    [
      { type: "video", id: "v-all" },
      { type: "audio", id: "a-all" },
      { type: "caption", id: "c1" },
    ],
    (item) => {
      if (item.type === "video" || item.type === "audio") return { start: 0, end: 180 };
      return { start: 12, end: 15 };
    },
  );
  assert.equal(range.start, 12);
  assert.equal(range.end, 15);
  const kept = [];
  let source = 0;
  if (range.start > source) kept.push([source, range.start]);
  source = range.end;
  if (source < 180) kept.push([source, 180]);
  assert.deepEqual(kept, [
    [0, 12],
    [15, 180],
  ]);
  assert.equal(
    selectionMainCutRange(
      [
        { type: "video", id: "v-mid" },
        { type: "caption", id: "c1" },
      ],
      (item) => ({ start: 12, end: 15 }),
    ),
    null,
  );
});

test("overlay ripple holes ignore main A/V and close from the right", () => {
  const holes = collectOverlayRippleHoles([
    { type: "video", start: 0, end: 2 },
    { type: "image", trackId: "image-a", start: 1, end: 2 },
    { type: "image", trackId: "image-a", start: 4, end: 5 },
  ]);
  assert.deepEqual(
    holes.map((hole) => hole.start),
    [4, 1],
  );
});

test("shiftTimedOverlay never inverts a clip", () => {
  const item = { start: 2, end: 2.03 };
  shiftTimedOverlay(item, 1);
  assert.ok(item.end >= item.start + 0.04);
});

test("bare video/main selection resolves to the clip under the playhead", () => {
  const resolved = resolveBareMainSelection(
    [{ type: "video", id: "main" }],
    { type: "video", id: "v-0.0000-12.0000" },
  );
  assert.deepEqual(resolved, [{ type: "video", id: "v-0.0000-12.0000" }]);
  assert.deepEqual(resolveBareMainSelection([{ type: "caption", id: "c1" }], { type: "video", id: "v1" }), [
    { type: "caption", id: "c1" },
  ]);
});

test("split at playhead collects every clip the needle is on", () => {
  const hits = collectClipsUnderPlayhead(2, {
    avLinked: true,
    mainClips: [{ id: "v1", start: 0, end: 5 }],
    captions: [{ id: "c1", start: 1.5, end: 3 }],
    images: [{ id: "i1", start: 4, end: 8 }],
    reviewCaptions: [{ id: "r1", start: 1, end: 4 }],
  });
  assert.deepEqual(
    hits.map((item) => item.id),
    ["v1", "c1"],
  );
});

test("caption split keeps later words on the right half", () => {
  const split = splitTimedItem(
    {
      id: "c1",
      start: 1,
      end: 5,
      words: [
        { display: "Save", start: 1, end: 1.4 },
        { display: "this", start: 1.4, end: 1.8 },
        { display: "for", start: 3.2, end: 3.5 },
        { display: "the", start: 3.5, end: 3.8 },
      ],
    },
    2.5,
    "c2",
  );
  assert.equal(joinCaptionWords(split.left.words), "Save this");
  assert.equal(joinCaptionWords(split.right.words), "for the");
  assert.ok(split.left.end <= 2.5);
  assert.ok(split.right.start >= 2.5);
  assert.equal(overlaySourceStartAfterSplit({ start: 1, sourceStart: 10 }, 3, 1), 12);
  assert.equal(playheadInside({ start: 0, end: 2 }, 0.01), false);
});

test("timeline snap sticks to nearby clip edges and the playhead", () => {
  assert.ok(snapThresholdSeconds(60) <= 0.25);
  const points = collectSnapPoints({
    clips: [
      { id: "keep", start: 2, end: 4 },
      { id: "moving", start: 5, end: 7 },
    ],
    extra: [0, 10, 3],
    ignoreIds: new Set(["moving"]),
  });
  assert.deepEqual(points, [0, 10, 3, 2, 4]);
  assert.equal(snapValue(2.03, points, 0.08).time, 2);
  assert.equal(snapValue(2.2, points, 0.08).snapped, false);
  assert.equal(snapClipEdges(0.5, 1, [3], 0.08).snapped, false);
  const snappedEnd = snapClipEdges(0.95, 1, [2], 0.08);
  assert.ok(snappedEnd.snapped);
  assert.equal(snappedEnd.edge, "end");
  assert.ok(Math.abs(snappedEnd.start - 1) < 0.001);
  const group = snapGroupDelta(
    [
      { originStart: 5, originEnd: 6 },
      { originStart: 7, originEnd: 8 },
    ],
    -2.97,
    [2, 4],
    0.08,
  );
  assert.ok(group.snapped);
  assert.ok(Math.abs(group.delta + 3) < 0.001);
});

test("default timeline zoom has sub-second ruler ticks", () => {
  const plan = rulerTickPlan(60);
  assert.ok(plan.major <= 2);
  assert.ok(plan.minor <= 0.5);
  assert.ok(plan.micro <= 0.1);
  const tight = rulerTickPlan(220);
  assert.ok(tight.minor <= 1 / 30 + 0.0001);
});

test("non-destructive trimming recovers cut content when extending outwards", () => {
  const removals = [
    { start: 0, end: 2, source: "pause" },
    { start: 8, end: 12, source: "reread" },
    { start: 20, end: 25, source: "edge-trim" },
  ];
  const clip = { sourceStart: 12, sourceEnd: 20, start: 6, end: 14 };

  // 1. Extend head left from 12 back to 9 (recovering 3s of previous cut):
  const headRecover = applyMainTrimEdge(removals, [], clip, "start", 9, 30);
  assert.equal(headRecover.deltaSource, 3);
  assert.deepEqual(headRecover.removals, [
    { start: 0, end: 2, source: "pause" },
    { start: 8, end: 9, source: "reread" },
    { start: 20, end: 25, source: "edge-trim" },
  ]);

  // 2. Extend tail right from 20 to 25 (completely eating the trailing removal):
  const tailRecover = applyMainTrimEdge(removals, [], clip, "end", 25, 30);
  assert.equal(tailRecover.deltaSource, 5);
  assert.deepEqual(tailRecover.removals, [
    { start: 0, end: 2, source: "pause" },
    { start: 8, end: 12, source: "reread" },
  ]);

  // 3. Inward trim head from 12 to 14 (cutting away 2s):
  const headInward = applyMainTrimEdge(removals, [], clip, "start", 14, 30);
  assert.equal(headInward.deltaSource, -2);
  assert.deepEqual(headInward.removals, [
    { start: 0, end: 2, source: "pause" },
    { start: 8, end: 14, source: "reread" }, // Merged
    { start: 20, end: 25, source: "edge-trim" },
  ]);
});

test("rolling edit adjusts seam without changing overall timeline duration", () => {
  const leftClip = { sourceStart: 0, sourceEnd: 10, start: 0, end: 10 };
  const rightClip = { sourceStart: 10, sourceEnd: 25, start: 10, end: 25 };
  const roll = rollingEditMainClips([], [10], leftClip, rightClip, 14);
  assert.equal(roll.cutPoint, 14);
  assert.deepEqual(roll.manualCuts, [14]);
});

test("slip edit adjusts source range while keeping clip duration unchanged", () => {
  const clip = { sourceStart: 10, sourceEnd: 20 };
  const slipped = slipClipSource(clip, 5, 0, 100);
  assert.deepEqual(slipped, { sourceStart: 15, sourceEnd: 25 });
});

test("ripple shift shifts downstream items across all tracks", () => {
  const state = {
    videoLayers: [{ start: 10, end: 15 }],
    audioAssets: [{ start: 2, end: 4 }, { start: 12, end: 16 }],
    images: [{ start: 9, end: 14 }],
    titles: [{ start: 11, end: 13 }],
    captions: [{ start: 10, end: 12, words: [{ start: 10, end: 11 }, { start: 11, end: 12 }] }],
    reviewCaptions: [],
  };
  rippleShiftAllTracks(state, 10, 3);
  assert.equal(state.videoLayers[0].start, 13);
  assert.equal(state.audioAssets[0].start, 2); // Unaffected before 10
  assert.equal(state.audioAssets[1].start, 15);
  assert.equal(state.captions[0].words[0].start, 13);
});

