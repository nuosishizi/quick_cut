/** DaVinci-style linked selection and same-track ripple. */

export const DEFAULT_IMAGE_SCALE = 1;

export function resolveImageExportScale(image) {
  return Math.max(0.03, Number(image?.scale ?? DEFAULT_IMAGE_SCALE));
}

export function overlayTrackId(type, item) {
  if (!item) return type;
  if (type === "review") return item.trackId || "review";
  if (type === "caption") return item.trackId || "caption";
  return item.trackId || type;
}

export function linkedGroupPartners(anchor, collections, avLinked) {
  if (!avLinked || !anchor) return [];
  const lists = [
    ["videolayer", collections?.videoLayers],
    ["audioasset", collections?.audioAssets],
  ];
  let groupId = "";
  for (const [type, items] of lists) {
    const match = (items || []).find((item) => type === anchor.type && item.id === anchor.id);
    if (match?.linkGroupId) {
      groupId = match.linkGroupId;
      break;
    }
  }
  if (!groupId) return [];
  const partners = [];
  for (const [type, items] of lists)
    for (const item of items || []) {
      if (type === anchor.type && item.id === anchor.id) continue;
      if (item.linkGroupId === groupId)
        partners.push({
          type,
          id: item.id,
          obj: item,
          originStart: Number(item.start || 0),
          originEnd: Number(item.end || 0),
        });
    }
  return partners;
}

export function expandSelectionWithLinks(selected, collections, avLinked) {
  if (!avLinked) return [...(selected || [])];
  const expanded = [...(selected || [])];
  const has = (type, id) =>
    expanded.some((item) => item.type === type && item.id === id);
  const push = (type, id) => {
    if (id && !has(type, id)) expanded.push({ type, id });
  };
  for (const item of selected || []) {
    const obj = [...(collections?.videoLayers || []), ...(collections?.audioAssets || [])].find(
      (entry) => entry.id === item.id,
    );
    if (obj?.linkedAudioId) push("audioasset", obj.linkedAudioId);
    if (obj?.linkedVideoId) push("videolayer", obj.linkedVideoId);
    for (const partner of linkedGroupPartners(item, collections, avLinked))
      push(partner.type, partner.id);
  }
  return expanded;
}

export function shiftTimedOverlay(item, length) {
  const start = Number(item.start || 0);
  const end = Number(item.end || start + 0.04);
  item.start = Math.max(0, start - length);
  item.end = Math.max(item.start + 0.04, end - length);
  if (!Array.isArray(item.words)) return item;
  for (const word of item.words) {
    const wordStart = Number(word.start || 0);
    const wordEnd = Number(word.end || wordStart + 0.01);
    word.start = Math.max(0, wordStart - length);
    word.end = Math.max(word.start + 0.01, wordEnd - length);
  }
  return item;
}

export function rippleItemsOnTrack(list, type, trackId, cutStart, cutEnd) {
  const length = Math.max(0, Number(cutEnd) - Number(cutStart));
  if (length <= 0.001) return list;
  for (const item of list || []) {
    if (overlayTrackId(type, item) !== trackId) continue;
    if (Number(item.start || 0) + 0.002 >= Number(cutEnd))
      shiftTimedOverlay(item, length);
  }
  return list;
}

export function playheadInside(item, time, margin = 0.04) {
  const start = Number(item?.start || 0);
  const end = Number(item?.end || start);
  return Number(time) > start + margin && Number(time) < end - margin;
}

export function joinCaptionWords(words) {
  return (words || [])
    .map((word) => word.display || word.text || "")
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

export function splitTimedItem(item, time, nextId) {
  if (!item || !playheadInside(item, time)) return null;
  const left = { ...item };
  const right = { ...item, id: nextId };
  if (Array.isArray(item.words) && item.words.length) {
    const leftWords = [];
    const rightWords = [];
    for (const word of item.words) {
      const wordStart = Number(word.start || 0);
      const wordEnd = Number(word.end || wordStart + 0.01);
      if ((wordStart + wordEnd) / 2 < time) leftWords.push({ ...word });
      else rightWords.push({ ...word });
    }
    if (!leftWords.length || !rightWords.length) return null;
    left.words = leftWords;
    left.start = Number(leftWords[0].start || item.start);
    left.end = Math.max(left.start + 0.04, Math.min(time, Number(leftWords.at(-1).end)));
    left.text = joinCaptionWords(leftWords);
    right.words = rightWords;
    right.start = Math.max(time, Number(rightWords[0].start || time));
    right.end = Number(rightWords.at(-1).end || item.end);
    right.text = joinCaptionWords(rightWords);
    return { left, right };
  }
  left.end = time;
  right.start = time;
  return { left, right };
}

export function overlaySourceStartAfterSplit(item, time, speed = 1) {
  return (
    Number(item?.sourceStart || 0) +
    (Number(time) - Number(item?.start || 0)) * Math.max(0.5, Number(speed || 1))
  );
}

export function collectClipsUnderPlayhead(time, collections = {}, { includeReview = false } = {}) {
  const hits = [];
  for (const clip of collections.mainClips || [])
    if (playheadInside(clip, time)) hits.push({ type: "video", id: clip.id });
  if (collections.avLinked === false)
    for (const clip of collections.mainAudioClips || [])
      if (playheadInside(clip, time)) hits.push({ type: "audio", id: clip.id });
  for (const [type, list] of [
    ["videolayer", collections.videoLayers],
    ["audioasset", collections.audioAssets],
    ["image", collections.images],
    ["text", collections.titles],
    ["caption", collections.captions],
  ])
    for (const item of list || [])
      if (playheadInside(item, time)) hits.push({ type, id: item.id });
  if (includeReview)
    for (const item of collections.reviewCaptions || [])
      if (playheadInside(item, time)) hits.push({ type: "review", id: item.id });
  return hits;
}

export function resolveBareMainSelection(items, clipUnderPlayhead) {
  const result = [];
  let bare = false;
  for (const item of items || []) {
    if ((item.type === "video" || item.type === "audio") && item.id === "main") {
      bare = true;
      continue;
    }
    result.push(item);
  }
  if (
    bare &&
    clipUnderPlayhead?.id &&
    clipUnderPlayhead.id !== "main" &&
    !result.some(
      (item) => item.type === clipUnderPlayhead.type && item.id === clipUnderPlayhead.id,
    )
  )
    result.push(clipUnderPlayhead);
  return result;
}

export function clipOverlapsRange(clip, start, end) {
  return Number(clip?.start || 0) < Number(end) - 0.001 && Number(clip?.end || 0) > Number(start) + 0.001;
}

export function clipInsideRange(clip, start, end, slop = 0.03) {
  const clipStart = Number(clip?.start || 0);
  const clipEnd = Number(clip?.end || clipStart);
  return clipStart >= Number(start) - slop && clipEnd <= Number(end) + slop && clipEnd - clipStart > 0.02;
}

export function marqueeTimeRange(left, right, originLeft, zoom) {
  const scale = Math.max(1e-6, Number(zoom) || 1);
  const start = (Number(left) - Number(originLeft)) / scale;
  const end = (Number(right) - Number(originLeft)) / scale;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function selectionMainCutRange(selected = [], resolveSpan) {
  const overlays = [];
  const mains = [];
  for (const item of selected || []) {
    const span = typeof resolveSpan === "function" ? resolveSpan(item) : item;
    if (!span) continue;
    const start = Number(span.start || 0);
    const end = Number(span.end || start);
    if (end <= start + 0.001) continue;
    if (item.type === "video" || item.type === "audio") mains.push({ start, end });
    else overlays.push({ start, end });
  }
  if (!mains.length || !overlays.length) return null;
  const start = Math.max(
    Math.min(...mains.map((item) => item.start)),
    Math.min(...overlays.map((item) => item.start)),
  );
  const end = Math.min(
    Math.max(...mains.map((item) => item.end)),
    Math.max(...overlays.map((item) => item.end)),
  );
  if (end <= start + 0.04) return null;
  const mainLength =
    Math.max(...mains.map((item) => item.end)) - Math.min(...mains.map((item) => item.start));
  if (end - start >= mainLength - 0.08) return null;
  return { start, end };
}

export function collectOverlayRippleHoles(items) {
  return [...(items || [])]
    .filter((item) => item && !["video", "audio"].includes(item.type))
    .map((item) => ({
      type: item.type,
      trackId: overlayTrackId(item.type, item.obj || item),
      start: Number((item.obj || item).start || 0),
      end: Number((item.obj || item).end || (item.obj || item).start || 0),
    }))
    .filter((hole) => hole.end > hole.start + 0.001)
    .sort((a, b) => b.start - a.start);
}

export function snapThresholdSeconds(
  zoom,
  pixelWindow = 8,
  maxSeconds = 0.15,
  minSeconds = 1 / 120,
) {
  const secondsForPixels = pixelWindow / Math.max(1, Number(zoom) || 1);
  return Math.max(minSeconds, Math.min(maxSeconds, secondsForPixels));
}

export function collectSnapPoints({ clips = [], extra = [], ignoreIds = new Set() } = {}) {
  const points = [];
  for (const value of extra)
    if (Number.isFinite(Number(value))) points.push(Number(value));
  for (const item of clips || []) {
    if (item?.id && ignoreIds.has(item.id)) continue;
    const start = Number(item.start);
    const end = Number(item.end);
    if (Number.isFinite(start)) points.push(start);
    if (Number.isFinite(end)) points.push(end);
  }
  return points;
}

export function snapValue(value, points, threshold) {
  const time = Number(value);
  const window = Math.max(0, Number(threshold) || 0);
  let best = time;
  let bestDist = Infinity;
  for (const point of points || []) {
    const dist = Math.abs(Number(point) - time);
    if (dist < bestDist && dist <= window) {
      best = Number(point);
      bestDist = dist;
    }
  }
  const snapped = bestDist <= window && bestDist < Infinity;
  return {
    time: snapped ? best : time,
    snapped,
    target: snapped ? best : null,
    distance: snapped ? bestDist : Infinity,
  };
}

export function snapClipEdges(start, duration, points, threshold) {
  const length = Math.max(0.04, Number(duration) || 0);
  const startSnap = snapValue(start, points, threshold);
  const endSnap = snapValue(Number(start) + length, points, threshold);
  if (endSnap.distance < startSnap.distance)
    return {
      start: endSnap.time - length,
      snapped: endSnap.snapped,
      target: endSnap.target,
      edge: endSnap.snapped ? "end" : "",
    };
  return {
    start: startSnap.time,
    snapped: startSnap.snapped,
    target: startSnap.target,
    edge: startSnap.snapped ? "start" : "",
  };
}

export function rulerTickPlan(zoom) {
  const z = Number(zoom) || 60;
  if (z < 2) return { major: 300, minor: 60, micro: 12 };
  if (z < 4) return { major: 120, minor: 30, micro: 6 };
  if (z < 8) return { major: 60, minor: 10, micro: 2 };
  if (z < 16) return { major: 30, minor: 5, micro: 1 };
  if (z < 28) return { major: 10, minor: 2, micro: 0.5 };
  if (z < 48) return { major: 5, minor: 1, micro: 0.2 };
  if (z < 80) return { major: 2, minor: 0.5, micro: 0.1 };
  if (z < 130) return { major: 1, minor: 0.2, micro: 1 / 30 };
  if (z < 200) return { major: 0.5, minor: 0.1, micro: 1 / 30 };
  // Keep text labels at least 100px apart. Frame ticks may stay dense, but
  // labelling every two frames makes the ruler unreadable at high zoom.
  return { major: 0.5, minor: 1 / 30, micro: 1 / 30 };
}

export function findTimelineGap(items = [], time = 0, minimum = 0.04) {
  const point = Math.max(0, Number(time) || 0);
  const clips = (items || [])
    .map((item) => ({
      ...item,
      start: Math.max(0, Number(item?.start) || 0),
      end: Math.max(0, Number(item?.end) || 0),
    }))
    .filter((item) => item.end > item.start + 0.001)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!clips.length) return null;
  if (clips.some((item) => point >= item.start - 0.002 && point <= item.end + 0.002))
    return null;
  let start = 0;
  let end = Infinity;
  for (const item of clips) {
    if (item.end <= point + 0.002) start = Math.max(start, item.end);
    if (item.start >= point - 0.002) end = Math.min(end, item.start);
  }
  if (!Number.isFinite(end) || end - start < Math.max(0.002, Number(minimum) || 0.04))
    return null;
  return { start, end, duration: end - start };
}

export function snapGroupDelta(moving, delta, points, threshold) {
  let bestAdj = 0;
  let bestDist = Infinity;
  let target = null;
  for (const item of moving || []) {
    const start = Number(item.originStart) + Number(delta);
    const end = Number(item.originEnd) + Number(delta);
    for (const edge of [start, end]) {
      const snap = snapValue(edge, points, threshold);
      if (!snap.snapped) continue;
      const adj = snap.time - edge;
      if (Math.abs(adj) < bestDist) {
        bestDist = Math.abs(adj);
        bestAdj = adj;
        target = snap.target;
      }
    }
  }
  return {
    delta: Number(delta) + bestAdj,
    snapped: bestDist < Infinity,
    target,
  };
}

export function sourceOverlap(left = {}, right = {}) {
  return Math.max(
    0,
    Math.min(Number(left.sourceEnd || 0), Number(right.sourceEnd || 0)) -
      Math.max(Number(left.sourceStart || 0), Number(right.sourceStart || 0)),
  );
}

export function matchClipBySource(clip, list = []) {
  let best = null;
  let bestOverlap = 0;
  for (const item of list || []) {
    const overlap = sourceOverlap(clip, item);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = item;
    }
  }
  return bestOverlap > 0.02 ? best : null;
}

export function buildPackedMainClips(
  removals = [],
  manualCuts = [],
  sourceDuration = 0,
  speed = 1,
) {
  const rate = Math.max(0.05, Number(speed || 1));
  const duration = Math.max(0, Number(sourceDuration || 0));
  const base = [];
  let source = 0;
  let timeline = 0;
  for (const removal of normalizeRemovalsList(removals)) {
    if (removal.start > source + 0.002) {
      base.push({
        sourceStart: source,
        sourceEnd: removal.start,
        start: timeline / rate,
        end: (timeline + removal.start - source) / rate,
      });
      timeline += removal.start - source;
    }
    source = Math.max(source, Number(removal.end));
  }
  if (source < duration - 0.002)
    base.push({
      sourceStart: source,
      sourceEnd: duration,
      start: timeline / rate,
      end: (timeline + duration - source) / rate,
    });
  const clips = [];
  for (const block of base) {
    const cuts = (manualCuts || [])
      .map(Number)
      .filter((cut) => cut > block.sourceStart + 0.002 && cut < block.sourceEnd - 0.002)
      .sort((left, right) => left - right);
    const points = [block.sourceStart, ...cuts, block.sourceEnd];
    for (let index = 0; index < points.length - 1; index += 1) {
      const sourceStart = points[index];
      const sourceEnd = points[index + 1];
      const start = block.start + (sourceStart - block.sourceStart) / rate;
      clips.push({
        id: `v-${sourceStart.toFixed(4)}-${sourceEnd.toFixed(4)}`,
        sourceStart,
        sourceEnd,
        start,
        end: start + (sourceEnd - sourceStart) / rate,
      });
    }
  }
  return clips;
}

export function rebuildClipOffsets({
  snapshot = [],
  packed = [],
  globalOffset = 0,
  mode = "ripple",
  editedClip = null,
  edge = "end",
  targetSource = 0,
  speed = 1,
  rippleFrom = 0,
} = {}) {
  const offsets = {};
  const rate = Math.max(0.05, Number(speed || 1));
  for (const next of packed || []) {
    const previous = matchClipBySource(next, snapshot);
    let desired = next.start + Number(globalOffset || 0);
    if (mode === "ripple") {
      if (previous && editedClip && previous.id === editedClip.id)
        desired = Number(editedClip.start);
      else if (previous && Number(previous.start) < Number(rippleFrom) - 0.01)
        desired = Number(previous.start);
      else desired = next.start + Number(globalOffset || 0);
    } else if (previous && editedClip && previous.id === editedClip.id) {
      if (edge === "end") desired = Number(editedClip.start);
      else
        desired =
          Number(editedClip.start) +
          (Number(targetSource) - Number(editedClip.sourceStart || 0)) / rate;
    } else if (previous) desired = Number(previous.start);
    const offset = desired - next.start - Number(globalOffset || 0);
    if (Math.abs(offset) > 0.001) offsets[next.id] = offset;
  }
  return offsets;
}

export function overlayRippleWindow(clip = {}, edge = "end", deltaTimeline = 0) {
  const start = Number(clip.start || 0);
  const end = Number(clip.end || start);
  if (Math.abs(deltaTimeline) <= 0.001) return { from: end, delta: 0 };
  if (edge === "start") return { from: start, delta: deltaTimeline };
  return {
    from: deltaTimeline < 0 ? end + deltaTimeline : end,
    delta: deltaTimeline,
  };
}

export function neighborClips(clip = {}, snapshot = []) {
  const selfId = clip.id;
  const start = Number(clip.start || 0);
  const end = Number(clip.end || start);
  const others = (snapshot || []).filter((item) => item && item.id !== selfId);
  const previous = others
    .filter((item) => Number(item.end || 0) <= start + 0.05)
    .sort((left, right) => Number(right.end || 0) - Number(left.end || 0))[0] || null;
  const next = others
    .filter((item) => Number(item.start || 0) >= start - 0.05)
    .sort((left, right) => Number(left.start || 0) - Number(right.start || 0))[0] || null;
  const nextAfter = others
    .filter((item) => Number(item.start || 0) >= end - 0.05)
    .sort((left, right) => Number(left.start || 0) - Number(right.start || 0))[0] || next;
  return { previous, next: nextAfter };
}

function adjacentRemoval(removals = [], clip = {}, edge = "end") {
  const srcStart = Number(clip.sourceStart || 0);
  const srcEnd = Number(clip.sourceEnd || srcStart);
  const tolerance = 0.01;
  const candidates = (removals || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const start = Number(item?.start);
      const end = Number(item?.end);
      if (!(end > start + 0.002)) return false;
      return edge === "start"
        ? end >= srcStart - tolerance && start < srcStart - 0.002
        : start <= srcEnd + tolerance && end > srcEnd + 0.002;
    })
    .sort((left, right) => {
      const leftDistance = edge === "start"
        ? Math.abs(Number(left.item.end) - srcStart)
        : Math.abs(Number(left.item.start) - srcEnd);
      const rightDistance = edge === "start"
        ? Math.abs(Number(right.item.end) - srcStart)
        : Math.abs(Number(right.item.start) - srcEnd);
      return leftDistance - rightDistance;
    });
  return candidates[0] || null;
}

/**
 * Resolve-style limits for one trim gesture. Outward trimming can consume
 * only the deleted source handle immediately touching the selected edge. It
 * can never jump across that handle and absorb a later clip.
 */
export function mainTrimSourceBounds({
  removals = [],
  clip = {},
  edge = "end",
  sourceDuration = 0,
  snapshot = [],
  mode = "ripple",
  speed = 1,
  minTimelineDuration = 0.04,
} = {}) {
  const rate = Math.max(0.05, Number(speed || 1));
  const srcStart = Math.max(0, Number(clip.sourceStart || 0));
  const srcEnd = Math.max(srcStart, Number(clip.sourceEnd || srcStart));
  const sourceLimit = Math.max(srcEnd, Number(sourceDuration || 0));
  const minSourceDuration = Math.max(0.002, Number(minTimelineDuration || 0.04) * rate);
  const handle = adjacentRemoval(removals, clip, edge);

  let min = edge === "start"
    ? Math.max(0, Number(handle?.item?.start ?? srcStart))
    : Math.min(srcEnd, srcStart + minSourceDuration);
  let max = edge === "start"
    ? Math.max(srcStart, srcEnd - minSourceDuration)
    : Math.min(sourceLimit, Number(handle?.item?.end ?? srcEnd));

  if (mode !== "ripple") {
    const { previous, next } = neighborClips(clip, snapshot);
    if (edge === "start" && previous) {
      const gap = Math.max(0, Number(clip.start || 0) - Number(previous.end || 0));
      min = Math.max(min, srcStart - gap * rate);
    }
    if (edge === "end" && next) {
      const gap = Math.max(0, Number(next.start || 0) - Number(clip.end || 0));
      max = Math.min(max, srcEnd + gap * rate);
    }
  }

  min = Math.max(0, Math.min(min, srcEnd - minSourceDuration));
  max = Math.min(sourceLimit, Math.max(max, srcStart + minSourceDuration));
  return {
    min,
    max,
    handleStart: handle ? Number(handle.item.start) : srcStart,
    handleEnd: handle ? Number(handle.item.end) : srcEnd,
    hasHandle: !!handle,
  };
}

export function dropSubframeClips(packed = [], removals = [], manualCuts = [], sourceDuration = 0, speed = 1, frameRate = 30) {
  const frame = 1 / Math.max(1, Number(frameRate) || 30);
  const tiny = (packed || []).filter((clip) => Number(clip.end) - Number(clip.start) < frame);
  if (!tiny.length) return { packed, removals, manualCuts };
  const nextRemovals = normalizeRemovalsList([
    ...removals,
    ...tiny.map((clip) => ({
      start: Number(clip.sourceStart),
      end: Number(clip.sourceEnd),
      source: "edge-trim",
    })),
  ]);
  const nextCuts = (manualCuts || []).filter((cut) =>
    tiny.every(
      (clip) => Number(cut) <= Number(clip.sourceStart) + 0.002 || Number(cut) >= Number(clip.sourceEnd) - 0.002,
    ),
  );
  return {
    packed: buildPackedMainClips(nextRemovals, nextCuts, sourceDuration, speed),
    removals: nextRemovals,
    manualCuts: nextCuts,
  };
}

export function collectMainMoveIds({
  anchorType = "video",
  anchorId = "",
  selected = [],
  avLinked = true,
} = {}) {
  const ids = new Set();
  if (anchorId && (anchorType === "video" || anchorType === "audio" || avLinked))
    ids.add(anchorId);
  for (const item of selected || []) {
    if (item?.type === "video" || item?.type === "audio") ids.add(item.id);
  }
  return [...ids].filter(Boolean);
}

// ── Ripple-safe outward recovery ──────────────────────────────────
// Extending a clip only consumes the deleted handle directly touching the
// selected edge. Recovered frames join that clip; the far edit point survives.
export function rippleRecoverAdjacentRemoval(removals = [], manualCuts = [], clip = {}, edge = "end", targetSource = 0, sourceDuration = 0) {
  const cleanRemovals = (removals || []).map((r) => ({ ...r }));
  let cleanCuts = [...(manualCuts || [])];
  const srcStart = Number(clip.sourceStart || 0);
  const srcEnd = Number(clip.sourceEnd || srcStart + 0.04);
  const maxDur = Math.max(srcEnd, Number(sourceDuration || 0));
  const target = Math.max(0, Math.min(maxDur, Number(targetSource || 0)));
  let deltaSource = 0;

  if (edge === "end" && target > srcEnd + 0.002) {
    const idx = adjacentRemoval(cleanRemovals, clip, "end")?.index ?? -1;
    if (idx >= 0) {
      const adj = cleanRemovals[idx];
      const farBoundary = Number(adj.end);
      const actualTarget = Math.min(target, farBoundary);
      deltaSource = actualTarget - srcEnd;
      if (actualTarget >= farBoundary - 0.002) {
        cleanRemovals.splice(idx, 1);
        if (farBoundary > 0.002 && farBoundary < maxDur - 0.002)
          cleanCuts.push(farBoundary);
      } else {
        adj.start = actualTarget;
      }
      // Remove manual cuts at the old boundary and inside the recovered range
      // [srcEnd, actualTarget) — but preserve the cut at actualTarget (next clip boundary)
      cleanCuts = cleanCuts.filter((c) => {
        const cv = Number(c);
        return cv < srcEnd - 0.002 || cv >= actualTarget - 0.002;
      });
    }
    // If no adjacent removal → source is already visible, no delta
  } else if (edge === "start" && target < srcStart - 0.002) {
    const idx = adjacentRemoval(cleanRemovals, clip, "start")?.index ?? -1;
    if (idx >= 0) {
      const adj = cleanRemovals[idx];
      const farBoundary = Number(adj.start);
      const actualTarget = Math.max(target, farBoundary);
      deltaSource = srcStart - actualTarget;
      if (actualTarget <= farBoundary + 0.002) {
        cleanRemovals.splice(idx, 1);
        if (farBoundary > 0.002 && farBoundary < maxDur - 0.002)
          cleanCuts.push(farBoundary);
      } else {
        adj.end = actualTarget;
      }
      // Remove manual cuts at the old boundary and inside (actualTarget, srcStart]
      cleanCuts = cleanCuts.filter((c) => {
        const cv = Number(c);
        return cv <= actualTarget + 0.002 || cv > srcStart + 0.002;
      });
    }
  }

  return {
    removals: normalizeRemovalsList(cleanRemovals),
    manualCuts: cleanCuts
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
      .filter((cut, index, list) => index === 0 || cut - list[index - 1] > 0.002),
    deltaSource,
    targetSource: edge === "start" ? srcStart - deltaSource : srcEnd + deltaSource,
  };
}

export function commitMainEdgeTrim({
  removals = [],
  manualCuts = [],
  clip = {},
  edge = "end",
  targetSource = 0,
  sourceDuration = 0,
  mode = "ripple",
  snapshot = [],
  globalOffset = 0,
  speed = 1,
} = {}) {
  const srcStart = Number(clip.sourceStart || 0);
  const srcEnd = Number(clip.sourceEnd || srcStart + 0.04);
  const bounds = mainTrimSourceBounds({
    removals,
    clip,
    edge,
    sourceDuration,
    snapshot,
    mode,
    speed,
  });
  const clampedTarget = Math.max(
    bounds.min,
    Math.min(bounds.max, Number(targetSource || 0)),
  );
  const isOutwardExtend =
    (edge === "end" && clampedTarget > srcEnd + 0.002) ||
    (edge === "start" && clampedTarget < srcStart - 0.002);

  // Every outward trim uses the adjacent-handle path. The old greedy path
  // crossed edit points and rebuilt the dragged frames as a separate sliver.
  const trim = isOutwardExtend
    ? rippleRecoverAdjacentRemoval(
        removals,
        manualCuts,
        clip,
        edge,
        clampedTarget,
        sourceDuration,
      )
    : applyMainTrimEdge(
        removals,
        manualCuts,
        clip,
        edge,
        clampedTarget,
        sourceDuration,
      );
  let nextRemovals = trim.removals;
  let nextCuts = trim.manualCuts;
  let packed = buildPackedMainClips(
    nextRemovals,
    nextCuts,
    sourceDuration,
    speed,
  );
  const pruned = dropSubframeClips(packed, nextRemovals, nextCuts, sourceDuration, speed);
  packed = pruned.packed;
  nextRemovals = pruned.removals;
  nextCuts = pruned.manualCuts;
  const deltaTimeline = Number(trim.deltaSource || 0) / Math.max(0.05, Number(speed || 1));
  const effectiveTargetSource = Number(trim.targetSource ?? clampedTarget);
  const offsets = rebuildClipOffsets({
    snapshot,
    packed,
    globalOffset,
    mode,
    editedClip: clip,
    edge,
    targetSource: effectiveTargetSource,
    speed,
    rippleFrom: Number(clip.start || 0),
  });
  const window = mode === "ripple"
    ? overlayRippleWindow(clip, edge, deltaTimeline)
    : { from: Number(clip.end || 0), delta: 0 };
  return {
    ...trim,
    removals: nextRemovals,
    manualCuts: nextCuts,
    packed,
    videoOffsets: offsets,
    audioOffsets: { ...offsets },
    overlayFrom: window.from,
    overlayDelta: window.delta,
    targetSource: effectiveTargetSource,
    sourceBounds: bounds,
  };
}

export function normalizeRemovalsList(removals = []) {
  const clean = (removals || [])
    .filter((r) => Number(r?.end) > Number(r?.start) + 0.002)
    .sort((a, b) => Number(a.start) - Number(b.start));
  if (!clean.length) return [];
  const merged = [{ ...clean[0] }];
  for (let i = 1; i < clean.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = clean[i];
    if (Number(curr.start) <= Number(prev.end) + 0.002) {
      prev.end = Math.max(Number(prev.end), Number(curr.end));
    } else {
      merged.push({ ...curr });
    }
  }
  return merged.filter((r) => r.end > r.start + 0.002);
}

export function applyMainTrimEdge(removals = [], manualCuts = [], clip = {}, edge = "end", targetSource = 0, sourceDuration = 0) {
  const cleanRemovals = (removals || []).map((r) => ({ ...r }));
  let cleanCuts = [...(manualCuts || [])];
  const srcStart = Number(clip.sourceStart || 0);
  const srcEnd = Number(clip.sourceEnd || srcStart + 0.04);
  const maxDur = Math.max(srcEnd, Number(sourceDuration || 0));
  const clampedTarget = Math.max(0, Math.min(maxDur, Number(targetSource || 0)));
  let deltaSource = 0;

  if (
    (edge === "start" && clampedTarget < srcStart - 0.002) ||
    (edge === "end" && clampedTarget > srcEnd + 0.002)
  )
    return rippleRecoverAdjacentRemoval(
      removals,
      manualCuts,
      clip,
      edge,
      clampedTarget,
      sourceDuration,
    );

  if (edge === "start") {
    if (clampedTarget > srcStart + 0.002) {
      // Inward trim (cutting away head)
      cleanRemovals.push({ start: srcStart, end: Math.min(srcEnd - 0.04, clampedTarget), source: "edge-trim" });
      deltaSource = -(Math.min(srcEnd - 0.04, clampedTarget) - srcStart);
    }
  } else if (edge === "end") {
    if (clampedTarget < srcEnd - 0.002) {
      // Inward trim (cutting away tail)
      cleanRemovals.push({ start: Math.max(srcStart + 0.04, clampedTarget), end: srcEnd, source: "edge-trim" });
      deltaSource = -(srcEnd - Math.max(srcStart + 0.04, clampedTarget));
    }
  }

  return {
    removals: normalizeRemovalsList(cleanRemovals),
    manualCuts: cleanCuts.sort((a, b) => a - b),
    deltaSource,
    targetSource: clampedTarget,
  };
}

export function rollingEditMainClips(removals = [], manualCuts = [], leftClip = {}, rightClip = {}, targetSource = 0) {
  const cleanRemovals = (removals || []).map((r) => ({ ...r }));
  const cleanCuts = (manualCuts || []).filter(
    (c) => c < Number(leftClip.sourceStart || 0) + 0.002 || c > Number(rightClip.sourceEnd || 0) - 0.002,
  );
  const minBound = Number(leftClip.sourceStart || 0) + 0.04;
  const maxBound = Number(rightClip.sourceEnd || minBound + 0.04) - 0.04;
  const cutPoint = Math.max(minBound, Math.min(maxBound, Number(targetSource || 0)));

  // Remove any removals that existed between left and right clip (e.g. gaps)
  for (let i = cleanRemovals.length - 1; i >= 0; i--) {
    const r = cleanRemovals[i];
    if (r.start >= Number(leftClip.sourceStart || 0) && r.end <= Number(rightClip.sourceEnd || 0)) {
      cleanRemovals.splice(i, 1);
    }
  }
  cleanCuts.push(cutPoint);
  return {
    removals: normalizeRemovalsList(cleanRemovals),
    manualCuts: cleanCuts.sort((a, b) => a - b),
    cutPoint,
  };
}

export function slipClipSource(clip = {}, deltaSource = 0, minSource = 0, maxSource = Infinity) {
  const srcStart = Number(clip.sourceStart || 0);
  const srcEnd = Number(clip.sourceEnd || srcStart + 0.04);
  const duration = srcEnd - srcStart;
  const targetStart = Math.max(minSource, Math.min(maxSource - duration, srcStart + deltaSource));
  return {
    sourceStart: targetStart,
    sourceEnd: targetStart + duration,
  };
}

export function rippleShiftAllTracks(collections = {}, fromTimelineTime = 0, deltaTimeline = 0) {
  if (Math.abs(deltaTimeline) <= 0.001) return collections;
  const shiftList = (list) => {
    for (const item of list || []) {
      if (Number(item.start || 0) >= fromTimelineTime - 0.002) {
        item.start = Math.max(0, Number(item.start || 0) + deltaTimeline);
        item.end = Math.max(item.start + 0.04, Number(item.end || 0) + deltaTimeline);
        if (Array.isArray(item.words)) {
          for (const word of item.words) {
            word.start = Math.max(0, Number(word.start || 0) + deltaTimeline);
            word.end = Math.max(word.start + 0.01, Number(word.end || 0) + deltaTimeline);
          }
        }
      }
    }
  };
  shiftList(collections.videoLayers);
  shiftList(collections.audioAssets);
  shiftList(collections.images);
  shiftList(collections.titles);
  shiftList(collections.captions);
  shiftList(collections.reviewCaptions);
  shiftList(collections.audioMutes);
  shiftList(collections.issues);
  return collections;
}
