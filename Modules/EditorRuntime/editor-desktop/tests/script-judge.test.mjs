import assert from "node:assert/strict";
import test from "node:test";
import {
  applyJudgeDecisions,
  blockingScriptureIssues,
  buildReviewCompareRecord,
  formatReviewCompareText,
  inferKeepable,
  looksLikeSamePoint,
  parseJudgeResponse,
} from "../src/script-judge.mjs";

test("judge JSON keeps ASR glitches and cuts real rereads", () => {
  const decisions = parseJudgeResponse(`
    here you go
    {"decisions":[
      {"id":"a","decision":"keep","reason":"Tthe is The"},
      {"id":"b","decision":"CUT","reason":"repeated the sentence"},
      {"id":"c","decision":"skip"}
    ]}
  `);
  assert.deepEqual(
    decisions.map((item) => item.decision),
    ["keep", "cut"],
  );
});

test("keep only hides a false red and never rewrites alignment operations", () => {
  const spoken = { display: "Tthe", norm: "tthe", start: 5.0, end: 5.2 };
  const extra = { type: "extra", spoken, expected: null, issueId: "a", action: "cut" };
  const missing = {
    type: "missing",
    spoken: null,
    expected: { display: "The", norm: "the", start: 5.0, end: 5.2 },
    issueId: "a",
    action: "missing",
  };
  const aligned = {
    operations: [extra, missing],
    issues: [
      {
        id: "a",
        type: "mismatch",
        spokenText: "Tthe",
        expectedText: "The",
        confirmedCut: true,
        action: "cut",
      },
    ],
  };
  const summary = applyJudgeDecisions(aligned, [
    { id: "a", decision: "keep", reason: "ASR doubled T" },
  ]);
  assert.equal(summary.keep, 1);
  assert.equal(aligned.issues[0].suppressReview, true);
  assert.equal(aligned.issues[0].confirmedCut, false);
  assert.equal(extra.type, "extra");
  assert.equal(extra.expected, null);
  assert.equal(missing.spoken, null);
});

test("cut can only confirm an already cuttable issue", () => {
  const aligned = {
    operations: [{ type: "match" }],
    issues: [
      {
        id: "b",
        type: "extra",
        spokenText: "wait wait let me start over",
        expectedText: "—",
        confirmedCut: false,
      },
      {
        id: "c",
        type: "addition",
        spokenText: "you know",
        expectedText: "—",
        confirmedCut: false,
        action: "insert",
      },
    ],
  };
  applyJudgeDecisions(aligned, [
    { id: "b", decision: "cut", reason: "restart" },
    { id: "c", decision: "cut", reason: "should not upgrade a keepable addition" },
  ], "natural");
  assert.equal(aligned.issues[0].confirmedCut, true);
  assert.equal(aligned.issues[0].action, "cut");
  assert.equal(aligned.issues[1].confirmedCut, false);
  assert.equal(aligned.issues[1].action, "insert");
  assert.equal(aligned.operations[0].type, "match");
});

test("strict mode can mark off-script additions for cutting", () => {
  const aligned = {
    operations: [{ type: "match" }],
    issues: [
      {
        id: "c",
        type: "addition",
        spokenText: "anyway let me tell you a long story",
        expectedText: "—",
        confirmedCut: false,
        action: "insert",
      },
    ],
  };
  applyJudgeDecisions(aligned, [{ id: "c", decision: "cut", reason: "tangent" }], "strict");
  assert.equal(aligned.issues[0].confirmedCut, true);
  assert.equal(aligned.issues[0].action, "cut");
  assert.equal(aligned.operations[0].type, "match");
});

test("This wasn't an accident matches That thought wasn't an accident", () => {
  assert.equal(
    looksLikeSamePoint("This wasn't an accident.", "That thought wasn't an accident."),
    true,
  );
  assert.equal(
    inferKeepable({
      type: "extra",
      spokenText: "This wasn't an accident.",
      expectedText: "That thought wasn't an accident.",
    }, "natural"),
    true,
  );
});

test("Are you guilty of any is the same point as Are You Guilty", () => {
  assert.equal(looksLikeSamePoint("Are you guilty of any", "Are You Guilty?"), true);
  assert.equal(
    looksLikeSamePoint("Are you guilty of any of", "God Hates These 3 Sins—Are You Guilty?"),
    true,
  );
  assert.equal(
    inferKeepable({
      type: "extra",
      spokenText: "Are you guilty of any",
      expectedText: "Are You Guilty?",
    }, "natural"),
    true,
  );
});

test("natural mode keeps a spoken title expansion even without an AI id", () => {
  const aligned = {
    operations: [
      {
        type: "match",
        expected: { display: "Are", start: 1.0, end: 1.1 },
        spoken: { display: "Are", start: 1.0, end: 1.1 },
      },
      {
        type: "match",
        expected: { display: "You", start: 1.1, end: 1.2 },
        spoken: { display: "You", start: 1.1, end: 1.2 },
      },
      {
        type: "match",
        expected: { display: "Guilty", start: 1.2, end: 1.4 },
        spoken: { display: "Guilty", start: 1.2, end: 1.4 },
      },
    ],
    issues: [
      {
        id: "expand",
        type: "extra",
        spokenText: "Are you guilty of any",
        expectedText: "—",
        start: 1.0,
        end: 1.8,
        confirmedCut: true,
        action: "cut",
      },
    ],
  };
  applyJudgeDecisions(aligned, [], "natural");
  assert.equal(aligned.issues[0].suppressReview, true);
  assert.equal(aligned.issues[0].action, "keep");
});

test("wrong scripture stays blocking and cannot be kept as a paraphrase", () => {
  const aligned = {
    operations: [],
    issues: [
      {
        id: "verse",
        type: "mismatch",
        scripture: true,
        strict: true,
        spokenText: "God kinda dislikes this",
        expectedText: "Lying lips are abomination to the LORD",
        confirmedError: false,
      },
    ],
  };
  applyJudgeDecisions(aligned, [{ id: "verse", decision: "keep", reason: "close enough" }], "natural");
  assert.equal(aligned.issues[0].suppressReview, false);
  assert.equal(aligned.issues[0].confirmedError, true);
  assert.equal(blockingScriptureIssues(aligned.issues).length, 1);
});

test("natural mode cuts a reread when the model does not keep it", () => {
  const aligned = {
    operations: [],
    issues: [
      {
        id: "echo",
        type: "repeat",
        spokenText: "to you",
        expectedText: "—",
        confirmedCut: true,
        action: "cut",
      },
    ],
  };
  const summary = applyJudgeDecisions(aligned, [], "natural");
  assert.equal(summary.cut, 1);
  assert.equal(aligned.issues[0].confirmedCut, true);
  assert.equal(aligned.issues[0].action, "cut");
  assert.equal(aligned.issues[0].suppressReview, false);
});

test("natural mode can keep a reread if the model says keep", () => {
  const aligned = {
    operations: [],
    issues: [
      {
        id: "echo",
        type: "repeat",
        spokenText: "to you",
        expectedText: "—",
        confirmedCut: true,
        action: "cut",
      },
    ],
  };
  applyJudgeDecisions(aligned, [{ id: "echo", decision: "keep", reason: "intentional" }], "natural");
  assert.equal(aligned.issues[0].action, "keep");
  assert.equal(aligned.issues[0].confirmedCut, false);
  assert.equal(aligned.issues[0].suppressReview, true);
});

test("missing model ids leave the original alignment untouched", () => {
  const aligned = {
    operations: [{ type: "mismatch" }],
    issues: [{ id: "z", type: "mismatch", confirmedCut: false, action: "cut" }],
  };
  applyJudgeDecisions(aligned, []);
  assert.equal(aligned.issues[0].suppressReview, undefined);
  assert.equal(aligned.issues[0].confirmedCut, false);
  assert.equal(aligned.operations[0].type, "mismatch");
});

test("review compare log lists each issue decision for Vertex vs Antigravity", () => {
  const record = buildReviewCompareRecord({
    mode: "natural",
    issues: [
      { id: "a", type: "repeat", spokenText: "to you to you", expectedText: "to you", action: "cut" },
      { id: "b", type: "extra", spokenText: "you know", expectedText: "", action: "keep", suppressReview: true },
    ],
    decisions: [
      { id: "a", decision: "cut", reason: "reread" },
      { id: "b", decision: "keep", reason: "filler" },
    ],
    summary: { keep: 1, cut: 1, missing: 0, unsure: 0 },
  });
  const text = formatReviewCompareText(record, "logs/review-compare.jsonl");
  assert.equal(record.parsedCount, 2);
  assert.match(text, /keep=1/);
  assert.match(text, /cut=1/);
  assert.match(text, /to you to you/);
  assert.match(text, /\treread/);
});
