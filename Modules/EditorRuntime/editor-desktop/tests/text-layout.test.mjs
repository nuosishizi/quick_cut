import assert from "node:assert/strict";
import test from "node:test";
import { regroupCaptions } from "../src/alignment.mjs";
import {
  captionHighlightSegments,
  captionSafeBoxWidth,
  captionWrapLineLimit,
  estimatedLineWidth,
  layoutCaptionPaint,
  normalizeCaptionLines,
  paintedLineWidth,
  paintedWordWidth,
  packWordsIntoLines,
  wrapCaptionWordList,
  wrapWords,
} from "../src/text-layout.mjs";

const screenshotText = "Listen carefully— because the third one is the only sin";

function timedWords(text) {
  return text.split(/\s+/).filter(Boolean).map((display, index) => ({
    display,
    start: index * 0.18,
    end: index * 0.18 + 0.16,
  }));
}

function assertLinesFit(lines, style, maxWidth, label) {
  for (const line of lines) {
    const displays = typeof line === "string"
      ? line.split(/\s+/).filter(Boolean)
      : (line.words || []).map((word) => word.display || word);
    const width = estimatedLineWidth(displays, style, style.fontSize, 1);
    assert.ok(
      width <= maxWidth + 0.5,
      `${label}: "${displays.join(" ")}" is ${width.toFixed(1)}px > ${maxWidth}px`,
    );
  }
}

function assertCaptionsFit(captions, style, options, maxLines, label) {
  const maxWidth = captionSafeBoxWidth(options);
  const kept = [];
  for (const caption of captions) {
    const packed = packWordsIntoLines(caption.words, style, maxWidth, 1);
    assert.ok(
      packed.length <= maxLines,
      `${label}: "${caption.text}" used ${packed.length} lines, limit ${maxLines}`,
    );
    assertLinesFit(packed, style, maxWidth, label);
    kept.push(...caption.words.map((word) => word.display));
  }
  return kept;
}

test("1, 2 and 3 line modes keep every word inside the box", () => {
  const words = timedWords(screenshotText);
  const style = {
    fontFamily: "Helvetica",
    fontSize: 56,
    fontWeight: 800,
    backgroundEnabled: true,
    backgroundWidth: 26,
    stroke: 0,
  };
  const options = { boxWidth: 760, canvasWidth: 1080, style };
  const expected = words.map((word) => word.display);

  const one = regroupCaptions(words, { ...options, captionLines: 1 });
  const two = regroupCaptions(words, { ...options, captionLines: 2 });
  const three = regroupCaptions(words, { ...options, captionLines: 3 });
  const multi = regroupCaptions(words, { ...options, captionLines: "multi" });

  assert.deepEqual(assertCaptionsFit(one, style, options, 1, "1-line"), expected);
  assert.deepEqual(assertCaptionsFit(two, style, options, 2, "2-line"), expected);
  assert.deepEqual(assertCaptionsFit(three, style, options, 3, "3-line"), expected);
  assert.deepEqual(assertCaptionsFit(multi, style, options, 8, "multi"), expected);
  assert.ok(one.length >= two.length);
  assert.equal(captionWrapLineLimit(3), 3);
  assert.equal(normalizeCaptionLines(3), 3);
});

test("screenshot sentence never overflows a 2-line box at common widths", () => {
  const words = timedWords(screenshotText);
  const style = { fontFamily: "Helvetica", fontSize: 56, fontWeight: 800, backgroundEnabled: true, backgroundWidth: 26 };
  for (const boxWidth of [640, 720, 760, 800, 860]) {
    const options = { boxWidth, canvasWidth: 1080, style };
    const captions = regroupCaptions(words, { ...options, captionLines: 2 });
    assert.deepEqual(
      assertCaptionsFit(captions, style, options, 2, `box ${boxWidth}`),
      words.map((word) => word.display),
    );
    const wrapped = wrapWords(screenshotText, style, captionSafeBoxWidth(options), 2, 1);
    assert.ok(wrapped.length <= 2, `wrap ${boxWidth} exceeded 2 preview lines`);
    assert.ok(wrapped.join(" ").includes("sin"));
  }
});

test("painted caption width hugs the glyphs instead of the wrap box", () => {
  const style = { fontFamily: "Helvetica", fontSize: 58, fontWeight: 900 };
  const line = ["think", "Jesus", "loved", "the"];
  const painted = paintedLineWidth(line, style, 58, 1);
  const wrap = estimatedLineWidth(line, style, 58, 1);
  assert.ok(painted < wrap, `paint ${painted} should be tighter than wrap ${wrap}`);
  assert.ok(painted < 720, `paint ${painted} is still as wide as the subtitle box`);
});

test("preview and export use the same 2-line word breaks", () => {
  const style = { fontFamily: "Helvetica", fontSize: 58, fontWeight: 900 };
  const words = "We're treating as ordinary something He calls holy.".split(/\s+/);
  const lines = wrapCaptionWordList(words, style, 860, 2, 1);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    wrapWords(words.join(" "), style, 860, 2, 1),
    lines.map((line) => line.join(" ")),
  );
});

test("scripture title wraps to two lines at the Resolve preview width", () => {
  const style = { fontFamily: "Helvetica", fontSize: 56, fontWeight: 800, backgroundEnabled: true, backgroundWidth: 26 };
  const text = `Proverbs 12 :22: "Lying lips are`;
  const lines = wrapWords(text, style, 860, 2, 1);
  assert.equal(lines.length, 2, `expected 2 lines, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /Proverbs/);
  assert.match(lines.at(-1), /are/);
});

test("shared caption paint layout hugs the text and keeps the same wrap", () => {
  const style = {
    fontFamily: "Helvetica",
    fontSize: 58,
    fontWeight: 900,
    backgroundEnabled: true,
    backgroundWidth: 18,
    backgroundHeight: 10,
    radius: 20,
    captionLines: 2,
  };
  const words = timedWords("think Jesus loved the people around him");
  const layout = layoutCaptionPaint({
    words,
    style,
    boxWidth: 520,
    measure: (text) => paintedWordWidth(text, style, 58, 1),
  });
  assert.equal(layout.lines.length, 2);
  const longest = Math.max(...layout.lines.map((line) => line.width));
  assert.equal(Number(layout.boxWidth.toFixed(3)), Number((longest + layout.padX * 2).toFixed(3)));
  assert.ok(layout.boxWidth > longest, "background padding must sit outside the painted line");
  assert.equal(layout.padX, 18);
  assert.equal(layout.lines.flatMap((line) => line.words.map((word) => word.display)).join(" "), words.map((word) => word.display).join(" "));
  const segments = captionHighlightSegments({
    start: 0,
    end: 2,
    words: [
      { display: "We're", start: 0, end: 0.3 },
      { display: "treating", start: 0.3, end: 0.7 },
    ],
  });
  assert.ok(segments.length >= 2);
  assert.equal(segments[0].start, 0);
});

test("2-line wrap stays two lines like the preview, multi wrap can continue", () => {
  const style = { fontFamily: "Helvetica", fontSize: 58, fontWeight: 800 };
  const two = wrapWords(screenshotText, style, 520, 2, 1);
  assert.equal(two.length, 2, `preview 2-line mode must stay 2 lines, got ${JSON.stringify(two)}`);
  assert.match(two.at(-1), /sin/);
  const multi = wrapWords(screenshotText, style, 520, 0, 1);
  assert.ok(multi.length >= 3, `multi wrap should continue, got ${JSON.stringify(multi)}`);
  assertLinesFit(multi, style, 520, "hard wrap");
  assert.match(multi.at(-1), /sin/);
});
