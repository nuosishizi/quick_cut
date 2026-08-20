import assert from "node:assert/strict";
import test from "node:test";
import {
  alignScript,
  buildCaptions,
  buildReviewCaptions,
  endsCaptionSentence,
  flattenCaptionWords,
  looksLikeAbandonedPrefix,
  manuscriptCaptionWords,
  regroupCaptions,
  regroupProjectCaptions,
  spokenCaptionWords,
} from "../src/alignment.mjs";
import { packWordsIntoLines } from "../src/text-layout.mjs";
import {
  normalizeTranscriptTimebase,
  recoverIncompleteSegments,
  stitchTranscriptSegments,
} from "../src/whisper.mjs";

const textOf = (operations) =>
  spokenCaptionWords(operations)
    .map((word) => word.display)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([\-–—])\s+(?=\d)/g, "$1");

test("number one before point one is an abandoned false start, not a second caption", () => {
  assert.equal(looksLikeAbandonedPrefix("number one", "point one God hates these sins"), true);
  assert.equal(looksLikeAbandonedPrefix("point one", "point one God hates these sins"), true);
  assert.equal(looksLikeAbandonedPrefix("you know", "point one God hates these sins"), false);
  const aligned = alignScript({
    segments: [
      { text: "number one", start: 0, end: 0.7 },
      { text: "point one God hates these sins", start: 1.1, end: 4.2 },
    ],
    script: "Point one: God hates these sins.",
    duration: 5,
  });
  const reread = aligned.issues.find(
    (issue) =>
      issue.type === "repeat" ||
      issue.abandonedPrefix ||
      /number one/i.test(String(issue.spokenText || "")),
  );
  assert.ok(reread, "the wrong number one take should be marked");
  assert.equal(reread.confirmedCut, true);
  const captions = buildCaptions(manuscriptCaptionWords(aligned), { maxWords: 10, maxChars: 40 });
  const texts = captions.map((caption) => caption.text).join(" ");
  assert.match(texts, /Point one/i);
  assert.doesNotMatch(texts, /number one/i);
});

test("main captions use the exact manuscript and harmless connectors do not create gaps", () => {
  const script = "Not every prayer gets a yes from God, because His answer can be wait.";
  const aligned = alignScript({
    segments: [{
      text: "Not every prayer but gets a yes from God because his answer can be wait",
      start: 0,
      end: 6,
    }],
    script,
    duration: 6,
  });
  assert.equal(aligned.issues.length, 0);
  assert.equal(buildReviewCaptions(aligned.issues, aligned.expected, 6).length, 0);
  assert.equal(textOf(aligned.operations), script);
  assert.ok(!textOf(aligned.operations).includes("but"));
});

test("spoken Bible references and large numbers normalize without a false reread or caption gap", () => {
  const script = "Revelation 14:1 also speaks of 144,000 standing with the Lamb.";
  const spoken = "revelation fourteen one also speaks about the one hundred and forty four thousand standing with the lamb".split(" ");
  let time = 0;
  const segments = spoken.map((text) => {
    if (text === "standing") time += 0.36;
    const start = time;
    const end = start + 0.22;
    time = end;
    return { text, start, end };
  });
  const aligned = alignScript({ segments, script, duration: time });
  assert.equal(aligned.issues.length, 0);
  assert.ok(aligned.expected.some((word) => word.norm === "144000"));
  assert.ok(aligned.spoken.some((word) => word.norm === "144000"));
  const captions = buildCaptions(manuscriptCaptionWords(aligned), {
    maxWords: 7,
    maxChars: 80,
    maxLines: 2,
  });
  assert.equal(captions.map((caption) => caption.text).join(" "), script);
  assert.equal(captions.length, 2);
  assert.equal(captions[1].start - captions[0].end, 0);
});

test("one wrong phrase becomes one exact delete gap and later words re-anchor", () => {
  const script =
    "Two signs you stop and you do not brush them aside. The Lord welcomes every honest prayer and gives wisdom.";
  const aligned = alignScript({
    segments: [{
      text: "Two signs you stop completely wrong repeated phrase and you do not brush them aside the Lord welcomes every honest prayer and gives wisdom",
      start: 0,
      end: 12,
    }],
    script,
    duration: 12,
  });
  const later = spokenCaptionWords(aligned.operations)
    .filter((word) => word.start > 5)
    .map((word) => word.display)
    .join(" ");
  assert.match(later, /The Lord welcomes every honest prayer and gives wisdom\./);
  assert.equal(aligned.issues.length, 1);
  assert.match(aligned.issues[0].spokenText, /completely wrong repeated phrase/i);
  const review = buildReviewCaptions(aligned.issues, aligned.expected, 12);
  assert.equal(review.length, 1);
  assert.match(review[0].text, /completely wrong repeated phrase/i);
  assert.equal(review[0].action, "cut");
  assert.ok(review[0].end - review[0].start < 4);
});

test("a mid-sentence timestamp hole without repeated content is only a pause", () => {
  const script = "We're treating as ordinary something He calls holy.";
  const aligned = alignScript({
    segments: [
      { text: "We're treating", start: 0, end: 0.6 },
      { text: "as ordinary something He calls holy", start: 2.1, end: 4.4 },
    ],
    script,
    duration: 5,
  });
  assert.equal(aligned.issues.some((issue) => issue.type === "repeat"), false);
  const review = buildReviewCaptions(aligned.issues, aligned.expected, 5);
  assert.equal(review.length, 0);
  const captions = buildCaptions(manuscriptCaptionWords(aligned), { maxWords: 10, maxChars: 40 });
  assert.equal(captions.map((caption) => caption.text).join(" "), script);
});

test("reread with stumble words (Save this for the next time he's ... Save this for the time He feels silent) is cut and captions match the complete take", () => {
  const script = 'Comment: "Lord, make me." "Save this for the time He feels silent."';
  const aligned = alignScript({
    segments: [
      { text: "Comment: Lord, make me.", start: 218.0, end: 219.5 },
      { text: "Save this for the next time he's", start: 219.8, end: 221.5 },
      { text: "Save this for the time He feels silent.", start: 222.5, end: 224.5 },
    ],
    script,
    duration: 230,
  });
  const reread = aligned.issues.find(
    (issue) => issue.type === "repeat" && /Save this for the next time he/i.test(issue.spokenText)
  );
  assert.ok(reread, "should find repeat issue for the abandoned take");
  assert.equal(reread.confirmedCut, true);
  const captions = buildCaptions(manuscriptCaptionWords(aligned), { maxWords: 10, maxChars: 40 });
  const completeCaption = captions.find((c) => /Save this for the/i.test(c.text));
  assert.ok(completeCaption, "should produce full caption for the complete second take");
  assert.ok(completeCaption.start >= 222.0, "complete caption must be anchored to the second take");
});

test("reread with incomplete first take and stutter in second take (Every prayer was bless ... me Every prayer every prayer was blessed) picks the complete second take", () => {
  const script = '"Every prayer was blessed — my family, my career, my marriage."';
  const aligned = alignScript({
    segments: [
      { text: "Every prayer was bless", start: 72.5, end: 74.0 },
      { text: "me. Every prayer every prayer was blessed", start: 74.5, end: 77.5 },
      { text: "my family, my career, my marriage.", start: 78.0, end: 81.0 },
    ],
    script,
    duration: 85,
  });
  const reread = aligned.issues.find(
    (issue) => issue.type === "repeat" || /Every prayer was bless/i.test(issue.spokenText)
  );
  assert.ok(reread, "should find repeat issue for the incomplete first take");
  assert.equal(reread.confirmedCut, true);
  const captions = buildCaptions(manuscriptCaptionWords(aligned), { maxWords: 10, maxChars: 40 });
  const completeCaption = captions.find((c) => /Every prayer was blessed/i.test(c.text));
  assert.ok(completeCaption, "should produce full caption for the complete second take");
  assert.ok(completeCaption.start >= 74.0, "complete caption must be anchored to the second take");
});

test("spoken chapter expansion with restart (Psalms one thirty five ... Psalms one thirty nine verse 23) protects Psalm 139:23 and O God", () => {
  const script = 'Psalm 139:23 — "Search me, O God, and know my heart"';
  const aligned = alignScript({
    segments: [
      { text: "Psalms one thirty five", start: 85.2, end: 86.4 },
      { text: "Psalms one thirty nine verse 23 says", start: 86.6, end: 88.7 },
      { text: "search me, oh God, and know my heart", start: 89.0, end: 91.5 },
    ],
    script,
    duration: 95,
  });
  const captions = buildCaptions(manuscriptCaptionWords(aligned), { maxWords: 10, maxChars: 40 });
  assert.ok(captions.some((c) => /Psalm 139:23/i.test(c.text)), "Psalm 139:23 must be fully preserved with number 139");
  assert.ok(captions.some((c) => /Search me, O God/i.test(c.text)), "Search me, O God must match spoken oh God");
});

test("a breath after Here does not count as a reread and keeps the sentence together", () => {
  const script = "Here are the three sins.";
  const aligned = alignScript({
    segments: [
      { text: "Here", start: 0, end: 0.35 },
      { text: "are the three sins", start: 1.15, end: 2.4 },
    ],
    script,
    duration: 3,
  });
  assert.equal(aligned.issues.some((issue) => issue.falseStartGap || issue.label === "没读完又重来"), false);
  const captions = buildCaptions(manuscriptCaptionWords(aligned), { maxWords: 10, maxChars: 40 });
  assert.ok(captions.some((caption) => /Here are the three sins/i.test(caption.text)));
});

test("a breath after Not does not split Not just a mistake", () => {
  const script = "Not just a mistake.";
  const aligned = alignScript({
    segments: [
      { text: "Not", start: 0, end: 0.28 },
      { text: "just a mistake", start: 1.05, end: 2.1 },
    ],
    script,
    duration: 3,
  });
  assert.equal(aligned.issues.some((issue) => issue.falseStartGap), false);
  const captions = buildCaptions(manuscriptCaptionWords(aligned), { maxWords: 10, maxChars: 40 });
  assert.ok(captions.some((caption) => /Not just a mistake/i.test(caption.text)));
});

test("abandoned prefix reread is cut and captions stay on the complete take", () => {
  const script =
    "We're not just breaking God's standards. We're treating as ordinary something He calls holy.";
  const aligned = alignScript({
    segments: [
      { text: "We're not just breaking God's standards.", start: 160.0, end: 160.7 },
      { text: "we're treating it", start: 161.733, end: 162.55 },
      { text: "We're treating as ordinary something He calls holy.", start: 163.425, end: 167.0 },
    ],
    script,
    duration: 170,
  });
  const reread = aligned.issues.find(
    (issue) =>
      issue.abandonedPrefix ||
      issue.label === "没读完又重来" ||
      /treating it/i.test(String(issue.spokenText || "")),
  );
  assert.ok(reread, "the incomplete first take should be marked");
  assert.equal(reread.confirmedCut, true);
  assert.ok(reread.start >= 161.5, `red started too early: ${reread.start}`);
  assert.ok(reread.start <= 161.9, `red started too late: ${reread.start}`);
  assert.ok(reread.end >= 162.5, `red should cover the abandoned take: ${reread.end}`);
  assert.ok(reread.end < 163.3, `red must stop before the complete take: ${reread.end}`);
  const captions = buildCaptions(manuscriptCaptionWords(aligned), {
    maxWords: 10,
    maxChars: 40,
  });
  const complete = captions.find((caption) => /ordinary something/i.test(caption.text));
  assert.ok(complete, "the complete sentence should stay on the caption track");
  assert.match(complete.text, /We're treating as ordinary/i);
  assert.ok(
    complete.start >= 163.0,
    `complete caption started too early: ${complete.start}`,
  );
});

test("a trailing to you reread is a cut repeat not a scripture misread", () => {
  const script =
    '"Why I say to you, All manner of sin and blasphemy shall be forgiven to men."';
  const aligned = alignScript({
    segments: [
      { text: "Why I say to you", start: 0, end: 1.4 },
      { text: "to you", start: 1.55, end: 2.1 },
      {
        text: "All manner of sin and blasphemy shall be forgiven to men",
        start: 2.8,
        end: 6.5,
      },
    ],
    script,
    duration: 8,
  });
  const reread = aligned.issues.find(
    (issue) =>
      issue.type === "repeat" || /to you/i.test(String(issue.spokenText || "")),
  );
  assert.ok(reread, "the echoed to you should be marked");
  assert.equal(reread.type, "repeat");
  assert.equal(reread.confirmedCut, true);
  assert.equal(reread.repeatKeepLater, false);
  assert.match(String(reread.spokenText), /to you/i);
  assert.ok(reread.start >= 1.4);
  assert.ok(
    reread.end >= 2.09 && reread.end < 2.2,
    `cut must stop at the repeated phrase instead of consuming the next sentence: ${reread.end}`,
  );
  const captions = buildCaptions(manuscriptCaptionWords(aligned), {
    maxWords: 10,
    maxChars: 40,
  });
  assert.ok(captions.some((caption) => /Why I say to you/i.test(caption.text)));
  const review = buildReviewCaptions(aligned.issues, aligned.expected, 8);
  const clip = review.find((item) => /to you/i.test(item.text || item.spokenText || ""));
  assert.ok(clip);
  assert.equal(clip.action, "cut");
  assert.equal(clip.type, "repeat");
});

test("a partial reread of the previous words is a repeat", () => {
  const aligned = alignScript({
    segments: [{
      text: "We're treating as We're treating as ordinary something He calls holy",
      start: 0,
      end: 5,
    }],
    script: "We're treating as ordinary something He calls holy.",
    duration: 5,
  });
  assert.ok(
    aligned.issues.some(
      (issue) => issue.type === "repeat" || (issue.type === "extra" && issue.confirmedCut),
    ),
  );
});

test("a repeated phrase is removable without turning the rest of the manuscript red", () => {
  const aligned = alignScript({
    segments: [{
      text: "Blessed are they blessed are they which do hunger and thirst after righteousness for they shall be filled",
      start: 0,
      end: 8,
    }],
    script: "Blessed are they which do hunger and thirst after righteousness, for they shall be filled.",
    duration: 8,
  });
  assert.equal(aligned.issues.length, 1);
  assert.equal(aligned.issues[0].type, "repeat");
  assert.match(textOf(aligned.operations), /^Blessed are they which do hunger/);
  assert.match(textOf(aligned.operations), /they shall be filled\.$/);
});

test("isolated ordinary ASR omissions are recovered from the manuscript instead of being treated as proof of a missing spoken word", () => {
  const aligned = alignScript({
    segments: [{ text: "This is the final sentence", start: 0, end: 2 }],
    script: "This is the important final sentence.",
    duration: 2,
  });
  assert.equal(aligned.issues.some((issue) => issue.type === "missing" && issue.expectedText === "important"), false);
  assert.match(textOf(aligned.operations), /important final sentence/);
});

test("Bible chapter and verse, punctuation and sentence breaks stay correct", () => {
  const script =
    "Jesus says in Matthew 24:36 that no one knows the day or hour. Are you ready?";
  const aligned = alignScript({
    segments: [{
      text: "Jesus says in Matthew 24 36 that no one knows the day or hour are you ready",
      start: 0,
      end: 6,
    }],
    script,
    duration: 6,
  });
  assert.equal(aligned.issues.length, 0);
  const captions = buildCaptions(spokenCaptionWords(aligned.operations), {
    maxWords: 4,
    maxChars: 22,
  });
  assert.ok(captions.some((caption) => /Matthew\s+24:36/i.test(caption.text)));
  assert.ok(!captions.some((caption) => /^[:;,.)!?]/.test(caption.text)));
  assert.equal(captions.map((caption) => caption.text).join(" "), script);
});

test("sentence punctuation stays behind and no final word is orphaned into the next sentence", () => {
  const words = [
    ["Something", 0, 0.4],
    ["important", 0.4, 0.8],
    ["is", 0.8, 1.0],
    ["missing.", 1.0, 1.35],
    ["And", 1.42, 1.65],
    ["number", 1.65, 1.95],
    ["three", 1.95, 2.25],
    ["is", 2.25, 2.45],
    ["terrifying.", 2.45, 2.9],
  ].map(([display, start, end]) => ({ display, start, end }));
  const captions = buildCaptions(words, { maxWords: 3, maxChars: 14, maxLines: 2 });
  assert.deepEqual(
    captions.map((caption) => caption.text),
    ["Something important is missing.", "And number three", "is terrifying."],
  );
  assert.ok(!captions.some((caption) => /^\s*[.,!?;:]/.test(caption.text)));
  assert.ok(!captions.some((caption) => caption.words.length === 1));
});

test("caption grouping can switch by punctuation and character limit without rematching", () => {
  const words = [
    ["We're", 0, 0.2],
    ["treating", 0.2, 0.5],
    ["as", 0.5, 0.65],
    ["ordinary", 0.65, 1.0],
    ["something", 1.0, 1.35],
    ["He", 1.35, 1.5],
    ["calls", 1.5, 1.75],
    ["holy.", 1.75, 2.1],
    ["Don't", 2.2, 2.4],
    ["treat", 2.4, 2.65],
    ["it", 2.65, 2.8],
    ["casually.", 2.8, 3.2],
  ].map(([display, start, end]) => ({ display, start, end }));
  const packed = [
    {
      start: 0,
      end: 3.2,
      text: "We're treating as ordinary something He calls holy. Don't treat it casually.",
      words,
    },
  ];
  const one = regroupCaptions(words, { captionLines: 1, lineChars: 18 });
  const two = regroupProjectCaptions(packed, { captionLines: 2, lineChars: 18 });
  const multi = regroupProjectCaptions(two, { captionLines: "multi", lineChars: 18 });
  assert.deepEqual(flattenCaptionWords(one).map((word) => word.display), words.map((word) => word.display));
  assert.ok(one.length > two.length);
  assert.equal(multi.length, 2);
  assert.match(multi[0].text, /holy\.$/);
  assert.match(multi[1].text, /casually\.$/);
  assert.ok(one.every((caption) => caption.text.length <= 18 || /[.!?]$/.test(caption.text) || caption.words.length === 1));
});

test("two-line captions stay within the safe box width and never pack a third line", () => {
  const words = "Lying lips are abomination to the LORD but they that deal truly"
    .split(" ")
    .map((display, index) => ({ display, start: index * 0.2, end: index * 0.2 + 0.18 }));
  const style = { fontFamily: "Helvetica", fontSize: 58, letterSpacing: 0, wordSpacing: 0 };
  const boxWidth = 520;
  const two = regroupCaptions(words, { captionLines: 2, boxWidth, canvasWidth: 1080, style });
  assert.ok(two.length >= 2);
  for (const caption of two) {
    const packed = packWordsIntoLines(caption.words, style, boxWidth, 1);
    assert.ok(packed.length <= 2, `${caption.text} wrapped to ${packed.length} lines`);
    assert.ok((caption.lineCount || packed.length) <= 2);
  }
  assert.deepEqual(
    flattenCaptionWords(two).map((word) => word.display),
    words.map((word) => word.display),
  );
});

test("switching line mode keeps every manuscript word including contractions", () => {
  const words = "The Bible doesn't just say God dislikes these sins."
    .split(/\s+/)
    .map((display, index) => ({ display, start: index * 0.18, end: index * 0.18 + 0.16 }));
  const style = { fontFamily: "Helvetica", fontSize: 58, fontWeight: 900, stroke: 5 };
  const packed = [{ start: 0, end: 2, text: words.map((word) => word.display).join(" "), words }];
  const one = regroupProjectCaptions(packed, { captionLines: 1, boxWidth: 720, canvasWidth: 1080, style });
  const two = regroupProjectCaptions(one, { captionLines: 2, boxWidth: 720, canvasWidth: 1080, style });
  const multi = regroupProjectCaptions(two, { captionLines: "multi", boxWidth: 720, canvasWidth: 1080, style });
  const expected = words.map((word) => word.display);
  assert.deepEqual(flattenCaptionWords(one).map((word) => word.display), expected);
  assert.deepEqual(flattenCaptionWords(two).map((word) => word.display), expected);
  assert.deepEqual(flattenCaptionWords(multi).map((word) => word.display), expected);
  assert.equal(endsCaptionSentence("doesn't"), false);
  for (let index = 0; index < one.length - 1; index += 1)
    assert.ok(one[index].end <= one[index + 1].start + 1e-6);
});

test("an interrupted realtime transcript recovers later speech instead of losing all captions", () => {
  const recovered = recoverIncompleteSegments(
    [{ text: "The beginning remains correct and then", start: 0, end: 2.6 }],
    "The beginning remains correct and then one word is mistaken but every later sentence still has accurate timing and remains available for alignment.",
    9,
  );
  assert.ok(recovered.length > 1);
  assert.match(
    recovered.map((segment) => segment.text).join(" "),
    /every later sentence still has accurate timing/i,
  );
  assert.ok(recovered.at(-1).end <= 9.001);
  assert.ok(recovered.at(-1).end > 8.8);
});

test("native Whisper centisecond timestamps cannot stretch the first sentence across the video", () => {
  const normalized = normalizeTranscriptTimebase(
    [
      {
        text: "Three end time signs",
        start: 0,
        end: 320,
        chunkIndex: 0,
        chunkOffset: 0,
        timebase: "whisper-centiseconds",
      },
      {
        text: "Everyone is watching wars and disasters",
        start: 320,
        end: 790,
        chunkIndex: 0,
        chunkOffset: 0,
        timebase: "whisper-centiseconds",
      },
    ],
    12,
  );
  assert.deepEqual(
    normalized.map((segment) => [segment.start, segment.end]),
    [[0, 3.2], [3.2, 7.9]],
  );
  const captions = buildCaptions(
    spokenCaptionWords(
      alignScript({
        segments: normalized,
        script:
          "Three End-Time Signs. Everyone is watching wars and disasters.",
        duration: 12,
      }).operations,
    ),
    { maxWords: 8, maxChars: 32 },
  );
  assert.ok(captions.length >= 2);
  assert.ok(captions[0].end < 4);
  assert.match(captions.at(-1).text, /wars and disasters\./);
});

test("timestamp guard repairs raw centiseconds from later overlapping windows", () => {
  const normalized = normalizeTranscriptTimebase(
    [
      {
        text: "The later paragraph remains available",
        start: 43.9 + 120,
        end: 43.9 + 680,
        chunkIndex: 1,
        chunkOffset: 43.9,
      },
    ],
    90,
  );
  assert.ok(Math.abs(normalized[0].start - 45.1) < 0.0001);
  assert.ok(Math.abs(normalized[0].end - 50.7) < 0.0001);
});

test("several distant reading errors stay local and the final paragraph always re-anchors", () => {
  const script = [
    "Hebrews 10:26-27 says: For if we sin willfully after that we have received the knowledge of the truth, there remains no more sacrifice for sins.",
    "But a certain fearful expectation of judgment remains for those who deliberately turn away.",
    "The Lord is merciful and gracious, slow to anger, and abundant in goodness and truth.",
    "He welcomes every honest prayer and gives wisdom to all who ask.",
    "Therefore do not turn away from His voice today, because every final word still matters.",
  ].join(" ");
  const segments = [
    {
      text: "Hebrews ten twenty six twenty seven says for if we sin willfully after that we have received the knowledge of the truth there remains no more sacrifice for sins",
      start: 0,
      end: 13,
    },
    {
      text: "completely unrelated repeated words that were read by mistake",
      start: 13,
      end: 16,
    },
    {
      text: "The Lord is merciful and gracious slow to anger and abundant in goodness and truth",
      start: 16,
      end: 24,
    },
    {
      text: "The Lord is merciful and gracious slow to anger and abundant in goodness and truth He welcomes every honest prayer and gives wisdom to all who ask",
      start: 24,
      end: 35,
    },
    {
      text: "Therefore do not turn away from his voice today because every final word still matters",
      start: 35,
      end: 43,
    },
  ];
  const aligned = alignScript({ segments, script, duration: 43 });
  const output = textOf(aligned.operations);
  assert.match(output, /Hebrews 10:26-27 says:/);
  assert.match(output, /He welcomes every honest prayer and gives wisdom to all who ask\./);
  assert.match(output, /Therefore do not turn away from His voice today, because every final word still matters\.$/);
  assert.ok(aligned.issues.some((issue) => issue.suggested));
  assert.ok(aligned.issues.every((issue) => issue.end - issue.start < 9));
  assert.ok(aligned.issues.every((issue) => issue.end <= 43));
});

test("a wrong phrase cannot turn all later near-ASR words into one red tail", () => {
  const script =
    "The Lord is good. The Lord is gracious. The Lord is faithful. The Lord is merciful. The Lord is powerful. The Lord is holy. Finally every listener receives the complete closing sentence without losing a single word.";
  const aligned = alignScript({
    segments: [{
      text: "The Lord is good totally unrelated mistaken words repeated here The Lord was graciously The Lord was faithfull The Lord was mercifull The Lord was powerfull The Lord was holy Finally every listeners receives the complete closing sentences without losing one single word",
      start: 0,
      end: 25,
    }],
    script,
    duration: 25,
  });
  const finalWords = spokenCaptionWords(aligned.operations)
    .filter((word) => word.start >= 17)
    .map((word) => word.display)
    .join(" ");
  assert.match(finalWords, /Finally every listener receives the complete closing sentence/);
  assert.ok(!aligned.issues.some((issue) => issue.start < 8 && issue.end > 20));
  assert.ok(aligned.issues.every((issue) => issue.end <= 25));
});

test("small spoken connectors are ignored while exact manuscript punctuation remains", () => {
  const script =
    "Jesus said in Matthew 24:36: No one knows the day or the hour. Therefore, stay ready.";
  const aligned = alignScript({
    segments: [{
      text: "Jesus said in Matthew twenty four thirty six and no one knows the day or the hour but therefore stay ready",
      start: 0,
      end: 8,
    }],
    script,
    duration: 8,
  });
  assert.equal(aligned.issues.length, 0);
  assert.equal(buildReviewCaptions(aligned.issues, aligned.expected, 8).length, 0);
  assert.equal(textOf(aligned.operations), script);
});

test("spoken clock shorthand maps to the exact manuscript time", () => {
  const script = "Join us from 8:00 PM to 10:00 PM and learn together.";
  const aligned = alignScript({
    segments: [{ text: "Join us from 8 to 10 and learn together", start: 0, end: 5 }],
    script,
    duration: 5,
  });
  assert.equal(textOf(aligned.operations), script);
  assert.equal(aligned.issues.length, 0);
});

test("meaning-preserving conversational additions become green insert decisions", () => {
  const aligned = alignScript({
    segments: [{ text: "Faith my friends brings hope", start: 0, end: 3 }],
    script: "Faith brings hope.",
    duration: 3,
  });
  const review = buildReviewCaptions(aligned.issues, aligned.expected, 3);
  assert.equal(review.length, 1);
  assert.equal(review[0].action, "insert");
  assert.match(review[0].text, /my friends/i);
});

test("a short bounded colloquial addition is green while a later wrong reading stays red and local", () => {
  const aligned = alignScript({
    segments: [{
      text: "God gives us you guys courage today completely mistaken repeated line Hope returns after the error",
      start: 0,
      end: 9,
    }],
    script: "God gives us courage today. Hope returns after the error.",
    duration: 9,
  });
  const review = buildReviewCaptions(aligned.issues, aligned.expected, 9);
  assert.ok(review.some((item) => item.action === "insert" && /you guys/i.test(item.text)));
  assert.ok(review.some((item) => item.action === "cut" && /mistaken repeated/i.test(item.text)));
  assert.match(textOf(aligned.operations), /Hope returns after the error\.$/);
  assert.ok(review.every((item) => item.end - item.start < 5));
});

test("caption groups never bridge across a removable spoken error", () => {
  const aligned = alignScript({
    segments: [
      { text: "Faith remains", start: 0, end: 1 },
      { text: "wrong repeated phrase", start: 1, end: 3.2 },
      { text: "hope returns today", start: 3.2, end: 5 },
    ],
    script: "Faith remains. Hope returns today.",
    duration: 5,
  });
  const captions = buildCaptions(spokenCaptionWords(aligned.operations), {
    maxWords: 10,
    maxChars: 80,
  });
  assert.equal(captions.length, 2);
  assert.equal(captions[0].text, "Faith remains.");
  assert.equal(captions[1].text, "Hope returns today.");
  assert.ok(captions[0].end <= 1.01);
  assert.ok(captions[1].start >= 3.19);
});

test("opening manuscript captions stay whole when ASR hallucinates over the intro", () => {
  const script = "God Hates These 3 Sins—Are You Guilty? The Bible doesn't just say God dislikes these sins.";
  const aligned = alignScript({
    segments: [
      { text: "fire Bop ben that backfivar we see today", start: 4.2, end: 5.1 },
      { text: "The Bible doesn't just say God dislikes these sins", start: 5.1, end: 8.4 },
    ],
    script,
    duration: 9,
  });
  const captions = buildCaptions(manuscriptCaptionWords(aligned), {
    maxWords: 10,
    maxChars: 80,
  });
  const text = captions.map((caption) => caption.text).join(" ");
  assert.match(text, /The Bible doesn't just say God dislikes these sins/);
  assert.doesNotMatch(text, /backfivar/);
  assert.ok(captions.some((caption) => caption.text.split(/\s+/).length >= 6));
});

test("overlapping recognition windows are stitched without a fake repeated word", () => {
  const stitched = stitchTranscriptSegments([
    {
      text: "The Lord is merciful and",
      start: 40,
      end: 45,
      chunkIndex: 0,
    },
    {
      text: "and gracious slow to anger",
      start: 43.9,
      end: 48.5,
      chunkIndex: 1,
    },
    {
      text: "anger and abundant in goodness",
      start: 47.4,
      end: 52,
      chunkIndex: 2,
    },
  ]);
  assert.equal(
    stitched.map((segment) => segment.text).join(" "),
    "The Lord is merciful and gracious slow to anger and abundant in goodness",
  );
  assert.ok(stitched.every((segment, index) => index === 0 || segment.start >= stitched[index - 1].end));
});

test("opening Are you guilty of any is a title hook, not a red cut", () => {
  const script = "God Hates These 3 Sins—Are You Guilty? The Bible doesn't just say God dislikes these sins.";
  const aligned = alignScript({
    segments: [
      { text: "Are you guilty of any of these", start: 2.0, end: 3.1 },
      { text: "God hates these 3 sins are you guilty", start: 3.1, end: 5.2 },
      { text: "The Bible doesn't just say God dislikes these sins", start: 5.2, end: 8.4 },
    ],
    script,
    duration: 9,
  });
  const hook = aligned.issues.find((issue) => /guilty of any/i.test(issue.spokenText || ""));
  assert.ok(hook);
  assert.equal(hook.confirmedCut, false);
  assert.notEqual(hook.action, "cut");
  const review = buildReviewCaptions(aligned.issues, aligned.expected, 9);
  assert.ok(!review.some((item) => item.action === "cut" && /guilty of any/i.test(item.text)));
  const captions = buildCaptions(manuscriptCaptionWords(aligned), { maxWords: 10, maxChars: 80 });
  assert.ok(captions.some((caption) => /God Hates These 3 Sins/i.test(caption.text)));
});

test("That's me stays one manuscript phrase when ASR expands the contraction", () => {
  const script = `Maybe you're thinking,\n\n"That's me.\n\nI've done those things.`;
  const aligned = alignScript({
    segments: [{
      text: "Maybe you're thinking that is me this is me I've done those things",
      start: 5,
      end: 13,
    }],
    script,
    duration: 13,
  });
  const thatsIndex = aligned.operations.findIndex((operation) =>
    /that.?s/i.test(operation.expected?.display || ""),
  );
  const meIndex = aligned.operations.findIndex(
    (operation, index) =>
      index > thatsIndex &&
      /^["“]?me[.!]?["”]?$/i.test(String(operation.expected?.display || "").replace(/^[\"“]+/, "")),
  );
  assert.ok(thatsIndex >= 0);
  assert.ok(meIndex > thatsIndex);
  const between = aligned.operations.slice(thatsIndex + 1, meIndex);
  assert.equal(between.some((operation) => operation.type === "extra"), false);
  const captions = buildCaptions(manuscriptCaptionWords(aligned), {
    maxWords: 7,
    maxChars: 32,
  });
  assert.ok(captions.some((caption) => /That's/i.test(caption.text) && /\bme\./i.test(caption.text)));
  assert.ok(!captions.some((caption) => /^me\.$/i.test(caption.text.trim())));
  const extra = aligned.issues.find((issue) => /this is/i.test(issue.spokenText || ""));
  if (extra) {
    const me = aligned.operations[meIndex];
    assert.ok(extra.start >= Number(me.spoken?.start || me.expected?.start || 0) - 0.08);
  }
});

test("I've done matches spoken I have done", () => {
  const aligned = alignScript({
    segments: [{ text: "I have done those things more than once", start: 0, end: 4 }],
    script: "I've done those things. More than once.",
    duration: 4,
  });
  assert.equal(textOf(aligned.operations), "I've done those things. More than once.");
  assert.equal(aligned.issues.some((issue) => issue.type === "extra" && /have/i.test(issue.spokenText || "")), false);
});

test("doesn't just say stays matched when ASR speaks does not", () => {
  const script = "The Bible doesn't just say God dislikes these sins.";
  const aligned = alignScript({
    segments: [{ text: "The Bible does not just say God dislikes these sins", start: 0, end: 5 }],
    script,
    duration: 5,
  });
  assert.equal(textOf(aligned.operations), script);
  assert.equal(aligned.issues.length, 0);
});

test("tail off-script spoken addition (together and follow Christ) generates green caption with accurate timestamps", () => {
  const aligned = alignScript({
    segments: [
      { text: "get connected", start: 418.0, end: 419.5 },
      { text: "together and follow Christ.", start: 419.8, end: 421.5 },
    ],
    script: "get connected.",
    duration: 422,
  });
  const words = manuscriptCaptionWords(aligned);
  const captions = buildCaptions(words);
  assert.ok(captions.some((c) => /together and follow Christ/i.test(c.text)), "tail spoken addition must generate caption");
  const tailCaption = captions.find((c) => /together and follow Christ/i.test(c.text));
  assert.ok(tailCaption.start >= 419.5, "tail caption start timestamp must match spoken audio");
});
