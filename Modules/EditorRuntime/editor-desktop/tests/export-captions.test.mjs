import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assDropShadow, captionRasterOverlayOffset, estimatedCaptionBox, previewShadowOpacity, writeAssSubtitleFile } from "../src/media.mjs";

test("exported ASS wraps like the preview and keeps shadow on the same lines", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-ass-"));
  const assPath = path.join(directory, "captions.ass");
  writeAssSubtitleFile(
    {
      width: 1080,
      height: 1920,
      captions: [
        {
          text: "We're treating as ordinary something He calls holy.",
          start: 0,
          end: 2,
          x: 0,
          y: 538,
          scale: 1,
          width: 720,
          style: {
            fontFamily: "Helvetica",
            fontSize: 58,
            fontWeight: 800,
            color: "#ffffff",
            highlight: "#ffd21f",
            highlightEnabled: true,
            animation: "karaoke",
            shadow: 3,
            shadowDistance: 8,
            shadowAngle: 45,
            shadowOpacity: 0.8,
            shadowBlur: 4,
            shadowColor: "#000000",
          },
        },
      ],
    },
    assPath,
  );
  const ass = fs.readFileSync(assPath, "utf8");
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /WrapStyle: 2/);
  assert.match(ass, /\\N/);
  const fillText = ass.split("\n").find((line) => line.includes("\\N") && line.includes("\\pos(540,1498)"));
  assert.ok(fillText);
  assert.equal((fillText.match(/\\N/g) || []).length, 1, "2-line preview must export as exactly two ASS lines");
  const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  const shadow = dialogues.find((line) => line.includes("\\blur") && line.includes("\\1c"));
  const fill = dialogues.find((line) => line.includes("\\pos(540,1498)") && line.includes("\\N"));
  assert.ok(shadow, "shadow event should exist");
  assert.ok(fill, "wrapped fill event should sit at preview center + y");
  assert.match(ass, /\\an5\\pos\(540,1498\)/);
  assert.match(shadow, /\\N/);
  const shadowPos = shadow.match(/\\pos\((-?\d+),(-?\d+)\)/);
  const fillPos = fill.match(/\\pos\((-?\d+),(-?\d+)\)/);
  assert.ok(shadowPos && fillPos);
  assert.equal(Number(fillPos[1]), 540);
  assert.equal(Number(fillPos[2]), 1498);
  assert.ok(Math.abs(Number(shadowPos[1]) - Number(fillPos[1])) <= 16);
  assert.ok(Math.abs(Number(shadowPos[2]) - Number(fillPos[2])) <= 16);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("caption raster overlay keeps the captured box at the preview pixel", () => {
  const offset = captionRasterOverlayOffset(1080, 1920, 210, 1410, 620, 168);
  assert.equal(offset.x, 210 - (1080 - 620) / 2);
  assert.equal(offset.y, 1410 - (1920 - 168) / 2);
});

test("fit-text caption background hugs the longer wrapped line, not the 860 box", () => {
  const style = {
    fontSize: 58,
    fontWeight: 900,
    captionLines: 2,
    backgroundEnabled: true,
    backgroundFitText: true,
    backgroundMode: "block",
    backgroundWidth: 26,
    backgroundHeight: 14,
    radius: 26,
    color: "#ffffff",
  };
  const box = estimatedCaptionBox(
    {
      text: "think Jesus loved the ones who",
      words: "think Jesus loved the ones who".split(" ").map((display) => ({ display })),
      width: 860,
    },
    style,
    58,
    1,
    540,
    1498,
    860,
  );
  assert.ok(box.lines.length === 2, `expected 2 lines, got ${JSON.stringify(box.lines)}`);
  assert.ok(box.width < 780, `background ${box.width} is still using the wrap box`);
  assert.ok(box.width > 420, `background ${box.width} collapsed too far`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-ass-bg-"));
  const assPath = path.join(directory, "bg.ass");
  writeAssSubtitleFile(
    {
      width: 1080,
      height: 1920,
      captions: [
        {
          text: "think Jesus loved the ones who",
          start: 0,
          end: 2,
          x: 0,
          y: 538,
          width: 860,
          words: "think Jesus loved the ones who".split(" ").map((display, index) => ({
            display,
            start: index * 0.3,
            end: index * 0.3 + 0.28,
          })),
          style,
        },
      ],
    },
    assPath,
  );
  const ass = fs.readFileSync(assPath, "utf8");
  const drawing = ass.split("\n").find((line) => line.includes("\\p1"));
  assert.ok(drawing, "background drawing should exist");
  const pathMatch = drawing.match(/l (\d+) 0/);
  assert.ok(pathMatch);
  assert.ok(Number(pathMatch[1]) < 780, `drawn width ${pathMatch[1]} still looks like the 860 box`);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("default fade captions stay at the preview lower-third and still highlight spoken words", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-ass-fade-"));
  const assPath = path.join(directory, "fade.ass");
  writeAssSubtitleFile(
    {
      width: 1080,
      height: 1920,
      captions: [
        {
          text: "Why I say",
          start: 0,
          end: 1.5,
          x: 0,
          y: 538,
          scale: 1,
          width: 860,
          words: [
            { display: "Why", start: 0, end: 0.4 },
            { display: "I", start: 0.4, end: 0.75 },
            { display: "say", start: 0.75, end: 1.5 },
          ],
          style: {
            fontSize: 58,
            highlight: "#ffd21f",
            highlightEnabled: true,
            animation: "fade",
            color: "#ffffff",
          },
        },
      ],
    },
    assPath,
  );
  const ass = fs.readFileSync(assPath, "utf8");
  assert.match(ass, /\\an5\\pos\(540,1498\)/);
  assert.doesNotMatch(ass, /Dialogue:[^\\]*\\fad\(180,90\)(?![^\\]*\\pos)/);
  assert.equal((ass.match(/^Dialogue:/gm) || []).length >= 3, true);
  assert.match(ass, /\\1c&H1FD2FF&/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("default preview shadow and stroke survive spoken-word export", () => {
  const style = {
    shadow: 3,
    shadowOpacity: 0.8,
    shadowBlur: 4,
    shadowDistance: 3,
    shadowAngle: 45,
    shadowColor: "#000000",
    stroke: 3,
    strokeColor: "#000000",
    highlightEnabled: true,
    animation: "fade",
    fontSize: 58,
    color: "#ffffff",
    highlight: "#ffd21f",
  };
  assert.ok(previewShadowOpacity(style) > 0.3, "preview-strength shadow must stay visible");
  const drop = assDropShadow(style, 1);
  assert.ok(drop);
  assert.ok(drop.blur > 0);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-ass-style-"));
  const assPath = path.join(directory, "style.ass");
  writeAssSubtitleFile(
    {
      width: 1080,
      height: 1920,
      captions: [
        {
          text: "Why I say",
          start: 0,
          end: 1.2,
          x: 0,
          y: 538,
          width: 860,
          words: [
            { display: "Why", start: 0, end: 0.4 },
            { display: "I", start: 0.4, end: 0.8 },
            { display: "say", start: 0.8, end: 1.2 },
          ],
          style,
        },
      ],
    },
    assPath,
  );
  const ass = fs.readFileSync(assPath, "utf8");
  assert.match(ass, /\\bord3\.0/);
  assert.match(ass, /\\3c/);
  assert.match(ass, /\\blur/);
  assert.match(ass, /Dialogue: 1,/);
  assert.match(ass, /Dialogue: 2,/);
  fs.rmSync(directory, { recursive: true, force: true });
});

