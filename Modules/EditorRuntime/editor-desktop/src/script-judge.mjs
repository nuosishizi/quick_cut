const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_JUDGE_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];
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
- cut: only a clear reread/restart, a long off-topic tangent, or a meaning change of 3+ words. Prefer the later clean take.
- missing: manuscript phrase was not spoken. Do not cut.
- unsure: leave the original mark.

Default to keep or unsure. Use cut rarely.
Return JSON only: {"decisions":[{"id":"...","decision":"keep","reason":"..."}]}`,
};

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
  return coverage >= 0.66 && spokenWords.length <= expectedWords.length + 6;
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
    const inferredKeep = inferKeepable(issue, reviewMode, aligned.operations || []);
    if (!judged) {
      if (inferredKeep) {
        summary.keep += 1;
        issue.aiDecision = "keep";
        issue.aiMode = reviewMode;
        applyKeep(issue, "local same-point keep");
      }
      continue;
    }
    let decision = judged.decision;
    if ((decision === "unsure" || (decision === "cut" && inferredKeep && reviewMode === "natural")) && inferredKeep)
      decision = "keep";
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

function judgeHttpError(status, body) {
  let message = "";
  try {
    message = String(JSON.parse(body)?.error?.message || "").trim();
  } catch {
    message = String(body || "").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  if (status === 401 || status === 403)
    return new Error("Groq API Key 无效，无法做 AI 校对。");
  if (status === 429) return new Error("Groq 请求过于频繁，已跳过 AI 校对。");
  return new Error(message || `Groq 校对失败（${status}）。`);
}

async function completeJudge(key, userPrompt, signal, mode = "natural") {
  let lastError = new Error("没有可用的 Groq 校对模型。");
  const system = MODE_PROMPTS[normalizeReviewMode(mode)];
  for (const model of GROQ_JUDGE_MODELS) {
    const response = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
      }),
      signal,
    });
    const body = await response.text();
    if (response.ok) {
      const data = JSON.parse(body);
      const text = data?.choices?.[0]?.message?.content || "";
      return parseJudgeResponse(text);
    }
    lastError = judgeHttpError(response.status, body);
    if (response.status !== 400 && response.status !== 404) throw lastError;
  }
  throw lastError;
}

export async function judgeAlignmentIssues({
  apiKey,
  script,
  issues = [],
  operations = [],
  signal = null,
  mode = "natural",
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key || !issues.length) return [];
  const reviewMode = normalizeReviewMode(mode);
  const decisions = [];
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
    decisions.push(...(await completeJudge(key, userPrompt, signal, reviewMode)));
  }
  return decisions;
}
