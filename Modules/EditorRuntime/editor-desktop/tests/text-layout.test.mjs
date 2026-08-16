import assert from "node:assert/strict";
import test from "node:test";
import { regroupCaptions } from "../src/alignment.mjs";
import {
  captionSafeBoxWidth,
  captionWrapLineLimit,
  estimatedLineWidth,
  normalizeCaptionLines,
  packWordsIntoLines,
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
    assertLinesFit(wrapped, style, captionSafeBoxWidth(options), `wrap ${boxWidth}`);
    assert.ok(wrapped.join(" ").includes("sin"));
  }
});

test("scripture title wraps to two lines at the Resolve preview width", () => {
  const style = { fontFamily: "Helvetica", fontSize: 56, fontWeight: 800, backgroundEnabled: true, backgroundWidth: 26 };
  const text = `Proverbs 12 :22: "Lying lips are`;
  const lines = wrapWords(text, style, 860, 2, 1);
  assert.equal(lines.length, 2, `expected 2 lines, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /Proverbs/);
  assert.match(lines.at(-1), /are/);
});

test("wrapWords never dumps leftover words onto an overflowing last line", () => {
  const style = { fontFamily: "Helvetica", fontSize: 58, fontWeight: 800 };
  const lines = wrapWords(screenshotText, style, 520, 2, 1);
  assert.ok(lines.length >= 3, `expected extra wrap instead of overflow, got ${JSON.stringify(lines)}`);
  assertLinesFit(lines, style, 520, "hard wrap");
  assert.match(lines.at(-1), /sin/);
});
