import fs from "node:fs";
import path from "node:path";
import { getLastReviewTransport, completeGeminiReview, loadReviewSettings } from "./ai-settings.mjs";
import { supportRoot } from "./media.mjs";

const MAX_BATCH = 24;

const MODE_PROMPTS = {
  strict: `You review English voiceover against a manuscript. Mode: STRICT manuscript cut.
The finished video should sound like the manuscript was read cleanly, in order.
Captions already use the manuscript. You only decide which spoken spans stay.

Choose one decision per item:
- keep: only ASR glitches or the same word misspelled (The/Tthe, Bible/Byble).
- cut: extra talk, restarts, rereads, self-corrections (keep the later take), off-script asides, or meaning changes.
- missing: manuscript phrase was not spoken. Do not cut.
- unsure: leave the original mark.

Prefer cut for anything that does not serve the manuscript. Keep is rare.
Return JSON only: {"decisions":[{"id":"...","decision":"cut","reason":"..."}]}`,
  natural: `You review English voiceover against a manuscript. Mode: NATURAL fluency.
  The finished video should follow the manuscript meaning, but the voiceover does not need to match word for word.
  Captions already use the manuscript. You only decide which spoken spans stay.

Choose one decision per item:
- keep: ASR glitch (The/Tthe, dropped leading T), same meaning, filler, a title/question expansion such as "Are You Guilty?" → "Are you guilty of any...", or a short helpful aside.
  - cut: only a clearly abandoned reread/restart followed by a cleaner replacement, a long off-topic tangent, or a real meaning-changing error followed by a correct take.
  - missing: manuscript phrase was not spoken. Do not cut.
  - unsure: leave the original mark for human review and never cut it automatically.

  A pause, breath, timestamp gap, ASR boundary, caption boundary, punctuation split, or number split is never proof of a restart. A restart requires later audio to repeat or replace content already attempted.
  Normalize contractions, Bible references, and spoken/written number forms by meaning. Default to keep for harmless wording differences and natural additions.
  Return JSON only: {"decisions":[{"id":"...","decision":"keep","confidence":"high|medium|low","reason":"..."}]}`,
};

export const DEFAULT_REVIEW_PROMPTS = MODE_PROMPTS;

export function parseJudgeResponse(text) {
  const raw = String(text || "").trim();
  const block = raw.startsWith("{")
    ? raw
    : (raw.match(/\{[\s\S]*\}/) || [])[0];
  if (!block) return [];
  let data = {};
  try {
    data = JSON.parse(block);
  } catch {
    return [];
  }
  const rows = Array.isArray(data.decisions)
    ? data.decisions
    : Array.isArray(data)
      ? data
      : [];
  return rows
    .map((row) => {
      const decision = String(row?.decision || row?.action || "")
        .toLowerCase()
        .trim();
      if (!["keep", "cut", "missing", "unsure"].includes(decision)) return null;
      const id = String(row?.id || "").trim();
      if (!id) return null;
      return {
        id,
        decision,
        confidence: ["high", "medium", "low"].includes(String(row?.confidence || "").toLowerCase())
          ? String(row.confidence).toLowerCase()
          : "",
        reason: String(row?.reason || "").trim().slice(0, 180),
      };
    })
    .filter(Boolean);
}

function nearbyWords(operations = [], issue, direction) {
  const start = Number(issue?.start || 0);
  const end = Number(issue?.end || start);
  const words = [];
  for (const operation of operations) {
    const spoken = operation.spoken;
    const expected = operation.expected;
    const time = Number(spoken?.start ?? expected?.start ?? 0);
    if (direction < 0 && time >= start - 0.01) continue;
    if (direction > 0 && time <= end + 0.01) continue;
    const display = expected?.display || spoken?.display;
    if (display) words.push({ time, display });
  }
  words.sort((a, b) => a.time - b.time);
  const slice = direction < 0 ? words.slice(-8) : words.slice(0, 8);
  return slice.map((item) => item.display).join(" ");
}

export function issueJudgePayload(issue, operations = []) {
  return {
    id: issue.id,
    type: issue.type,
    scripture: !!(issue.scripture || issue.strict),
    spoken: String(issue.spokenText || "").replace(/^\s*[—-]\s*$/, "").trim(),
    expected: String(issue.expectedText || "").replace(/^\s*[—-]\s*$/, "").trim(),
    before: nearbyWords(operations, issue, -1),
    after: nearbyWords(operations, issue, 1),
  };
}

export function normalizeReviewMode(mode) {
  return mode === "strict" ? "strict" : "natural";
}

function cleanPhrase(value) {
  return String(value || "")
    .replace(/^\s*[—-]\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseWords(value) {
  return cleanPhrase(value).split(" ").filter(Boolean);
}

export function looksLikeAsrGlitch(spoken, expected) {
  const a = cleanPhrase(spoken);
  const b = cleanPhrase(expected);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length <= 12 && b.length <= 12) {
    if (a.endsWith(b) || b.endsWith(a) || a.startsWith(b) || b.startsWith(a)) return true;
    if (a.replace(/the/g, "") === b.replace(/the/g, "") && a.length <= 8) return true;
  }
  return false;
}

const MEANINGLESS_WORDS = new Set(
  "a an the this that these those it its to of in on for and or so just".split(" "),
);

export function looksLikeSamePoint(spoken, expected) {
  const spokenWords = phraseWords(spoken);
  const expectedWords = phraseWords(expected);
  if (!spokenWords.length || !expectedWords.length) return false;
  if (looksLikeAsrGlitch(spoken, expected)) return true;
  if (spokenWords.length > 12 || expectedWords.length > 12) return false;
  const spokenSet = new Set(spokenWords);
  const expectedSet = new Set(expectedWords);
  const overlap = expectedWords.filter((word) => spokenSet.has(word)).length;
  const coverage = overlap / Math.max(expectedSet.size, 1);
  const spokenCore = spokenWords.filter((word) => !MEANINGLESS_WORDS.has(word));
  const expectedCore = expectedWords.filter((word) => !MEANINGLESS_WORDS.has(word));
  const coreOverlap = expectedCore.filter((word) => spokenSet.has(word)).length;
  const coreCoverage = expectedCore.length
    ? coreOverlap / expectedCore.length
    : coverage;
  const same =
    (coverage >= 0.66 || coreCoverage >= 0.55) &&
    spokenWords.length <= expectedWords.length + 6 &&
    spokenCore.length <= expectedCore.length + 3;
  if (same) return true;
  if (expectedWords.length >= 6 && spokenWords.length >= 3 && spokenWords.length <= 10) {
    for (let start = 0; start <= expectedWords.length - 3; start += 1) {
      const window = expectedWords.slice(start, start + Math.min(5, expectedWords.length - start));
      if (window.length >= 3 && looksLikeSamePoint(spoken, window.join(" "))) return true;
    }
  }
  return false;
}

function overlappingManuscript(operations = [], issue) {
  const start = Number(issue?.start || 0);
  const end = Math.max(start, Number(issue?.end || start));
  const words = [];
  for (const operation of operations) {
    const expected = operation.expected;
    if (!expected?.display) continue;
    const time = Number(expected.start ?? operation.spoken?.start ?? 0);
    if (time >= start - 1.6 && time <= end + 1.6) words.push(expected.display);
  }
  return words.join(" ");
}

export function inferKeepable(issue, mode = "natural", operations = []) {
  if (issue?.scripture || issue?.strict) {
    return looksLikeAsrGlitch(issue.spokenText, issue.expectedText);
  }
  if (!issue || issue.type === "missing" || issue.type === "repeat") return false;
  const spoken = String(issue.spokenText || issue.text || "");
  let expected = String(issue.expectedText || "");
  if (!cleanPhrase(expected))
    expected = overlappingManuscript(operations, issue) ||
      `${nearbyWords(operations, issue, -1)} ${nearbyWords(operations, issue, 1)}`;
  if (looksLikeAsrGlitch(spoken, expected)) return true;
  if (normalizeReviewMode(mode) !== "natural") return false;
  if (["extra", "addition", "mismatch", "near", "semantic"].includes(issue.type))
    return looksLikeSamePoint(spoken, expected);
  return false;
}

function applyKeep(issue, reason = "") {
  issue.confirmedCut = false;
  issue.confirmedError = false;
  issue.suggested = false;
  issue.severity = "low";
  issue.action = "keep";
  issue.suppressReview = true;
  if (reason && !issue.aiReason) issue.aiReason = reason;
}

export function applyJudgeDecisions(aligned, decisions = [], mode = "natural") {
  const reviewMode = normalizeReviewMode(mode);
  const cuttable =
    reviewMode === "strict"
      ? new Set(["extra", "repeat", "mismatch", "addition"])
      : new Set(["extra", "repeat", "mismatch"]);
  const byId = new Map(decisions.map((item) => [item.id, item]));
  const summary = { keep: 0, cut: 0, missing: 0, unsure: 0, mode: reviewMode };
  for (const issue of aligned.issues || []) {
    const judged = byId.get(issue.id);
    const scripture = !!(issue.scripture || issue.strict);
    if (scripture) issue.scripture = true;
    const inferredKeep = inferKeepable(issue, reviewMode, aligned.operations || []);
    if (scripture && !looksLikeAsrGlitch(issue.spokenText, issue.expectedText)) {
      issue.confirmedError = issue.type === "mismatch" || issue.type === "missing";
      issue.confirmedCut = false;
      issue.suppressReview = false;
      if (issue.type === "missing") issue.action = "missing";
      else if (issue.type !== "repeat") {
        issue.action = "unsure";
        issue.label = "经文差异，需人工复核";
      }
      issue.aiDecision = judged?.decision || "scripture";
      issue.aiConfidence = judged?.confidence || "";
      issue.aiMode = reviewMode;
      if (issue.confirmedError) summary.missing += issue.type === "missing" ? 1 : 0;
      continue;
    }
    if (!judged) {
      if (inferredKeep) {
        summary.keep += 1;
        issue.aiDecision = "keep";
        issue.aiMode = reviewMode;
        applyKeep(issue, "local same-point keep");
      } else if (issue.type === "repeat") {
        summary.cut += 1;
        issue.aiDecision = "cut";
        issue.aiMode = reviewMode;
        issue.confirmedCut = true;
        issue.suggested = true;
        issue.action = "cut";
        issue.suppressReview = false;
      }
      continue;
    }
    let decision = judged.decision;
    if ((decision === "unsure" || (decision === "cut" && inferredKeep && reviewMode === "natural")) && inferredKeep)
      decision = "keep";
    issue.aiDecision = decision;
    issue.aiConfidence = judged.confidence || "";
    issue.aiReason = judged.reason || "";
    issue.aiMode = reviewMode;
    summary[decision] = (summary[decision] || 0) + 1;
    if (decision === "keep") {
      issue.confirmedCut = false;
      issue.confirmedError = false;
      issue.suggested = false;
      issue.severity = "low";
      issue.action = "keep";
      issue.suppressReview = true;
      continue;
    }
    if (decision === "unsure") {
      issue.confirmedCut = false;
      issue.suggested = true;
      issue.action = "unsure";
      issue.suppressReview = false;
      continue;
    }
    if (decision === "cut" && cuttable.has(issue.type)) {
      issue.confirmedCut = true;
      issue.suggested = true;
      issue.action = "cut";
      issue.suppressReview = false;
      continue;
    }
    if (decision === "missing" && (issue.type === "missing" || !String(issue.spokenText || "").replace(/^\s*[—-]\s*$/, "").trim())) {
      issue.confirmedCut = false;
      issue.action = "missing";
      issue.suppressReview = false;
    }
  }
  return summary;
}

function systemPromptFor(mode) {
  const reviewMode = normalizeReviewMode(mode);
  const settings = loadReviewSettings();
  const custom = reviewMode === "strict" ? settings.promptStrict : settings.promptNatural;
  const base = MODE_PROMPTS[reviewMode];
  const scriptureRule = `
Scripture and quoted Word of God (items with scripture=true) require semantic care, not speculative deletion.
Equivalent number formats, Bible-reference forms, contractions, connected speech, and clear ASR variants are not errors.
If important wording may genuinely be wrong and no clearly correct later take replaces it, decision=unsure, never cut.
Only an earlier wrong take followed by a clearly correct reread may be cut.
A pause or segmentation boundary alone can never be a reread or restart.`;
  return `${custom.trim() || base}\n${scriptureRule}`;
}

export function reviewCompareLogPath() {
  const directory = path.join(supportRoot(), "logs");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, "review-compare.jsonl");
}

export function reviewCompareLatestPath() {
  return path.join(path.dirname(reviewCompareLogPath()), "review-compare-latest.txt");
}

function clipLogText(value, max = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildReviewCompareRecord({
  mode = "natural",
  issues = [],
  decisions = [],
  summary = {},
  batches = [],
} = {}) {
  const transport = getLastReviewTransport();
  const byId = new Map((decisions || []).map((item) => [item.id, item]));
  const items = (issues || []).map((issue) => {
    const judged = byId.get(issue.id);
    return {
      id: issue.id,
      type: issue.type || "",
      scripture: !!(issue.scripture || issue.strict),
      spoken: clipLogText(issue.spokenText || issue.text, 120),
      expected: clipLogText(issue.expectedText, 120),
      ai: judged?.decision || issue.aiDecision || "",
      reason: clipLogText(judged?.reason || issue.aiReason, 160),
      applied: issue.action || "",
      cut: issue.confirmedCut === true,
      hidden: issue.suppressReview === true,
    };
  });
  const parsed = items.filter((item) => item.ai).length;
  return {
    at: new Date().toISOString(),
    provider: transport.provider || loadReviewSettings().provider,
    requestedModel: transport.requestedModel || "",
    usedModel: transport.usedModel || "",
    fallback: Boolean(transport.fallback),
    mode: normalizeReviewMode(mode),
    durationMs: Number(transport.ms) || batches.reduce((sum, batch) => sum + Number(batch.ms || 0), 0),
    issueCount: items.length,
    parsedCount: parsed,
    unmatched: Math.max(0, items.length - parsed),
    summary: {
      keep: Number(summary.keep) || 0,
      cut: Number(summary.cut) || 0,
      missing: Number(summary.missing) || 0,
      unsure: Number(summary.unsure) || 0,
    },
    batches,
    items,
  };
}

export function formatReviewCompareText(record = {}, logPath = "") {
  const lines = [
    "======== 快剪纠正对比 ========",
    `接口: ${record.provider || "?"}    实际模型: ${record.usedModel || record.requestedModel || "?"}${record.fallback ? "    (已回退)" : ""}`,
    `模式: ${record.mode || "?"}    耗时: ${((Number(record.durationMs) || 0) / 1000).toFixed(1)}s    条目: ${record.issueCount || 0}    模型返回: ${record.parsedCount || 0}    未返回: ${record.unmatched || 0}`,
    `判定: keep=${record.summary?.keep || 0}  cut=${record.summary?.cut || 0}  missing=${record.summary?.missing || 0}  unsure=${record.summary?.unsure || 0}`,
    "id\ttype\tai\tapplied\tspoken\texpected\treason",
  ];
  for (const item of record.items || []) {
    lines.push(
      [
        item.id,
        item.type,
        item.ai || "-",
        item.applied || "-",
        item.spoken || "-",
        item.expected || "-",
        item.reason || "",
      ].join("\t"),
    );
  }
  lines.push(`日志: ${logPath || "logs/review-compare.jsonl"}`);
  lines.push("================================");
  return lines.join("\n");
}

export function writeReviewCompareLog(record) {
  const jsonl = reviewCompareLogPath();
  const latest = reviewCompareLatestPath();
  const text = formatReviewCompareText(record, jsonl);
  fs.appendFileSync(jsonl, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(latest, text, { encoding: "utf8", mode: 0o600 });
  console.log(`\n${text}\n`);
  return { jsonl, latest, text };
}

async function completeJudge(userPrompt, signal, mode = "natural") {
  const started = Date.now();
  const text = await completeGeminiReview({
    system: systemPromptFor(mode),
    user: userPrompt,
    signal,
  });
  return {
    decisions: parseJudgeResponse(text),
    raw: String(text || "").slice(0, 1200),
    ms: Date.now() - started,
  };
}

export async function judgeAlignmentIssues({
  script,
  issues = [],
  operations = [],
  signal = null,
  mode = "natural",
} = {}) {
  if (!issues.length) return [];
  const reviewMode = normalizeReviewMode(mode);
  const decisions = [];
  const batches = [];
  for (let offset = 0; offset < issues.length; offset += MAX_BATCH) {
    if (signal?.aborted) throw new Error("cancelled");
    const batch = issues.slice(offset, offset + MAX_BATCH);
    const payload = batch.map((issue) => issueJudgePayload(issue, operations));
    const userPrompt = [
      `Mode: ${reviewMode}`,
      "Manuscript:",
      String(script || "").trim().slice(0, 6000),
      "",
      "Differences:",
      JSON.stringify(payload, null, 2),
    ].join("\n");
    const judged = await completeJudge(userPrompt, signal, reviewMode);
    decisions.push(...judged.decisions);
    batches.push({
      index: batches.length,
      count: batch.length,
      parsed: judged.decisions.length,
      ms: judged.ms,
      raw: judged.raw,
    });
  }
  return { decisions, batches };
}

function clipPlanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function isLockedScripture(issue) {
  if (!(issue?.scripture || issue?.strict)) return false;
  if (issue.suppressReview && looksLikeAsrGlitch(issue.spokenText, issue.expectedText)) return false;
  return true;
}

function polishIssueRow(issue) {
  return {
    id: String(issue.id || ""),
    type: String(issue.type || ""),
    spoken: clipPlanText(issue.spokenText || issue.text),
    spokenText: clipPlanText(issue.spokenText || issue.text),
    expected: clipPlanText(issue.expectedText),
    expectedText: clipPlanText(issue.expectedText),
    action: String(issue.action || ""),
    start: Number(issue.start || 0),
    end: Number(issue.end || issue.start || 0),
    scripture: !!(issue.scripture || issue.strict),
    strict: !!issue.strict,
  };
}

export function buildGlobalPolishPlan(issues = []) {
  const autoCut = [];
  const keepSpoken = [];
  const scriptureLock = [];
  const missing = [];
  const leftover = [];
  for (const issue of issues || []) {
    const row = polishIssueRow(issue);
    if (isLockedScripture(issue)) {
      scriptureLock.push(row);
      continue;
    }
    if (issue.confirmedCut === true && issue.action !== "keep" && issue.suppressReview !== true) {
      autoCut.push(row);
      continue;
    }
    if (issue.action === "keep" || issue.suppressReview === true) {
      keepSpoken.push(row);
      continue;
    }
    if (issue.type === "missing" || issue.action === "missing") {
      missing.push(row);
      continue;
    }
    leftover.push(row);
  }
  return {
    autoCut,
    keepSpoken,
    scriptureLock,
    missing,
    leftover,
  };
}

export function formatGlobalPolishSummary(plan = {}, autoApplied = 0) {
  const scripture = (plan.scriptureLock || []).length;
  const missing = (plan.missing || []).length;
  const kept = (plan.keepSpoken || []).length;
  const leftover = (plan.leftover || []).length;
  const merged = (plan.mergedSpoken || []).length;
  const notes = (plan.strippedNotes || []).length;
  return `全局整理完成：自动切 ${autoApplied} 处重录/废读，口语并进 ${merged} 条，清掉 ${notes} 处备注，保留 ${kept} 处口语，${scripture} 处经文请你点，${missing} 处缺读待补${leftover ? `，${leftover} 处仍待确认` : ""}。`;
}

export function blockingScriptureIssues(issues = []) {
  return (issues || []).filter((issue) => {
    if (!(issue.scripture || issue.strict)) return false;
    if (issue.suppressReview && looksLikeAsrGlitch(issue.spokenText, issue.expectedText))
      return false;
    return (
      issue.confirmedError === true ||
      issue.type === "missing" ||
      issue.type === "mismatch"
    );
  });
}

const BIBLE_BOOKS = new Set(
  "genesis exodus leviticus numbers deuteronomy joshua judges ruth samuel kings chronicles ezra nehemiah esther job psalms psalm proverbs ecclesiastes song isaiah jeremiah lamentations ezekiel daniel hosea joel amos obadiah jonah micah nahum habakkuk zephaniah haggai zechariah malachi matthew mark luke john acts romans corinthians galatians ephesians philippians colossians thessalonians timothy titus philemon hebrews james peter jude revelation".split(
    " ",
  ),
);

const STAGE_NOTE_HEADS = new Set(
  "pause pauses beat beats hold wait slow slower fast faster emphasis emph stress look camera cut note notes whisper louder softer smile title broll screen subscribe hook cta vo vox sfx os oc 停顿 强调 慢读 快读 看镜头 不读".split(
    " ",
  ),
);
const STAGE_NOTE_FILLERS = new Set(
  "at the this to on a an of and for your my".split(" "),
);
const PRODUCTION_TAGS = new Set(
  "cta hook broll b-roll vo vox sfx os oc subscribe endscreen end-screen titlecard title-card lowerthird lower-third".split(
    " ",
  ),
);
const MERGEABLE_ASIDES = new Set(
  "uh um er erm ah hmm well okay ok so actually basically literally just like anyway anyways right yeah yes youknow imean you know see mean friend friends dear in fact of course honestly truly really remember listen look amen".split(
    " ",
  ),
);

const SPOKEN_WORD_PATTERN =
  /\d+:\d+(?:-\d+)?|[\$¥€£]\d+(?:\.\d+)?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?(?:kg|km|m|cm|mm|px|ms|s)|[A-Za-z]\.(?:[A-Za-z]\.)+|[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

function cloneCaptions(captions = []) {
  return (captions || []).map((caption) => ({
    ...caption,
    words: Array.isArray(caption.words)
      ? caption.words.map((word) => ({ ...word }))
      : caption.words,
  }));
}

function captionTextFromWords(words = []) {
  return (words || [])
    .map((word) => word?.display || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([\-–—])\s+(?=\d)/g, "$1");
}

function wordsOfCaption(caption) {
  if (Array.isArray(caption?.words) && caption.words.length) return caption.words;
  const tokens = String(caption?.text || "").split(/\s+/).filter(Boolean);
  const start = Number(caption?.start || 0);
  const end = Math.max(start + 0.04, Number(caption?.end || start));
  return tokens.map((display, index) => ({
    display,
    start: start + ((end - start) * index) / Math.max(1, tokens.length),
    end: start + ((end - start) * (index + 1)) / Math.max(1, tokens.length),
    matchType: "match",
  }));
}

function wordWasSpoken(word) {
  return (
    ["match", "near", "spoken_addition"].includes(String(word?.matchType || "")) ||
    word?.userInserted === true ||
    word?.userKept === true
  );
}

function wordIsProtectedScripture(word) {
  return !!(word?.scripture || word?.strict);
}

function noteCore(text) {
  return String(text || "")
    .replace(/[()[\]（）【】"""''“”‘’]+/g, " ")
    .replace(/[.,!?;:—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isProductionTag(text) {
  const raw = String(text || "").trim();
  const cleaned = noteCore(raw).replace(/\s+/g, " ");
  if (!cleaned) return false;
  const compact = cleaned.replace(/[\s-]+/g, "");
  if (PRODUCTION_TAGS.has(cleaned) || PRODUCTION_TAGS.has(compact)) return true;
  const words = cleaned.split(" ").filter(Boolean);
  return words.length === 1 && PRODUCTION_TAGS.has(words[0]);
}

export function isStageDirectionNote(text) {
  if (isProductionTag(text)) return true;
  const cleaned = noteCore(text);
  if (!cleaned || cleaned.length > 56) return false;
  const words = cleaned.split(" ").filter(Boolean);
  if (!words.length || words.length > 8) return false;
  const hasHead = words.some((word) => STAGE_NOTE_HEADS.has(word) || word === "b-roll");
  if (!hasHead) return false;
  return words.every(
    (word) =>
      STAGE_NOTE_HEADS.has(word) ||
      STAGE_NOTE_FILLERS.has(word) ||
      word === "b-roll" ||
      word === "read" ||
      word === "dont" ||
      word === "don't" ||
      word === "do" ||
      word === "not" ||
      word === "slowly" ||
      word === "verse" ||
      word === "number" ||
      word === "skip",
  );
}

function isWrappedNoteText(text) {
  return /[(\[（【{]/.test(String(text || "")) && /[)\]）】}]/.test(String(text || ""));
}

export function isScriptureHeadingText(text) {
  const cleaned = String(text || "")
    .replace(/[()[\].,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return false;
  const match = cleaned.match(
    /^(?:(?:1|2|3|i|ii|iii)\s+)?([a-z]+)(?:\s+of\s+[a-z]+)?\s+\d+(?:\s*:\s*\d+(?:\s*[-–—]\s*\d+)?)?$/,
  );
  if (!match) return false;
  return BIBLE_BOOKS.has(match[1]) || match[1] === "songs";
}

function parentheticalRuns(words = []) {
  const runs = [];
  let index = 0;
  while (index < words.length) {
    const display = String(words[index]?.display || "");
    const opens = (display.match(/[(\[（【]/g) || []).length;
    const closes = (display.match(/[)\]）】]/g) || []).length;
    if (opens > 0 || /^[(\[（【]/.test(display)) {
      const start = index;
      let depth = opens - closes;
      index += 1;
      while (index < words.length && depth > 0) {
        const next = String(words[index]?.display || "");
        depth += (next.match(/[(\[（【]/g) || []).length;
        depth -= (next.match(/[)\]）】]/g) || []).length;
        index += 1;
      }
      runs.push({ start, end: index });
      continue;
    }
    index += 1;
  }
  return runs;
}

function overlapsLockedScripture(start, end, issues = []) {
  return (issues || []).some((issue) => {
    if (!isLockedScripture(issue)) return false;
    const left = Number(issue.start || 0);
    const right = Math.max(left, Number(issue.end || left));
    return Math.min(end, right) - Math.max(start, left) > -0.05;
  });
}

function stripWordsFromCaption(caption, removeAt) {
  const words = wordsOfCaption(caption).filter((_, index) => !removeAt.has(index));
  if (!words.length) return null;
  caption.words = words;
  caption.start = Number(words[0].start || caption.start || 0);
  caption.end = Math.max(
    caption.start + 0.04,
    Number(words.at(-1).end || caption.end || caption.start + 0.04),
  );
  caption.text = captionTextFromWords(words);
  return caption;
}

export function stripCaptionNotes(captions = [], issues = []) {
  const next = cloneCaptions(captions);
  const stripped = [];
  const kept = [];
  for (const caption of next) {
    const words = wordsOfCaption(caption);
    if (!words.length) {
      kept.push(caption);
      continue;
    }
    if (words.some((word) => wordIsProtectedScripture(word))) {
      kept.push(caption);
      continue;
    }
    const start = Number(caption.start || words[0].start || 0);
    const end = Math.max(start, Number(caption.end || words.at(-1).end || start));
    if (overlapsLockedScripture(start, end, issues)) {
      kept.push(caption);
      continue;
    }
    const removeAt = new Set();
    const wholeText = captionTextFromWords(words) || String(caption.text || "");
    const headingUnspoken = !words.some(wordWasSpoken) && isScriptureHeadingText(wholeText);
    const productionCaption =
      isProductionTag(wholeText) ||
      (isWrappedNoteText(wholeText) && isStageDirectionNote(wholeText));
    if (headingUnspoken || productionCaption) {
      stripped.push({
        id: String(caption.id || ""),
        type: productionCaption ? "note" : "heading",
        text: wholeText,
        start,
        end,
      });
      continue;
    }
    for (let index = 0; index < words.length; index += 1) {
      const display = String(words[index]?.display || "");
      if (wordIsProtectedScripture(words[index])) continue;
      if (isProductionTag(display) || (isWrappedNoteText(display) && isStageDirectionNote(display))) {
        removeAt.add(index);
        stripped.push({
          id: String(caption.id || ""),
          type: "note",
          text: display,
          start: Number(words[index]?.start || start),
          end: Number(words[index]?.end || end),
        });
      }
    }
    for (const run of parentheticalRuns(words)) {
      const slice = words.slice(run.start, run.end);
      if (slice.some((word) => wordIsProtectedScripture(word))) continue;
      const text = captionTextFromWords(slice);
      const spoken = slice.some(wordWasSpoken);
      const note = isStageDirectionNote(text) || isProductionTag(text);
      if (note || (!spoken && isWrappedNoteText(text))) {
        for (let index = run.start; index < run.end; index += 1) removeAt.add(index);
        stripped.push({
          id: String(caption.id || ""),
          type: note ? "note" : "aside",
          text,
          start: Number(slice[0]?.start || start),
          end: Number(slice.at(-1)?.end || end),
        });
      }
    }
    const cleaned = stripWordsFromCaption(caption, removeAt);
    if (cleaned) kept.push(cleaned);
  }
  return { captions: kept, stripped };
}

function tokenizeSpokenDisplay(text) {
  const displays = String(text || "").match(SPOKEN_WORD_PATTERN) || [];
  const tokens = [];
  let prefix = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  const CLOSING_OR_PAUSE_PUNCT = /^["”’」』》〉）】〕〗)\]}。，、；：！？…—～.,!?:;-]$/u;
  for (const token of displays) {
    if (/^[\p{L}\p{N}]/u.test(token)) {
      tokens.push({ display: `${prefix}${token}` });
      prefix = "";
    } else if (token === '"') {
      if (inDoubleQuote) {
        if (tokens.length) tokens.at(-1).display += token;
        else prefix += token;
        inDoubleQuote = false;
      } else {
        prefix += token;
        inDoubleQuote = true;
      }
    } else if (token === "'") {
      if (inSingleQuote) {
        if (tokens.length) tokens.at(-1).display += token;
        else prefix += token;
        inSingleQuote = false;
      } else {
        prefix += token;
        inSingleQuote = true;
      }
    } else if (/^[“‘「『《〈（【〔〖(\[{]$/u.test(token)) {
      prefix += token;
      if (token === "“") inDoubleQuote = true;
      if (token === "‘") inSingleQuote = true;
    } else if (CLOSING_OR_PAUSE_PUNCT.test(token)) {
      if (token === "”") inDoubleQuote = false;
      if (token === "’") inSingleQuote = false;
      if (tokens.length) tokens.at(-1).display += token;
      else prefix += token;
    } else if (tokens.length) {
      tokens.at(-1).display += token;
    } else {
      prefix += token;
    }
  }
  if (prefix && tokens.length) {
    tokens.at(-1).display += prefix;
  }
  return tokens;
}

export function shouldMergeSpoken(item = {}) {
  if (item.scripture || item.strict) return false;
  if (!["extra", "addition"].includes(String(item.type || ""))) return false;
  const spoken = clipPlanText(item.spokenText || item.spoken || item.text);
  const expected = clipPlanText(item.expectedText || item.expected);
  if (!spoken) return false;
  if (looksLikeAsrGlitch(spoken, expected)) return false;
  const words = phraseWords(spoken);
  if (!words.length || words.length > 4) return false;
  const conversational = words.every(
    (word) => MERGEABLE_ASIDES.has(word) || MERGEABLE_ASIDES.has(words.join(" ")),
  ) || MERGEABLE_ASIDES.has(words.join(" "));
  return conversational;
}

function captionHasSpoken(caption, spoken) {
  const have = cleanPhrase(caption?.text || captionTextFromWords(caption?.words));
  const want = cleanPhrase(spoken);
  return !!want && have.includes(want);
}

export function mergeSpokenIntoCaptions(captions = [], item = {}) {
  const spoken = clipPlanText(item.spokenText || item.spoken || item.text);
  if (!shouldMergeSpoken(item) || !spoken) {
    return { captions: cloneCaptions(captions), merged: false };
  }
  const start = Number(item.start || 0);
  const end = Math.max(start + 0.04, Number(item.end || start + 0.04));
  const next = cloneCaptions(captions).sort(
    (left, right) => Number(left.start || 0) - Number(right.start || 0),
  );
  const overlapping = next.filter(
    (caption) =>
      Math.min(Number(caption.end || 0), end) - Math.max(Number(caption.start || 0), start) > -0.08,
  );
  if (overlapping.some((caption) => captionHasSpoken(caption, spoken))) {
    return { captions: next, merged: false, alreadyPresent: true };
  }
  const previous = [...next].reverse().find((caption) => Number(caption.end || 0) <= start + 0.08);
  const following = next.find((caption) => Number(caption.start || 0) >= end - 0.08);
  const target =
    overlapping[0] ||
    (previous && following
      ? start - Number(previous.end || 0) <= Number(following.start || 0) - end
        ? previous
        : following
      : previous || following);
  const tokens = tokenizeSpokenDisplay(spoken);
  if (!tokens.length) return { captions: next, merged: false };
  const inserted = tokens.map((word, index) => ({
    display: word.display,
    start: start + ((end - start) * index) / Math.max(1, tokens.length),
    end: start + ((end - start) * (index + 1)) / Math.max(1, tokens.length),
    matchType: "match",
    issueType: "",
    expectedDisplay: word.display,
    userInserted: true,
  }));
  if (target) {
    target.words = wordsOfCaption(target);
    target.start = Math.min(Number(target.start || start), start);
    target.end = Math.max(Number(target.end || end), end);
    const insertAt = target.words.findIndex((word) => Number(word.start || 0) >= end - 0.01);
    target.words.splice(insertAt < 0 ? target.words.length : insertAt, 0, ...inserted);
    target.words.sort((left, right) => Number(left.start || 0) - Number(right.start || 0));
    target.text = captionTextFromWords(target.words);
  } else {
    next.push({
      id: String(item.id || `spoken-${start}`),
      start,
      end,
      text: captionTextFromWords(inserted),
      words: inserted,
      trackId: "caption",
    });
    next.sort((left, right) => Number(left.start || 0) - Number(right.start || 0));
  }
  return {
    captions: next,
    merged: true,
    text: spoken,
    start,
    end,
    targetId: target?.id || "",
  };
}

export function applyKeptSpokenToCaptions(captions = [], items = []) {
  let next = cloneCaptions(captions);
  const applied = [];
  const sorted = [...(items || [])].sort(
    (left, right) => Number(left.start || 0) - Number(right.start || 0),
  );
  for (const item of sorted) {
    const result = mergeSpokenIntoCaptions(next, item);
    next = result.captions;
    if (result.merged) {
      applied.push({
        id: String(item.id || ""),
        type: String(item.type || "extra"),
        spoken: result.text,
        start: result.start,
        end: result.end,
      });
    }
  }
  return { captions: next, applied };
}

export function applyCaptionPolish(captions = [], keepSpoken = [], issues = []) {
  const merged = applyKeptSpokenToCaptions(captions, keepSpoken);
  const cleaned = stripCaptionNotes(merged.captions, issues);
  return {
    captions: cleaned.captions,
    mergedSpoken: merged.applied,
    strippedNotes: cleaned.stripped,
  };
}
