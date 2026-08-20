import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { waveformChannelPeaks } from "../src/pausecut.mjs";
import {
  dropSubframeClips,
  rollingEditMainClips,
  slipClipSource,
} from "../src/timeline-edit.mjs";

describe("high fidelity waveform data", () => {
  it("keeps left and right channel peaks separate", () => {
    const pcm = new Float32Array([
      -1, -0.25,
      0.75, 0.5,
      -0.5, -0.75,
      0.25, 1,
    ]);
    assert.deepEqual(waveformChannelPeaks(pcm, 2, 2), [
      [-1, 0.75, -0.25, 0.5],
      [-0.5, 0.25, -0.75, 1],
    ]);
  });

  it("keeps mono waveform entries backward compatible", () => {
    const pcm = new Float32Array([-1, 0.5, -0.25, 1]);
    assert.deepEqual(waveformChannelPeaks(pcm, 2, 1), [
      [-1, 0.5],
      [-0.25, 1],
    ]);
  });
});

describe("Resolve-style trim helpers", () => {
  it("rolls a cut while preserving the neighboring source span", () => {
    const result = rollingEditMainClips(
      [],
      [5],
      { sourceStart: 0, sourceEnd: 5 },
      { sourceStart: 5, sourceEnd: 10 },
      6,
    );
    assert.deepEqual(result.manualCuts, [6]);
    assert.equal(result.cutPoint, 6);
  });

  it("slips source content without changing its duration", () => {
    assert.deepEqual(
      slipClipSource({ sourceStart: 4, sourceEnd: 7 }, 2, 0, 12),
      { sourceStart: 6, sourceEnd: 9 },
    );
  });

  it("uses the actual frame rate when pruning sub-frame clips", () => {
    const clips = [
      { sourceStart: 0, sourceEnd: 0.03, start: 0, end: 0.03 },
      { sourceStart: 0.03, sourceEnd: 1, start: 0.03, end: 1 },
    ];
    assert.equal(dropSubframeClips(clips, [], [], 1, 1, 60).packed.length, 2);
    assert.equal(dropSubframeClips(clips, [], [], 1, 1, 24).packed.length, 1);
  });
});

describe("timeline UI wiring", () => {
  const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

  it("parses the complete editor script", () => {
    const start = html.indexOf("<script>") + "<script>".length;
    const end = html.indexOf("</script>", start);
    assert.ok(start > 0 && end > start);
    assert.doesNotThrow(() => new Function(html.slice(start, end)));
  });

  it("wires waveform, track height, solo and trim detail controls", () => {
    assert.match(html, /data-main-wave-track/);
    assert.match(html, /data-height-track/);
    assert.match(html, /data-solo-track/);
    assert.match(html, /id="trimAudioDetail"/);
    assert.match(html, /Roll 滾動編輯/);
    assert.match(html, /Slip 滑移片段内容/);
  });

  it("steps arrows using source frame duration", () => {
    assert.match(html, /state\.currentTime - \(e\.shiftKey \? 1 : frameDuration\(\)\)/);
    assert.match(html, /state\.currentTime \+ \(e\.shiftKey \? 1 : frameDuration\(\)\)/);
  });
});
