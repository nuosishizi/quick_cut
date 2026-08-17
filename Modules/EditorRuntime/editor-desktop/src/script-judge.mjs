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
The finished video should follow the manuscript meaning, but short natural speech may stay.
Captions already use the manuscript. You only decide which spoken spans stay.

Choose one decision per item:
- keep: ASR glitch (The/Tthe, dropped leading T), same meaning, filler, a title/question expansion such as "Are You Guilty?" → "Are you guilty of any...", or a short helpful aside.
- cut: a clear reread/restart/self-correction (type=repeat, including a repeated ending such as "to you, to you"), a long off-topic tangent, or a meaning change of 3+ words. Prefer the later clean take. Rereads must be cut.
- missing: manuscript phrase was not spoken. Do not cut.
- unsure: leave the original mark.

Default to keep for ordinary extras. Never keep a reread just because it is short.
Return JSON only: {"decisions":[{"id":"...","decision":"keep","reason":"..."}]}`,
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
      issue.suppressReview = false;
      if (issue.type === "missing") issue.action = "missing";
      else if (issue.type !== "repeat") {
        issue.action = "cut";
        issue.label = "经文不符，需重录";
      }
      issue.aiDecision = judged?.decision || "scripture";
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
    if (decision === "unsure" && issue.type === "repeat") decision = "cut";
    issue.aiDecision = decision;
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
Scripture and quoted Word of God (items with scripture=true) are NEVER optional.
Do not mark them keep unless the spoken text is clearly the same words with only an ASR typo.
Wrong, missing, or paraphrased scripture must be missing or cut and must block export.`;
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
