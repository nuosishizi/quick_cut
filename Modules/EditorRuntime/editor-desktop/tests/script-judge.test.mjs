import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCaptionPolish,
  applyJudgeDecisions,
  blockingScriptureIssues,
  buildGlobalPolishPlan,
  buildReviewCompareRecord,
  formatGlobalPolishSummary,
  formatReviewCompareText,
  inferKeepable,
  isProductionTag,
  isScriptureHeadingText,
  isStageDirectionNote,
  looksLikeSamePoint,
  mergeSpokenIntoCaptions,
  parseJudgeResponse,
  shouldMergeSpoken,
  stripCaptionNotes,
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

test("an unsure reread stays visible for human review and is never auto-cut", () => {
  const aligned = {
    operations: [],
    issues: [
      {
        id: "pause-or-reread",
        type: "repeat",
        spokenText: "standing with the Lamb",
        expectedText: "standing with the Lamb",
        confirmedCut: true,
        action: "cut",
      },
    ],
  };
  const summary = applyJudgeDecisions(aligned, [
    {
      id: "pause-or-reread",
      decision: "unsure",
      confidence: "low",
      reason: "segmentation may have created a false restart",
    },
  ], "natural");
  assert.equal(summary.unsure, 1);
  assert.equal(aligned.issues[0].confirmedCut, false);
  assert.equal(aligned.issues[0].action, "unsure");
  assert.equal(aligned.issues[0].suppressReview, false);
  assert.equal(aligned.issues[0].aiConfidence, "low");
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

test("global polish never auto-cuts scripture or the Word of God", () => {
  const plan = buildGlobalPolishPlan([
    {
      id: "s",
      type: "mismatch",
      scripture: true,
      action: "cut",
      confirmedCut: true,
      spokenText: "and we can",
      expectedText: "I'll personally make sure you",
    },
    {
      id: "r",
      type: "repeat",
      confirmedCut: true,
      action: "cut",
      spokenText: "to you",
    },
    {
      id: "k",
      type: "extra",
      action: "keep",
      suppressReview: true,
      spokenText: "you know",
    },
    {
      id: "m",
      type: "missing",
      action: "missing",
      expectedText: "Are You Guilty?",
    },
  ]);
  assert.deepEqual(
    plan.scriptureLock.map((item) => item.id),
    ["s"],
  );
  assert.deepEqual(
    plan.autoCut.map((item) => item.id),
    ["r"],
  );
  assert.equal(plan.keepSpoken.length, 1);
  assert.equal(plan.missing.length, 1);
  assert.match(formatGlobalPolishSummary(plan, 1), /经文请你点/);
  assert.match(formatGlobalPolishSummary({ ...plan, mergedSpoken: [{}], strippedNotes: [{}] }, 1), /口语并进 1 条/);
  assert.match(formatGlobalPolishSummary({ ...plan, mergedSpoken: [{}], strippedNotes: [{}] }, 1), /清掉 1 处备注/);
});

function caption(id, start, end, text, words) {
  return {
    id,
    start,
    end,
    text,
    words: words || text.split(/\s+/).map((display, index, all) => ({
      display,
      start: start + ((end - start) * index) / all.length,
      end: start + ((end - start) * (index + 1)) / all.length,
      matchType: "match",
    })),
  };
}

test("stage notes and unmatched chapter headings leave finished captions", () => {
  assert.equal(isStageDirectionNote("(pause)"), true);
  assert.equal(isStageDirectionNote("[look at camera]"), true);
  assert.equal(isStageDirectionNote("（停顿）"), true);
  assert.equal(isStageDirectionNote("These six things"), false);
  assert.equal(isProductionTag("([CTA])"), true);
  assert.equal(isProductionTag("[CTA]"), true);
  assert.equal(isProductionTag("CTA"), true);
  assert.equal(isStageDirectionNote("([CTA])"), true);
  assert.equal(isStageDirectionNote("point one"), false);
  assert.equal(isScriptureHeadingText("Proverbs 6:16-19"), true);
  assert.equal(isScriptureHeadingText("Psalm 139:23"), true);
  assert.equal(isScriptureHeadingText("Search me, O God"), false);

  const result = stripCaptionNotes([
    caption("cta", 0, 0.3, "([CTA])", [
      { display: "([CTA])", start: 0, end: 0.3, matchType: "match" },
    ]),
    caption("a", 0.3, 0.6, "(pause)", [
      { display: "(pause)", start: 0.3, end: 0.6, matchType: "error" },
    ]),
    caption("b", 0.5, 1.2, "Proverbs 6:16", [
      { display: "Proverbs", start: 0.5, end: 0.8, matchType: "error" },
      { display: "6:16", start: 0.8, end: 1.2, matchType: "error" },
    ]),
    caption("c", 1.3, 3, "These six things doth the LORD hate."),
    caption("d", 3.1, 4, "Psalm 139:23", [
      { display: "Psalm", start: 3.1, end: 3.4, matchType: "match" },
      { display: "139:23", start: 3.4, end: 4, matchType: "match", scriptureReference: true },
    ]),
    caption("e", 4.1, 6, '"Search me, O God, and know my heart"', [
      { display: '"Search', start: 4.1, end: 4.4, matchType: "match", scripture: true, strict: true },
      { display: "me,", start: 4.4, end: 4.6, matchType: "match", scripture: true, strict: true },
      { display: "O", start: 4.6, end: 4.7, matchType: "match", scripture: true, strict: true },
      { display: "God,", start: 4.7, end: 5.1, matchType: "match", scripture: true, strict: true },
      { display: "and", start: 5.1, end: 5.3, matchType: "match", scripture: true, strict: true },
      { display: "know", start: 5.3, end: 5.5, matchType: "match", scripture: true, strict: true },
      { display: "my", start: 5.5, end: 5.7, matchType: "match", scripture: true, strict: true },
      { display: "heart\"", start: 5.7, end: 6, matchType: "match", scripture: true, strict: true },
    ]),
    caption("f", 6.1, 8, "These six things (pause) doth the LORD hate.", [
      { display: "These", start: 6.1, end: 6.3, matchType: "match" },
      { display: "six", start: 6.3, end: 6.5, matchType: "match" },
      { display: "things", start: 6.5, end: 6.8, matchType: "match" },
      { display: "(pause)", start: 6.8, end: 7.1, matchType: "error" },
      { display: "doth", start: 7.1, end: 7.3, matchType: "match" },
      { display: "the", start: 7.3, end: 7.5, matchType: "match" },
      { display: "LORD", start: 7.5, end: 7.7, matchType: "match" },
      { display: "hate.", start: 7.7, end: 8, matchType: "match" },
    ]),
  ]);
  const texts = result.captions.map((item) => item.text);
  assert.equal(texts.some((text) => /CTA/i.test(text)), false);
  assert.equal(texts.some((text) => /\(pause\)/i.test(text)), false);
  assert.equal(texts.some((text) => /Proverbs 6:16/i.test(text)), false);
  assert.ok(texts.some((text) => /These six things doth the LORD hate/i.test(text)));
  assert.ok(texts.some((text) => /Psalm 139:23/i.test(text)));
  assert.ok(texts.some((text) => /Search me, O God/i.test(text)));
  assert.ok(result.stripped.some((item) => item.type === "heading"));
  assert.ok(result.stripped.some((item) => item.type === "note"));
});

test("locked scripture captions are never stripped as notes", () => {
  const result = stripCaptionNotes(
    [
      caption("s", 1, 2, "Psalm 23:1", [
        { display: "Psalm", start: 1, end: 1.4, matchType: "error" },
        { display: "23:1", start: 1.4, end: 2, matchType: "error" },
      ]),
    ],
    [{ id: "s", scripture: true, strict: true, type: "missing", start: 0.9, end: 2.1 }],
  );
  assert.equal(result.captions.length, 1);
  assert.match(result.captions[0].text, /Psalm 23:1/);
  assert.equal(result.stripped.length, 0);
});

test("kept spoken asides merge into nearby green captions and skip scripture or ASR typos", () => {
  assert.equal(shouldMergeSpoken({ type: "extra", spokenText: "you know" }), true);
  assert.equal(shouldMergeSpoken({ type: "extra", spokenText: "number one" }), false);
  assert.equal(shouldMergeSpoken({ type: "extra", spokenText: "point one" }), false);
  assert.equal(
    shouldMergeSpoken({ type: "mismatch", spokenText: "Tthe", expectedText: "The" }),
    false,
  );
  assert.equal(
    shouldMergeSpoken({ type: "extra", scripture: true, spokenText: "and we can" }),
    false,
  );
  assert.equal(
    shouldMergeSpoken({ type: "repeat", spokenText: "to you", action: "keep" }),
    false,
  );

  const merged = mergeSpokenIntoCaptions(
    [caption("c", 1, 2.2, "Faith remains today.")],
    { id: "k", type: "extra", spokenText: "you know", start: 2.05, end: 2.35 },
  );
  assert.equal(merged.merged, true);
  assert.match(merged.captions[0].text, /you know/i);
  assert.ok(merged.captions[0].words.some((word) => word.userInserted));

  const duplicate = mergeSpokenIntoCaptions(merged.captions, {
    id: "k2",
    type: "extra",
    spokenText: "you know",
    start: 2.05,
    end: 2.35,
  });
  assert.equal(duplicate.merged, false);
  assert.equal(duplicate.alreadyPresent, true);
});

test("wrong list-item takes are not written onto green captions", () => {
  const polished = applyCaptionPolish(
    [caption("c", 1, 3, "Point one: God hates these sins.")],
    [{ id: "n", type: "extra", spokenText: "number one", start: 0, end: 0.7, action: "keep" }],
    [],
  );
  const texts = polished.captions.map((item) => item.text).join(" ");
  assert.match(texts, /Point one/i);
  assert.doesNotMatch(texts, /number one/i);
  assert.equal(polished.mergedSpoken.length, 0);
});

test("caption polish merges spoken extras then strips notes without touching scripture", () => {
  const polished = applyCaptionPolish(
    [
      caption("n", 0, 0.3, "(pause)", [
        { display: "(pause)", start: 0, end: 0.3, matchType: "error" },
      ]),
      caption("c", 1, 2, "Faith remains."),
      caption("s", 3, 5, '"Search me, O God"', [
        { display: '"Search', start: 3, end: 3.4, matchType: "match", scripture: true, strict: true },
        { display: "me,", start: 3.4, end: 3.7, matchType: "match", scripture: true, strict: true },
        { display: "O", start: 3.7, end: 3.9, matchType: "match", scripture: true, strict: true },
        { display: 'God"', start: 3.9, end: 5, matchType: "match", scripture: true, strict: true },
      ]),
    ],
    [
      { id: "k", type: "extra", spokenText: "you know", start: 1.8, end: 2.1, action: "keep" },
      { id: "holy", type: "extra", spokenText: "and we can", start: 4, end: 4.4, scripture: true },
    ],
    [{ id: "holy", scripture: true, type: "mismatch", start: 3, end: 5 }],
  );
  const texts = polished.captions.map((item) => item.text).join(" | ");
  assert.match(texts, /Faith remains/);
  assert.match(texts, /you know/i);
  assert.match(texts, /Search me, O God/);
  assert.doesNotMatch(texts, /\(pause\)/i);
  assert.doesNotMatch(texts, /and we can/i);
  assert.equal(polished.mergedSpoken.length, 1);
  assert.equal(polished.strippedNotes.length, 1);
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
