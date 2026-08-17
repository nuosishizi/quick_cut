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

export function snapThresholdSeconds(zoom, minSeconds = 0.04, pixelWindow = 12) {
  return Math.max(minSeconds, pixelWindow / Math.max(1, Number(zoom) || 1));
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
  return { major: 1 / 15, minor: 1 / 30, micro: 1 / 60 };
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
