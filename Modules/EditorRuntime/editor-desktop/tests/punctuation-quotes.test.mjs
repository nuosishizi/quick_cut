import test from "node:test";
import assert from "node:assert/strict";
import {
  displayWords,
  formatDisplayWords,
  endsCaptionSentence,
} from "../src/alignment.mjs";
import { tokenizeWordsFallback } from "../src/resolve-link.mjs";

test("Chinese quotes paired properly with colon and next sentence without bleeding", () => {
  const curly = displayWords('我说：“你好啊” 你好');
  assert.deepEqual(
    curly.map((w) => w.display),
    ["我说：", "“你好啊”", "你好"],
  );

  const straight = displayWords('我说："你好啊" 你好');
  assert.deepEqual(
    straight.map((w) => w.display),
    ["我说：", '"你好啊"', "你好"],
  );
});

test("English straight quotes correctly track pair state across multiple words", () => {
  const text = 'i say: "hello , today is good" tomorrow is great';
  const words = displayWords(text);
  assert.deepEqual(
    words.map((w) => w.display),
    ["i", "say:", '"hello,', "today", "is", 'good"', "tomorrow", "is", "great"],
  );
  assert.equal(
    formatDisplayWords(words),
    'i say: "hello, today is good" tomorrow is great',
  );
});

test("Multiple quotes and punctuation marks stay attached and never orphan to next sentence", () => {
  const text = 'He asked: "Are you sure?" She said: "Yes, absolutely!" Done.';
  const words = displayWords(text);
  assert.deepEqual(
    words.map((w) => w.display),
    [
      "He", "asked:", '"Are', "you", 'sure?"',
      "She", "said:", '"Yes,', 'absolutely!"',
      "Done.",
    ],
  );
});

test("Chinese bracket types (《》「」【】（）) attach properly as prefix/suffix", () => {
  const text = '请看《圣经》【重要】（附录）「引用」『重点』！';
  const words = displayWords(text);
  assert.deepEqual(
    words.map((w) => w.display),
    ['请看', '《圣经》', '【重要】', '（附录）', '「引用」', '『重点』！'],
  );
});

test("endsCaptionSentence recognizes Chinese and English sentence terminators with quotes", () => {
  assert.equal(endsCaptionSentence("你好。"), true);
  assert.equal(endsCaptionSentence("真的吗？"), true);
  assert.equal(endsCaptionSentence("太好了！"), true);
  assert.equal(endsCaptionSentence("我说：“你好！”"), true);
  assert.equal(endsCaptionSentence('He said: "Hello!"'), true);
  assert.equal(endsCaptionSentence("我说："), false);
  assert.equal(endsCaptionSentence("“你好啊"), false);
  assert.equal(endsCaptionSentence("hello"), false);
});

test("formatDisplayWords cleans spaces before punctuation while preserving spacing", () => {
  const words = [
    { display: "hello" },
    { display: "," },
    { display: "world" },
    { display: "!" },
  ];
  assert.equal(formatDisplayWords(words), "hello, world!");
});

test("tokenizeWordsFallback attaches punctuation and quotes without separate punctuation tokens", () => {
  const tokens = tokenizeWordsFallback('我说：“你好啊” 你好', 0, 3);
  const words = tokens.map((t) => t.word);
  // Ensure no token is solely punctuation like `"` or `“` or `”` or `：`
  for (const w of words) {
    assert.match(w, /[\u3400-\u9FFF\w]/u, `Token should contain letters/characters: ${w}`);
  }
  assert.deepEqual(words, ["我", "说：", "“你", "好", "啊”", "你", "好"]);
});

test("Language-aware punctuation normalization converts cross-language misplaced punctuation", async () => {
  const { normalizeLanguagePunctuation } = await import("../src/text-layout.mjs");
  // English with full-width Chinese punctuation
  assert.equal(normalizeLanguagePunctuation("hello，world"), "hello, world");
  assert.equal(normalizeLanguagePunctuation("i say：good"), "i say: good");
  assert.equal(normalizeLanguagePunctuation("warning！it works"), "warning! it works");

  // Chinese with half-width punctuation
  assert.equal(normalizeLanguagePunctuation("你好,世界"), "你好，世界");
  assert.equal(normalizeLanguagePunctuation("太好了!"), "太好了！");
  assert.equal(normalizeLanguagePunctuation("真的吗?"), "真的吗？");
});

test("Pangu spacing automatically inserts half-width space between CJK and Latin/Digits", async () => {
  const { formatPanguSpacing } = await import("../src/text-layout.mjs");
  assert.equal(formatPanguSpacing("学习JavaScript很棒"), "学习 JavaScript 很棒");
  assert.equal(formatPanguSpacing("在iPhone 16上运行"), "在 iPhone 16 上运行");
  assert.equal(formatPanguSpacing("2026年8月18日"), "2026 年 8 月 18 日");
});

test("Trailing punctuation stripping removes only trailing commas and periods", async () => {
  const { stripTrailingCaptionPunctuation } = await import("../src/text-layout.mjs");
  assert.equal(stripTrailingCaptionPunctuation("这是第一句，"), "这是第一句");
  assert.equal(stripTrailingCaptionPunctuation("这是第二句。"), "这是第二句");
  assert.equal(stripTrailingCaptionPunctuation("This is a sentence,"), "This is a sentence");
  assert.equal(stripTrailingCaptionPunctuation("This is done."), "This is done");

  // Important: preserve emotion and dialogue punctuation!
  assert.equal(stripTrailingCaptionPunctuation("真的吗？"), "真的吗？");
  assert.equal(stripTrailingCaptionPunctuation("太好了！"), "太好了！");
  assert.equal(stripTrailingCaptionPunctuation("未完待续……"), "未完待续……");
  assert.equal(stripTrailingCaptionPunctuation('我说：“你好”'), '我说：“你好”');
});

test("Scripture reference Jude 1:7 is tokenized and wrapped together without splitting", async () => {
  const text = 'Quietly Destroying You Jude 1:7 says: "Even';
  const words = displayWords(text);
  assert.deepEqual(
    words.map((w) => w.display),
    ["Quietly", "Destroying", "You", "Jude", "1", ":7", "says:", '"Even'],
  );

  const { packWordsIntoLines } = await import("../src/text-layout.mjs");
  // Test wrapping at a width that forces a break
  const lines = packWordsIntoLines(words, { fontSize: 54 }, 750, 1);
  const lineTexts = lines.map((l) => l.words.map((w) => w.display).join(" "));

  // Ensure line 2 never starts with ':7' or '7'
  for (const lt of lineTexts) {
    assert.equal(/^:\d+/.test(lt), false, `Line must not start with colon numbers: ${lt}`);
  }
  // Ensure 'Jude' and '1' and ':7' stay together on line 2
  assert.equal(lineTexts[0], "Quietly Destroying You");
  assert.equal(lineTexts[1], 'Jude 1 :7 says: "Even');
});

test("Atomic tokens for currency, percentages, units, and abbreviations", () => {
  const text = 'Price is $100 and growth is 99.5% with 50kg weight in U.S.A.';
  const words = displayWords(text);
  const displays = words.map((w) => w.display);
  assert.ok(displays.includes("$100"), `Expected $100 atomic token, got: ${displays}`);
  assert.ok(displays.includes("99.5%"), `Expected 99.5% atomic token, got: ${displays}`);
  assert.ok(displays.includes("50kg"), `Expected 50kg atomic token, got: ${displays}`);
  assert.ok(displays.includes("U.S.A."), `Expected U.S.A. atomic token, got: ${displays}`);
});

test("layoutCaptionPaint keeps Jude 1:7 together and never starts line with :7", async () => {
  const { layoutCaptionPaint } = await import("../src/text-layout.mjs");
  // Test case 1: when words are [1, :7]
  const caption1 = {
    text: 'Quietly Destroying You Jude 1:7 says: "Even',
    words: [
      { display: "Quietly" },
      { display: "Destroying" },
      { display: "You" },
      { display: "Jude" },
      { display: "1" },
      { display: ":7" },
      { display: "says:" },
      { display: '"Even' },
    ],
  };
  const layout1 = layoutCaptionPaint({
    words: caption1.words,
    style: { fontSize: 54 },
    boxWidth: 700,
    lineMode: 2,
  });
  const line1_1 = layout1.lines[0]?.words.map((w) => w.display).join(" ");
  const line1_2 = layout1.lines[1]?.words.map((w) => w.display).join(" ");

  assert.equal(line1_1, "Quietly Destroying You");
  assert.equal(line1_2, 'Jude 1 :7 says: "Even');
  assert.ok(!line1_2.startsWith(":7"), "Line 2 must never start with :7");

  // Test case 2: when words are [1:7]
  const caption2 = {
    text: 'Quietly Destroying You Jude 1:7 says: "Even',
    words: [
      { display: "Quietly" },
      { display: "Destroying" },
      { display: "You" },
      { display: "Jude" },
      { display: "1:7" },
      { display: "says:" },
      { display: '"Even' },
    ],
  };
  const layout2 = layoutCaptionPaint({
    words: caption2.words,
    style: { fontSize: 54 },
    boxWidth: 700,
    lineMode: 2,
  });
  const line2_1 = layout2.lines[0]?.words.map((w) => w.display).join(" ");
  const line2_2 = layout2.lines[1]?.words.map((w) => w.display).join(" ");

  assert.equal(line2_1, "Quietly Destroying You");
  assert.equal(line2_2, 'Jude 1:7 says: "Even');
  assert.ok(!line2_2.startsWith(":7"), "Line 2 must never start with :7");
});




