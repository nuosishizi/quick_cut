import assert from "node:assert/strict";
import test from "node:test";
import {
  applyJudgeDecisions,
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
