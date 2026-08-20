import assert from "node:assert/strict";
import test from "node:test";

import {
  captionTranslationPrompt,
  parseCaptionTranslations,
} from "../src/caption-translation.mjs";

test("caption translation parser accepts fenced JSON and preserves caption ids", () => {
  const rows = parseCaptionTranslations(
    '好的，结果如下：\n```json\n{"translations":[{"id":"c1","text":"拯救这段视频。"},{"id":"c2","text":"他保持沉默。"}]}\n```',
    ["c1", "c2"],
  );
  assert.deepEqual(rows, [
    { id: "c1", text: "拯救这段视频。" },
    { id: "c2", text: "他保持沉默。" },
  ]);
});

test("caption translation parser rejects unknown and duplicate ids", () => {
  const rows = parseCaptionTranslations(
    JSON.stringify([
      { id: "known", translation: "第一版" },
      { id: "known", text: "不应覆盖" },
      { id: "other", text: "不应进入工程" },
    ]),
    ["known"],
  );
  assert.deepEqual(rows, [{ id: "known", text: "第一版" }]);
});

test("Chinese auxiliary prompt keeps English ids and protects scripture meaning", () => {
  const prompt = captionTranslationPrompt(
    [{ id: "verse-1", text: "For God so loved the world." }],
    "zh-Hant",
  );
  assert.match(prompt.system, /繁体中文/);
  assert.match(prompt.system, /经文含义/);
  assert.match(prompt.system, /只输出 JSON/);
  assert.match(prompt.user, /verse-1/);
});
