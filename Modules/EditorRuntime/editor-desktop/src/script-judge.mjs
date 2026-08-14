const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_JUDGE_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];
const MAX_BATCH = 24;

const SYSTEM_PROMPT = `You review English voiceover differences. You do not edit the timeline.
ASR often misspells, doubles letters, or splits one spoken word (The→Tthe, Bible→Byble).

Choose one decision per item:
- keep: ASR glitch, same meaning, filler, or 1–2 word paraphrase. Hide the red mark.
- cut: only a clear reread, restart, off-script tangent, or meaning change of 3+ words.
- missing: manuscript phrase was not spoken. Do not cut.
- unsure: leave the original software mark unchanged.

Default to keep or unsure. Use cut rarely.
Return JSON only: {"decisions":[{"id":"...","decision":"keep","reason":"..."}]}`;

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

const CUTTABLE = new Set(["extra", "repeat", "mismatch"]);

export function applyJudgeDecisions(aligned, decisions = []) {
  const byId = new Map(decisions.map((item) => [item.id, item]));
  const summary = { keep: 0, cut: 0, missing: 0, unsure: 0 };
  for (const issue of aligned.issues || []) {
    const judged = byId.get(issue.id);
    if (!judged) continue;
    const decision = judged.decision;
    issue.aiDecision = decision;
    issue.aiReason = judged.reason || "";
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
    if (decision === "cut" && CUTTABLE.has(issue.type)) {
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

async function completeJudge(key, userPrompt, signal) {
  let lastError = new Error("没有可用的 Groq 校对模型。");
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
          { role: "system", content: SYSTEM_PROMPT },
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
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key || !issues.length) return [];
  const decisions = [];
  for (let offset = 0; offset < issues.length; offset += MAX_BATCH) {
    if (signal?.aborted) throw new Error("cancelled");
    const batch = issues.slice(offset, offset + MAX_BATCH);
    const payload = batch.map((issue) => issueJudgePayload(issue, operations));
    const userPrompt = [
      "Manuscript:",
      String(script || "").trim().slice(0, 6000),
      "",
      "Differences:",
      JSON.stringify(payload, null, 2),
    ].join("\n");
    decisions.push(...(await completeJudge(key, userPrompt, signal)));
  }
  return decisions;
}
