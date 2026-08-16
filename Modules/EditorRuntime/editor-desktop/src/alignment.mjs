import crypto from "node:crypto";
import {
  captionSafeBoxWidth,
  captionWrapLineLimit,
  packWordsIntoLines,
} from "./text-layout.mjs";

const wordPattern = /[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
const numberWords = new Map(
  Object.entries({
    zero: "0",
    oh: "0",
    one: "1",
    first: "1",
    two: "2",
    second: "2",
    three: "3",
    third: "3",
    four: "4",
    fourth: "4",
    five: "5",
    fifth: "5",
    six: "6",
    sixth: "6",
    seven: "7",
    seventh: "7",
    eight: "8",
    eighth: "8",
    nine: "9",
    ninth: "9",
    ten: "10",
    tenth: "10",
    eleven: "11",
    eleventh: "11",
    twelve: "12",
    twelfth: "12",
    thirteen: "13",
    thirteenth: "13",
    fourteen: "14",
    fourteenth: "14",
    fifteen: "15",
    fifteenth: "15",
    sixteen: "16",
    sixteenth: "16",
    seventeen: "17",
    seventeenth: "17",
    eighteen: "18",
    eighteenth: "18",
    nineteen: "19",
    nineteenth: "19",
    twenty: "20",
    twentieth: "20",
    thirty: "30",
    fortieth: "40",
    forty: "40",
    fifty: "50",
    sixty: "60",
    seventy: "70",
    eighty: "80",
    ninety: "90",
  }),
);
const equivalents = new Map(
  Object.entries({
    okay: "ok",
    yea: "yes",
    yeah: "yes",
    yep: "yes",
    nope: "no",
    cannot: "cant",
    "can't": "cant",
    "won't": "wont",
    "wouldn't": "wouldnt",
    "isn't": "isnt",
    "aren't": "arent",
    gonna: "goingto",
    wanna: "wantto",
    begin: "start",
    begins: "start",
    began: "start",
    started: "start",
    purchase: "buy",
    purchased: "buy",
    buying: "buy",
    assist: "help",
    assists: "help",
    helped: "help",
    huge: "large",
    big: "large",
    little: "small",
    tiny: "small",
    quick: "fast",
    rapidly: "fast",
    child: "kid",
    children: "kids",
    speak: "say",
    spoke: "say",
    says: "say",
    dwells: "live",
    dwell: "live",
    resides: "live",
    lives: "live",
    within: "in",
    inside: "in",
    returns: "return",
    returned: "return",
    coming: "return",
  }),
);
const bibleBooks = new Set(
  "genesis exodus leviticus numbers deuteronomy joshua judges ruth samuel kings chronicles ezra nehemiah esther job psalms psalm proverbs ecclesiastes song isaiah jeremiah lamentations ezekiel daniel hosea joel amos obadiah jonah micah nahum habakkuk zephaniah haggai zechariah malachi matthew mark luke john acts romans corinthians galatians ephesians philippians colossians thessalonians timothy titus philemon hebrews james peter jude revelation".split(
    " ",
  ),
);
const harmlessFillers = new Set(
  "uh um er erm ah hmm well okay ok so actually basically literally just like anyway anyways right yeah yes youknow imean".split(
    " ",
  ),
);
const harmlessConnectors = new Set(
  "and but or so then also now still yet because though".split(" "),
);
const optionalSpeechAdditions = new Set(
  "you know see mean friend friends dear in fact of course as to be honest honestly truly really remember listen look amen god bless blessings everyone everybody today here please".split(" "),
);
const semanticCanonical = new Map(Object.entries({
  dwells: "live", dwell: "live", lives: "live", living: "live", resides: "live", remains: "stay",
  within: "in", inside: "in", upon: "on", through: "by",
  believes: "believe", believed: "believe", trusts: "believe", trust: "believe", faith: "believe",
  returns: "return", returned: "return", coming: "come", comes: "come",
  christ: "jesus", lord: "jesus", savior: "jesus", saviour: "jesus",
  holyspirit: "spirit", spiritofgod: "spirit",
  children: "child", people: "person", persons: "person",
  receive: "get", receives: "get", received: "get",
  give: "give", gives: "give", gave: "give",
  speak: "say", spoke: "say", says: "say", said: "say",
  tells: "tell", told: "tell",
  must: "need", needs: "need", needed: "need",
  cannot: "cant", cannt: "cant",
}));
const semanticStopWords = new Set("a an the this that these those is are was were be been being of to for from with by at on in into and but or so then also now still yet because though as it its he she they we you i me my your our their his her do does did have has had will would shall should can could may might".split(" "));
const closingAdditionPhrases = [
  /^amen(?:\s+amen)?$/,
  /^amen\s+god\s+bless(?:\s+you|\s+all|\s+everyone)?$/,
  /^god\s+bless(?:\s+you|\s+all|\s+everyone)?$/,
  /^god\s+bless\s+you\s+all$/,
  /^blessings(?:\s+to\s+you)?$/,
  /^thank\s+you(?:\s+for\s+watching)?$/,
];
const meaningChangingWords = new Set(
  "not never no nobody nothing neither without except only unless instead wrong false".split(" "),
);
const rawNormalize = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "");

const CONTRACTIONS = new Map([
  ["i'm", ["i", "am"]],
  ["i've", ["i", "have"]],
  ["i'll", ["i", "will"]],
  ["i'd", ["i", "would"]],
  ["you're", ["you", "are"]],
  ["you've", ["you", "have"]],
  ["you'll", ["you", "will"]],
  ["you'd", ["you", "would"]],
  ["we're", ["we", "are"]],
  ["we've", ["we", "have"]],
  ["we'll", ["we", "will"]],
  ["we'd", ["we", "would"]],
  ["they're", ["they", "are"]],
  ["they've", ["they", "have"]],
  ["they'll", ["they", "will"]],
  ["they'd", ["they", "would"]],
  ["that's", ["that", "is"]],
  ["there's", ["there", "is"]],
  ["here's", ["here", "is"]],
  ["what's", ["what", "is"]],
  ["who's", ["who", "is"]],
  ["where's", ["where", "is"]],
  ["how's", ["how", "is"]],
  ["he's", ["he", "is"]],
  ["she's", ["she", "is"]],
  ["it's", ["it", "is"]],
  ["let's", ["let", "us"]],
  ["isn't", ["is", "not"]],
  ["aren't", ["are", "not"]],
  ["wasn't", ["was", "not"]],
  ["weren't", ["were", "not"]],
  ["don't", ["do", "not"]],
  ["doesn't", ["does", "not"]],
  ["didn't", ["did", "not"]],
  ["can't", ["can", "not"]],
  ["couldn't", ["could", "not"]],
  ["won't", ["will", "not"]],
  ["wouldn't", ["would", "not"]],
  ["shouldn't", ["should", "not"]],
  ["haven't", ["have", "not"]],
  ["hasn't", ["has", "not"]],
  ["hadn't", ["had", "not"]],
]);

const STRIPPED_CONTRACTIONS = new Map(
  [...CONTRACTIONS.entries()]
    .map(([form, parts]) => [form.replace(/'/g, ""), parts])
    .filter(([form]) =>
      !["were", "well", "wed", "ill", "id", "its", "cant", "lets", "hell", "shed"].includes(form),
    ),
);

export function normalizeWord(text) {
  const raw = rawNormalize(text);
  if (!raw) return "";
  if (numberWords.has(raw)) return numberWords.get(raw);
  if (/^\d+(?:st|nd|rd|th)$/i.test(raw))
    return raw.replace(/(?:st|nd|rd|th)$/i, "");
  return equivalents.get(raw) || raw.replace(/'/g, "");
}

export function contractionParts(word) {
  if (!word) return null;
  if (Array.isArray(word.expansion) && word.expansion.length >= 2) return word.expansion;
  const raw = rawNormalize(word.display || "");
  if (CONTRACTIONS.has(raw)) return CONTRACTIONS.get(raw);
  if (/'/.test(raw)) {
    const stripped = raw.replace(/'/g, "");
    return STRIPPED_CONTRACTIONS.get(stripped) || CONTRACTIONS.get(stripped) || null;
  }
  return STRIPPED_CONTRACTIONS.get(word.norm) || null;
}

function comparisonStem(value) {
  const word = String(value || "");
  if (word.length <= 4 || /^\d/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4)
    return word.slice(0, -1);
  return word;
}

function displayWords(text) {
  const output = [];
  let prefix = "";
  for (const token of String(text || "").match(wordPattern) || []) {
    const norm = normalizeWord(token);
    if (norm) {
      const item = { display: `${prefix}${token}`, norm };
      const expansion = contractionParts(item);
      if (expansion) item.expansion = expansion;
      output.push(item);
      prefix = "";
    } else if (/^[\"“‘(\[]$/.test(token)) prefix += token;
    else if (output.length) output.at(-1).display += token;
  }
  const merged = [];
  for (let index = 0; index < output.length; index += 1) {
    const current = { ...output[index] };
    const next = output[index + 1];
    const currentNumber = Number(current.norm);
    const nextNumber = Number(next?.norm);
    if (
      [20, 30, 40, 50, 60, 70, 80, 90].includes(currentNumber) &&
      nextNumber >= 1 &&
      nextNumber <= 9
    ) {
      current.display += ` ${next.display}`;
      current.norm = String(currentNumber + nextNumber);
      index += 1;
    }
    merged.push(current);
  }
  for (let index = 0; index < merged.length - 1; index += 1) {
    const current = merged[index],
      next = merged[index + 1];
    if (/^\d+:$/.test(current.display) && /^\d+$/.test(next.norm)) {
      current.display = current.display.replace(/:$/, "");
      next.display = `:${next.display}`;
      current.scriptureReference = true;
      next.scriptureReference = true;
      current.keepWithPrevious = true;
      next.keepWithPrevious = true;
    }
  }
  for (let index = 0; index < merged.length; index += 1) {
    const current = merged[index],
      previous = merged[index - 1],
      previousPrevious = merged[index - 2];
    if (
      bibleBooks.has(current.norm) &&
      previous &&
      /^[123]$/.test(previous.norm)
    )
      current.keepWithPrevious = true;
    if (
      current.scriptureReference &&
      previous &&
      (bibleBooks.has(previous.norm) ||
        (previousPrevious && bibleBooks.has(previousPrevious.norm)))
    )
      current.keepWithPrevious = true;
  }
  return merged;
}

export function transcriptWords(segments) {
  const words = [];
  for (const segment of segments || []) {
    const tokens = displayWords(segment.text);
    const start = Number(segment.start || 0);
    const end = Math.max(start + 0.04, Number(segment.end || start + 0.04));
    tokens.forEach((token, index) =>
      words.push({
        display: token.display,
        norm: token.norm,
        expansion: token.expansion,
        keepWithPrevious: !!token.keepWithPrevious,
        scriptureReference: !!token.scriptureReference,
        start: start + ((end - start) * index) / Math.max(1, tokens.length),
        end: start + ((end - start) * (index + 1)) / Math.max(1, tokens.length),
      }),
    );
  }
  return words;
}

function markStrictScriptWords(words = []) {
  let pendingGodQuote = false;
  let pendingScriptureQuote = false;
  let inStrictQuote = false;
  let quoteStartedAt = -1;
  const recent = [];
  const hasOpenQuote = (display) => /[“"]/u.test(String(display || ""));
  const hasCloseQuote = (display) => /[”]/u.test(String(display || ""));
  const straightQuotes = (display) => (String(display || "").match(/"/g) || []).length;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    recent.push(word.norm);
    if (recent.length > 5) recent.shift();
    if ((word.norm === "say" || word.norm === "said") && recent.slice(0, -1).includes("god")) pendingGodQuote = true;
    if (word.scriptureReference) pendingScriptureQuote = true;
    const opens = hasOpenQuote(word.display);
    const straight = straightQuotes(word.display);
    // displayWords attaches a straight closing quote to the next token.  Close
    // the strict region before that next token is marked.
    if (inStrictQuote && straight > 0 && index > quoteStartedAt) {
      inStrictQuote = false; quoteStartedAt = -1;
    }
    if (!inStrictQuote && (pendingGodQuote || pendingScriptureQuote) && (opens || straight > 0)) {
      inStrictQuote = true; quoteStartedAt = index; pendingGodQuote = false; pendingScriptureQuote = false;
    }
    if (inStrictQuote) {
      word.strict = true;
      word.scripture = true;
    }
    const closesCurly = hasCloseQuote(word.display);
    const closesStraight = inStrictQuote && straight >= 2;
    if (inStrictQuote && (closesCurly || closesStraight)) { inStrictQuote = false; quoteStartedAt = -1; }
    if (pendingGodQuote && recent.length >= 5 && !recent.includes("god")) pendingGodQuote = false;
  }
  return words;
}

export function scriptWords(script) {
  const words = markStrictScriptWords(displayWords(script));
  // Clock times are commonly spoken without “:00” or AM/PM (for example,
  // “8 to 10”).  Collapse only exact-hour clock notation into one alignment
  // unit while preserving the manuscript display verbatim.  Scripture such as
  // Matthew 24:36 is deliberately untouched.
  const collapsed = [];
  for (let index = 0; index < words.length; index += 1) {
    const hour = words[index],
      minutes = words[index + 1],
      meridiem = words[index + 2];
    if (
      /^\d{1,2}$/.test(hour?.display || "") &&
      /^:00$/.test(minutes?.display || "") &&
      /^(?:am|pm)$/.test(meridiem?.norm || "")
    ) {
      collapsed.push({
        ...hour,
        display: `${hour.display}${minutes.display} ${meridiem.display}`,
        norm: String(Number(hour.norm)),
        clockTime: true,
      });
      index += 2;
      continue;
    }
    collapsed.push(hour);
  }
  return collapsed;
}

export function endsCaptionSentence(display) {
  const text = String(display || "").trim();
  if (!/[.!?…]/.test(text)) return false;
  return /[.!?…][\"”’')\]]*$/.test(text);
}

export function captionLineCharLimit(mode, lineChars = 34) {
  const chars = Math.max(12, Number(lineChars) || 34);
  const limit = captionWrapLineLimit(mode);
  return chars * limit;
}

export function flattenCaptionWords(captions = []) {
  const words = [];
  for (const caption of captions || []) {
    if (Array.isArray(caption.words) && caption.words.length) {
      for (const word of caption.words) {
        const display = String(word?.display || "").trim();
        if (!display) continue;
        words.push({
          display,
          start: Number(word.start ?? caption.start ?? 0),
          end: Math.max(
            Number(word.start ?? caption.start ?? 0) + 0.04,
            Number(word.end ?? caption.end ?? 0),
          ),
          matchType: word.matchType || "",
          issueType: word.issueType || "",
          expectedDisplay: word.expectedDisplay || "",
          issueId: word.issueId || "",
          action: word.action || "",
          keepWithPrevious: !!word.keepWithPrevious,
        });
      }
      continue;
    }
    const tokens = String(caption?.text || "").split(/\s+/).filter(Boolean);
    const start = Number(caption?.start || 0);
    const end = Math.max(start + 0.04, Number(caption?.end || start));
    tokens.forEach((display, index) => {
      words.push({
        display,
        start: start + ((end - start) * index) / Math.max(1, tokens.length),
        end: start + ((end - start) * (index + 1)) / Math.max(1, tokens.length),
      });
    });
  }
  return words;
}

function captionWordRecord(word) {
  return {
    display: word.display,
    start: word.start,
    end: word.end,
    matchType: word.matchType || "match",
    issueType: word.issueType || "",
    expectedDisplay: word.expectedDisplay || "",
    issueId: word.issueId || "",
    action: word.action || "",
    keepWithPrevious: !!word.keepWithPrevious,
  };
}

function captionFromGroup(group, style, maxWidth, scale) {
  const packed = packWordsIntoLines(group, style, maxWidth, scale);
  return {
    id: crypto.randomUUID(),
    start: group[0].start,
    end: Math.max(Number(group.at(-1).end), Number(group[0].start) + 0.04),
    text: formatDisplayWords(group),
    words: group.map(captionWordRecord),
    lineBreaks: packed.slice(1).map((line) => line.startIndex),
    lineCount: packed.length,
  };
}

export function regroupCaptions(words, options = {}) {
  const style = options.style || {};
  const scale = Math.max(0.2, Number(options.scale || 1));
  const maxLines = captionWrapLineLimit(options.captionLines ?? options.maxLines ?? 2);
  const requestedWidth = Number(options.maxWidth || options.boxWidth);
  const useWidth = Number.isFinite(requestedWidth) && requestedWidth > 0;
  const maxWidth = useWidth ? captionSafeBoxWidth(options) : 860;
  const fallbackChars = Math.max(
    12,
    Number(options.maxChars || captionLineCharLimit(options.captionLines ?? options.maxLines, options.lineChars)),
  );
  const linesNeeded = (group) => {
    if (!group.length) return 0;
    if (useWidth) return packWordsIntoLines(group, style, maxWidth, scale).length;
    const text = formatDisplayWords(group);
    return Math.max(1, Math.ceil(text.length / Math.max(12, fallbackChars / maxLines)));
  };
  const captions = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    captions.push(captionFromGroup(group, style, maxWidth, scale));
    group = [];
  };
  for (const word of words || []) {
    const display = String(word?.display || "").trim();
    if (!display) continue;
    const start = Number(word.start || 0);
    const end = Math.max(start + 0.04, Number(word.end || start));
    const item = { ...word, display, start, end };
    const prior = group.at(-1);
    if (group.length && !item.keepWithPrevious && endsCaptionSentence(prior?.display)) {
      flush();
    } else if (group.length && !item.keepWithPrevious && linesNeeded([...group, item]) > maxLines) {
      flush();
    }
    group.push(item);
  }
  flush();
  for (let index = 0; index < captions.length; index += 1) {
    const caption = captions[index];
    if (caption.words.length >= 2) continue;
    const previous = captions[index - 1];
    if (!previous || endsCaptionSentence(previous.words.at(-1)?.display)) continue;
    const mergedWords = [...previous.words, ...caption.words];
    if (linesNeeded(mergedWords) > maxLines) continue;
    captions.splice(index - 1, 2, captionFromGroup(mergedWords, style, maxWidth, scale));
    index -= 1;
  }
  for (let index = 0; index < captions.length - 1; index += 1) {
    const nextStart = Number(captions[index + 1].start);
    if (Number(captions[index].end) > nextStart) {
      captions[index].end = nextStart;
    }
  }
  return captions;
}

export function regroupProjectCaptions(captions = [], options = {}) {
  const words = flattenCaptionWords(captions);
  if (!words.length) return Array.isArray(captions) ? captions : [];
  return regroupCaptions(words, options);
}

export function formatDisplayWords(words = []) {
  return words
    .map((word) => word?.display || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([\-–—])\s+(?=\d)/g, "$1");
}

function characterSimilarity(left, right) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous.splice(0, previous.length, ...current);
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function partMatchesWord(word, part) {
  if (!word || !part) return false;
  if (word.norm === part) return true;
  if (comparisonStem(word.norm) === comparisonStem(part)) return true;
  const parts = contractionParts(word);
  return parts?.[0] === part;
}

function contractionPairQuality(parts, first, second) {
  if (!parts || parts.length !== 2 || !first || !second) return "";
  const firstExact = first.norm === parts[0];
  const secondExact = second.norm === parts[1];
  if (firstExact && secondExact) return "match";
  if (partMatchesWord(first, parts[0]) && partMatchesWord(second, parts[1])) return "near";
  return "";
}

function mergeSpokenWords(first, second) {
  return {
    ...first,
    display: `${first.display} ${second.display}`,
    start: Number(first.start || 0),
    end: Math.max(Number(first.end || 0), Number(second.end || 0)),
    mergedFrom: [first, second],
  };
}

function splitSpokenWord(spoken, index, count = 2) {
  const start = Number(spoken.start || 0);
  const end = Math.max(start + 0.04, Number(spoken.end || start + 0.04));
  const span = (end - start) / count;
  return {
    ...spoken,
    start: start + span * index,
    end: start + span * (index + 1),
  };
}

function takeContractionOperations(expected, spoken, expectedIndex, spokenIndex) {
  const expectedWord = expected[expectedIndex];
  const spokenWord = spoken[spokenIndex];
  const expectedParts = contractionParts(expectedWord);
  const spokenNext = spoken[spokenIndex + 1];
  const expectedPair = contractionPairQuality(expectedParts, spokenWord, spokenNext);
  if (expectedPair) {
    return {
      expectedDelta: 1,
      spokenDelta: 2,
      operations: [
        {
          type: expectedPair,
          relation: expectedPair,
          expected: expectedWord,
          spoken: mergeSpokenWords(spokenWord, spokenNext),
          contraction: true,
        },
      ],
    };
  }
  const spokenParts = contractionParts(spokenWord);
  const expectedNext = expected[expectedIndex + 1];
  const spokenPair = contractionPairQuality(spokenParts, expectedWord, expectedNext);
  if (spokenPair) {
    return {
      expectedDelta: 2,
      spokenDelta: 1,
      operations: [
        {
          type: spokenPair,
          relation: spokenPair,
          expected: expectedWord,
          spoken: splitSpokenWord(spokenWord, 0),
          contraction: true,
        },
        {
          type: spokenPair,
          relation: spokenPair,
          expected: expectedNext,
          spoken: splitSpokenWord(spokenWord, 1),
          contraction: true,
        },
      ],
    };
  }
  return null;
}

function wordRelation(expected, spoken) {
  if (expected.norm === spoken.norm) return "match";
  const expectedStem = comparisonStem(expected.norm),
    spokenStem = comparisonStem(spoken.norm);
  // ASR frequently drops plural/possessive endings or produces spelling variants
  // (love/loves, worshipper/worshiper).  Even inside strict Scripture regions
  // those are recognition variants, not evidence that the speaker changed the text.
  if (expectedStem && expectedStem === spokenStem) return "near";
  const similarity = Math.max(
    characterSimilarity(expected.norm, spoken.norm),
    characterSimilarity(expectedStem, spokenStem),
  );
  if (expected?.strict) return similarity >= 0.86 ? "near" : "mismatch";
  if (
    similarity >= 0.8 ||
    (Math.min(expected.norm.length, spoken.norm.length) >= 5 &&
      similarity >= 0.72)
  )
    return "near";
  return "mismatch";
}

function localAlignment(expected, spoken) {
  const rows = expected.length + 1;
  const columns = spoken.length + 1;
  const costs = Array.from({ length: rows }, () => new Float64Array(columns));
  const steps = Array.from({ length: rows }, () => new Uint8Array(columns));
  for (let i = 1; i < rows; i += 1) {
    costs[i][0] = i;
    steps[i][0] = 1;
  }
  for (let j = 1; j < columns; j += 1) {
    costs[0][j] = j;
    steps[0][j] = 2;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const relation = wordRelation(expected[i - 1], spoken[j - 1]);
      const choices = [
        costs[i - 1][j - 1] +
          (relation === "match" ? 0 : relation === "near" ? 0.18 : 1.35),
        costs[i - 1][j] + 1,
        costs[i][j - 1] + 1,
      ];
      let best = Math.min(...choices);
      let step = choices.indexOf(best);
      if (j >= 2) {
        const expectedPair = contractionPairQuality(
          contractionParts(expected[i - 1]),
          spoken[j - 2],
          spoken[j - 1],
        );
        if (expectedPair) {
          const cost = costs[i - 1][j - 2] + (expectedPair === "match" ? 0 : 0.18);
          if (cost < best - 0.001) {
            best = cost;
            step = 3;
          }
        }
      }
      if (i >= 2) {
        const spokenPair = contractionPairQuality(
          contractionParts(spoken[j - 1]),
          expected[i - 2],
          expected[i - 1],
        );
        if (spokenPair) {
          const cost = costs[i - 2][j - 1] + (spokenPair === "match" ? 0 : 0.18);
          if (cost < best - 0.001) {
            best = cost;
            step = 4;
          }
        }
      }
      costs[i][j] = best;
      steps[i][j] = step;
    }
  }
  const operations = [];
  let i = expected.length;
  let j = spoken.length;
  while (i || j) {
    const step = steps[i][j];
    if (i && j && step === 3 && j >= 2) {
      const pair = contractionPairQuality(
        contractionParts(expected[i - 1]),
        spoken[j - 2],
        spoken[j - 1],
      ) || "match";
      operations.push({
        type: pair,
        relation: pair,
        expected: expected[--i],
        spoken: mergeSpokenWords(spoken[j - 2], spoken[j - 1]),
        contraction: true,
      });
      j -= 2;
    } else if (i >= 2 && j && step === 4) {
      const pair = contractionPairQuality(
        contractionParts(spoken[j - 1]),
        expected[i - 2],
        expected[i - 1],
      ) || "match";
      const spokenWord = spoken[--j];
      operations.push({
        type: pair,
        relation: pair,
        expected: expected[--i],
        spoken: splitSpokenWord(spokenWord, 1),
        contraction: true,
      });
      operations.push({
        type: pair,
        relation: pair,
        expected: expected[--i],
        spoken: splitSpokenWord(spokenWord, 0),
        contraction: true,
      });
    } else if (i && j && step === 0) {
      const relation = wordRelation(expected[i - 1], spoken[j - 1]);
      operations.push({
        type:
          relation === "mismatch"
            ? "mismatch"
            : relation === "near"
              ? "near"
              : "match",
        relation,
        expected: expected[--i],
        spoken: spoken[--j],
      });
    } else if (i && (j === 0 || step === 1))
      operations.push({ type: "missing", expected: expected[--i] });
    else operations.push({ type: "extra", spoken: spoken[--j] });
  }
  return operations.reverse();
}

/*
 * Alignment must recover after every local reading error.  Building one
 * global chain of anchors is unsafe for sermons and Bible quotations because
 * phrases such as "the Lord" and "for they shall" occur repeatedly.  A
 * single wrong global anchor can shift the rest of the manuscript.
 *
 * Instead we move forward monotonically.  At the first disagreement we look
 * only ahead of the current cursors for the nearest reliable 2-6 word phrase,
 * align the small gap before it, lock that phrase, and start again.  Thus every
 * reliable phrase is a fresh synchronization point and an error can never
 * consume the rest of the recording.
 */
function anchorCandidate(expected, spoken, expectedIndex, spokenIndex, length) {
  let exact = 0;
  let near = 0;
  for (let offset = 0; offset < length; offset += 1) {
    const relation = wordRelation(
      expected[expectedIndex + offset],
      spoken[spokenIndex + offset],
    );
    if (relation === "mismatch") return null;
    if (relation === "match") exact += 1;
    else near += 1;
  }
  // Two-word anchors must be exact. Longer anchors may contain conservative
  // ASR spelling/inflection differences, but the majority must still match.
  if (length === 2 && exact !== 2) return null;
  if (length >= 3 && exact < Math.ceil(length * 0.6)) return null;
  return { exact, near };
}

function findResyncAnchor(expected, spoken, expectedCursor, spokenCursor) {
  const remainingExpected = expected.length - expectedCursor;
  const remainingSpoken = spoken.length - spokenCursor;
  if (remainingExpected < 2 || remainingSpoken < 2) return null;
  const horizons = [12, 32, 80, 180, 420];
  for (const horizon of horizons) {
    const expectedLimit = Math.min(remainingExpected - 1, horizon);
    const spokenLimit = Math.min(remainingSpoken - 1, horizon);
    let best = null;
    for (let expectedDelta = 0; expectedDelta <= expectedLimit; expectedDelta += 1) {
      for (let spokenDelta = 0; spokenDelta <= spokenLimit; spokenDelta += 1) {
        if (expectedDelta === 0 && spokenDelta === 0) continue;
        const maximum = Math.min(
          6,
          remainingExpected - expectedDelta,
          remainingSpoken - spokenDelta,
        );
        for (let length = maximum; length >= 2; length -= 1) {
          const confidence = anchorCandidate(
            expected,
            spoken,
            expectedCursor + expectedDelta,
            spokenCursor + spokenDelta,
            length,
          );
          if (!confidence) continue;
          const distance = expectedDelta + spokenDelta;
          const imbalance = Math.abs(expectedDelta - spokenDelta);
          // Prefer the nearest trustworthy phrase.  A long but distant
          // repeated phrase must never win merely because it has more words;
          // that was the source of the “one error makes the whole tail wrong”
          // failure on sermons and repeated Bible quotations.
          const score =
            length * 6 +
            confidence.exact * 3 +
            confidence.near -
            distance * 2.4 -
            imbalance * 1.8;
          if (
            !best ||
            score > best.score + 0.001 ||
            (Math.abs(score - best.score) < 0.001 && distance < best.distance)
          )
            best = {
              expectedIndex: expectedCursor + expectedDelta,
              spokenIndex: spokenCursor + spokenDelta,
              length,
              score,
              distance,
            };
          break;
        }
      }
    }
    if (best) return best;
  }

  // Last-resort anchor: a unique long word or number.  This rescues a long
  // wrong paragraph without using common one-word anchors that could jump to
  // the wrong repeated verse.
  const expectedPositions = new Map();
  const spokenPositions = new Map();
  for (let index = expectedCursor; index < expected.length; index += 1) {
    const norm = expected[index].norm;
    if (norm.length < 7 && !/^\d+$/.test(norm)) continue;
    const values = expectedPositions.get(norm) || [];
    values.push(index);
    expectedPositions.set(norm, values);
  }
  for (let index = spokenCursor; index < spoken.length; index += 1) {
    const norm = spoken[index].norm;
    if (norm.length < 7 && !/^\d+$/.test(norm)) continue;
    const values = spokenPositions.get(norm) || [];
    values.push(index);
    spokenPositions.set(norm, values);
  }
  let single = null;
  for (const [norm, expectedIndexes] of expectedPositions) {
    const spokenIndexes = spokenPositions.get(norm);
    if (expectedIndexes.length !== 1 || spokenIndexes?.length !== 1) continue;
    const candidate = {
      expectedIndex: expectedIndexes[0],
      spokenIndex: spokenIndexes[0],
      length: 1,
    };
    const distance =
      candidate.expectedIndex - expectedCursor +
      candidate.spokenIndex - spokenCursor;
    if (!single || distance < single.distance) single = { ...candidate, distance };
  }
  return single;
}

function anchoredAlignment(expected, spoken) {
  const operations = [];
  let expectedCursor = 0;
  let spokenCursor = 0;
  while (expectedCursor < expected.length && spokenCursor < spoken.length) {
    const contracted = takeContractionOperations(
      expected,
      spoken,
      expectedCursor,
      spokenCursor,
    );
    if (contracted) {
      operations.push(...contracted.operations);
      expectedCursor += contracted.expectedDelta;
      spokenCursor += contracted.spokenDelta;
      continue;
    }
    const relation = wordRelation(
      expected[expectedCursor],
      spoken[spokenCursor],
    );
    if (relation !== "mismatch") {
      operations.push({
        type: relation,
        relation,
        expected: expected[expectedCursor],
        spoken: spoken[spokenCursor],
      });
      expectedCursor += 1;
      spokenCursor += 1;
      continue;
    }
    const anchor = findResyncAnchor(
      expected,
      spoken,
      expectedCursor,
      spokenCursor,
    );
    if (!anchor) break;
    operations.push(
      ...localAlignment(
        expected.slice(expectedCursor, anchor.expectedIndex),
        spoken.slice(spokenCursor, anchor.spokenIndex),
      ),
    );
    for (let offset = 0; offset < anchor.length; offset += 1) {
      const expectedWord = expected[anchor.expectedIndex + offset];
      const spokenWord = spoken[anchor.spokenIndex + offset];
      const anchorRelation = wordRelation(expectedWord, spokenWord);
      operations.push({
        type: anchorRelation,
        relation: anchorRelation,
        expected: expectedWord,
        spoken: spokenWord,
        anchor: true,
      });
    }
    expectedCursor = anchor.expectedIndex + anchor.length;
    spokenCursor = anchor.spokenIndex + anchor.length;
  }
  operations.push(
    ...localAlignment(expected.slice(expectedCursor), spoken.slice(spokenCursor)),
  );
  return operations;
}

function semanticPhraseSimilarity(expectedGroup = [], spokenGroup = []) {
  if (!expectedGroup.length || !spokenGroup.length) return 0;
  if (expectedGroup.some((word) => word.strict)) return 0;
  const canon = (word) => semanticCanonical.get(comparisonStem(word.norm)) || comparisonStem(word.norm);
  const expectedAll = expectedGroup.map(canon).filter(Boolean);
  const spokenAll = spokenGroup.map(canon).filter(Boolean);
  const expected = expectedAll.filter((word) => !semanticStopWords.has(word));
  const spoken = spokenAll.filter((word) => !semanticStopWords.has(word));
  if (!expected.length && !spoken.length && expectedAll.length <= 3 && spokenAll.length <= 3) return 0.9;
  if (!expected.length || !spoken.length) return 0;
  const expectedNeg = expectedGroup.some((word) => meaningChangingWords.has(word.norm));
  const spokenNeg = spokenGroup.some((word) => meaningChangingWords.has(word.norm));
  if (expectedNeg !== spokenNeg) return 0;
  const a = new Set(expected), b = new Set(spoken);
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  const coverage = intersection / Math.max(1, Math.max(a.size, b.size));
  const lengthBalance = Math.min(expected.length, spoken.length) / Math.max(expected.length, spoken.length);
  return coverage * 0.78 + lengthBalance * 0.22;
}

function issueLabel(type) {
  return (
    {
      repeat: "重复阅读",
      mismatch: "读错或不匹配",
      near: "文字相近，请确认",
      extra: "多读内容",
      addition: "口语补充，原意不变",
      missing: "漏读内容",
      uncertain: "需要确认",
      semantic: "同义表达，原意不变",
    }[type] || type
  );
}

function issueIsMajor(type, spokenGroup, expectedGroup) {
  if (type === "repeat") return spokenGroup.length >= 1;
  if (type === "near") return true;
  if (type === "mismatch") return true;
  if (type === "missing" || type === "extra") return true;
  return true;
}

function acceptedOperation(operation) {
  return !!operation?.spoken && !!operation?.expected && ["match", "near"].includes(operation.type);
}

function nearbyAccepted(operations, index, direction, distance = 3) {
  for (let step = 1; step <= distance; step += 1) {
    const operation = operations[index + direction * step];
    if (!operation) break;
    if (acceptedOperation(operation)) return operation;
    if (operation.spoken && operation.expected && operation.type === "mismatch") break;
  }
  return null;
}

function manuscriptProxyWord(expected, start, end) {
  const a = Math.max(0, Number(start || 0));
  const b = Math.max(a + 0.04, Number(end || a + 0.04));
  return {
    display: expected.display,
    norm: expected.norm,
    keepWithPrevious: !!expected.keepWithPrevious,
    scriptureReference: !!expected.scriptureReference,
    start: a,
    end: b,
    recoveredFromManuscript: true,
  };
}

/*
 * Manuscript-first recovery. Whisper is used to locate speech, not to rewrite
 * the supplied manuscript. A single ASR substitution/omission surrounded by
 * reliable anchors is far more likely to be recognition noise than a genuine
 * reading error. Recover those tokens from the manuscript before issue
 * grouping so they receive captions and cannot falsely block Scripture export.
 *
 * Genuine errors remain detectable: multi-word disagreements, unbounded
 * unrelated speech, negation changes and repeated passages are not repaired.
 */
function recoverManuscriptFirstASR(operations) {
  const original = operations.map((operation) => ({ ...operation }));
  const output = operations.map((operation) => ({ ...operation }));

  // 1) Conservative *isolated* one-word substitutions. Never let repairing one
  // token turn the next token in a genuinely wrong phrase into another repair.
  // Neighbour evidence is therefore read from the untouched original alignment.
  for (let index = 0; index < output.length; index += 1) {
    const operation = output[index];
    const sourceOperation = original[index];
    if (sourceOperation.type !== "mismatch" || !operation.expected || !operation.spoken) continue;
    const adjacentError = [original[index - 1], original[index + 1]].some((item) =>
      item && ["mismatch", "missing", "extra"].includes(item.type)
    );
    const nearbyStrictDisagreement = !!operation.expected?.strict && original
      .slice(Math.max(0, index - 3), index + 4)
      .some((item, offset) => {
        const absolute = Math.max(0, index - 3) + offset;
        return absolute !== index && ["mismatch", "missing"].includes(item?.type) && item?.expected?.strict;
      });
    if (adjacentError || nearbyStrictDisagreement) continue;
    const before = nearbyAccepted(original, index, -1);
    const after = nearbyAccepted(original, index, 1);
    const similarity = characterSimilarity(operation.expected.norm, operation.spoken.norm);
    const expectedNeg = meaningChangingWords.has(operation.expected.norm);
    const spokenNeg = meaningChangingWords.has(operation.spoken.norm);
    const bounded = !!before && !!after && similarity >= 0.55;
    const oneSidedStrong = (!!before || !!after) && similarity >= 0.68;
    if (expectedNeg !== spokenNeg) continue;
    if (bounded || oneSidedStrong) {
      operation.type = "near";
      operation.relation = "near";
      operation.manuscriptRecovered = true;
    }
  }

  // 2) One or two consecutive omitted manuscript tokens between reliable
  // anchors. ASR occasionally returns no token at all ("surely" -> —). Do not
  // interpret silence in the transcript as proof that the speaker omitted it.
  let cursor = 0;
  while (cursor < output.length) {
    if (output[cursor].type !== "missing" || !output[cursor].expected) { cursor += 1; continue; }
    const start = cursor;
    while (cursor < output.length && output[cursor].type === "missing" && output[cursor].expected) cursor += 1;
    const run = output.slice(start, cursor);
    if (run.length > 2) continue;
    const before = nearbyAccepted(output, start, -1, 2);
    const after = nearbyAccepted(output, cursor - 1, 1, 2);
    if (!before || !after) continue;
    const left = Number(before.spoken.end || before.spoken.start || 0);
    const right = Number(after.spoken.start || after.spoken.end || left + 0.12);
    const span = Math.max(0.08 * run.length, right - left);
    const base = right > left ? left : Math.max(0, (left + right) / 2 - span / 2);
    for (let offset = 0; offset < run.length; offset += 1) {
      const operation = output[start + offset];
      const a = base + (span * offset) / run.length;
      const b = base + (span * (offset + 1)) / run.length;
      operation.spoken = manuscriptProxyWord(operation.expected, a, b);
      operation.type = "near";
      operation.relation = "near";
      operation.manuscriptRecovered = true;
    }
  }
  return output;
}


function phraseWordList(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function looksLikeRestart(phrase, before) {
  const extra = phraseWordList(phrase);
  const prev = phraseWordList(before);
  if (extra.length < 2 || prev.length < 2) return false;
  const extraText = extra.join(" ");
  const prevText = prev.join(" ");
  if (prevText.endsWith(extraText) || extraText.endsWith(prevText) || prevText.startsWith(extraText))
    return true;
  for (let count = Math.min(4, extra.length, prev.length); count >= 2; count -= 1) {
    const tail = prev.slice(-count).join(" ");
    const head = extra.slice(0, count).join(" ");
    if (tail && (tail === head || extraText.startsWith(`${tail} `) || extraText.endsWith(` ${tail}`)))
      return true;
  }
  return false;
}

function rematchPrefixFalseStarts(operations = []) {
  for (let index = 0; index < operations.length; index += 1) {
    if (!["match", "near"].includes(operations[index].type) || !operations[index].expected)
      continue;
    if (index > 0) {
      const previousDisplay = String(
        operations[index - 1]?.expected?.display || operations[index - 1]?.spoken?.display || "",
      );
      if (!/[.!?…:,—\-]["'”’)]*$/.test(previousDisplay.trim())) continue;
    }
    let prefixEnd = index;
    while (
      prefixEnd < operations.length &&
      ["match", "near"].includes(operations[prefixEnd].type) &&
      operations[prefixEnd].expected &&
      operations[prefixEnd].spoken
    )
      prefixEnd += 1;
    const prefix = operations.slice(index, prefixEnd);
    if (prefix.length < 2) continue;
    const extras = [];
    let cursor = prefixEnd;
    while (
      cursor < operations.length &&
      ["extra", "filler", "mismatch"].includes(operations[cursor].type) &&
      operations[cursor].spoken
    ) {
      extras.push(operations[cursor]);
      cursor += 1;
    }
    if (extras.length < 2) continue;
    const prefixNorms = prefix.map((item) => item.expected.norm);
    const extraNorms = extras.map((item) => item.spoken.norm);
    let extraAt = -1;
    for (
      let offset = 0;
      offset <= Math.min(24, extraNorms.length - prefixNorms.length);
      offset += 1
    ) {
      if (prefixNorms.every((norm, pos) => extraNorms[offset + pos] === norm)) {
        extraAt = offset;
        break;
      }
    }
    if (extraAt < 0) continue;
    for (let pos = 0; pos < prefix.length; pos += 1) {
      const later = extras[extraAt + pos];
      const earlier = prefix[pos];
      if (earlier.expected && later.spoken) {
        earlier.expected.start = later.spoken.start;
        earlier.expected.end = later.spoken.end;
        earlier.expected.matchType = "match";
      }
      later.type = "match";
      later.relation = "match";
      later.expected = earlier.expected || { ...earlier.expected };
      later.issueType = "";
      later.issueId = "";
      later.action = "";
      earlier.type = "extra";
      earlier.relation = "extra";
      earlier.expected = null;
      earlier.action = "cut";
      earlier.issueType = "repeat";
    }
    for (let pos = 0; pos < extraAt; pos += 1) {
      extras[pos].type = "extra";
      extras[pos].relation = "extra";
      extras[pos].expected = null;
      extras[pos].action = "cut";
      extras[pos].issueType = "repeat";
    }
  }
  return operations;
}

function looksLikeAbandonedPrefix(phrase, after) {
  const extra = phraseWordList(phrase);
  const next = phraseWordList(after);
  if (extra.length < 2 || next.length < 2) return false;
  if (extra.slice(0, 2).join(" ") !== next.slice(0, 2).join(" ")) return false;
  return true;
}

function sentenceContinues(display) {
  return !/[.!?…]["'”’)]*$/.test(String(display || "").trim());
}

function isBreathLeadWord(word) {
  return /^(here|there|now|so|and|but|or|not|just|the|a|an|this|that|these|those|we|i|you|it|he|she|they|if|when|then|for)$/i.test(
    String(word?.norm || word?.display || "").replace(/[^\p{L}]/gu, ""),
  );
}

function sameSentenceMatchCount(operations, index) {
  let count = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const operation = operations[cursor];
    if (!["match", "near"].includes(operation?.type) || !operation.expected) break;
    count += 1;
    if (!sentenceContinues(operations[cursor - 1]?.expected?.display || "")) break;
  }
  return count;
}

function collectFalseStartGapIssues(operations = []) {
  const issues = [];
  let last = -1;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (
      !["match", "near"].includes(operation.type) ||
      !operation.spoken ||
      !operation.expected
    )
      continue;
    if (last >= 0) {
      const previous = operations[last];
      const between = operations.slice(last + 1, index).some(
        (item) =>
          item.type !== "filler" &&
          (item.spoken || (item.expected && item.type !== "missing")),
      );
      const gap =
        Number(operation.spoken.start || 0) - Number(previous.spoken.end || 0);
      const startedAPhrase = sameSentenceMatchCount(operations, last) >= 2;
      if (
        !between &&
        gap >= 1.15 &&
        gap <= 3.2 &&
        sentenceContinues(previous.expected.display) &&
        startedAPhrase &&
        !isBreathLeadWord(previous.expected)
      ) {
        const start = Number(previous.spoken.end || 0);
        const end = Number(operation.spoken.start || start + 0.04);
        issues.push({
          id: crypto.randomUUID(),
          type: "repeat",
          label: "没读完又重来",
          spokenText: "没读完又重读",
          expectedText: formatDisplayWords([previous.expected, operation.expected]),
          start,
          end: Math.max(start + 0.08, end),
          suggested: true,
          severity: "high",
          strict: !!(previous.expected.strict || operation.expected.strict),
          scripture: !!(previous.expected.strict || operation.expected.strict),
          confirmedCut: true,
          confirmedError: false,
          repeatKeepLater: false,
          earlierOperationIndexes: [],
          laterOperationIndexes: [],
          falseStartGap: true,
        });
      }
    }
    last = index;
  }
  return issues;
}

function joinedNorm(words = []) {
  return words.map((word) => String(word?.norm || "")).filter(Boolean).join(" ");
}

function upcomingExpectedNorms(operations = [], cursor = 0, limit = 16) {
  const words = [];
  for (let index = cursor; index < operations.length && words.length < limit; index += 1) {
    const norm = operations[index]?.expected?.norm;
    if (norm) words.push(norm);
  }
  return words;
}

function isSpokenHookForManuscript(spokenNorms = [], manuscriptNorms = []) {
  if (spokenNorms.length < 3 || spokenNorms.length > 10 || manuscriptNorms.length < 3) return false;
  const spokenSet = new Set(spokenNorms);
  for (let start = 0; start < manuscriptNorms.length - 2; start += 1) {
    for (let length = 3; length <= Math.min(5, manuscriptNorms.length - start); length += 1) {
      const window = manuscriptNorms.slice(start, start + length);
      const hit = window.filter((word) => spokenSet.has(word)).length;
      if (hit / window.length >= 0.75 && spokenNorms.length <= window.length + 6) return true;
    }
  }
  return false;
}

function confirmedMismatchEvidence(expectedGroup = [], spokenGroup = [], strict = false) {
  if (!expectedGroup.length || !spokenGroup.length) return false;
  const expected = joinedNorm(expectedGroup), spoken = joinedNorm(spokenGroup);
  const semantic = semanticPhraseSimilarity(expectedGroup, spokenGroup);
  const chars = characterSimilarity(expected.replace(/\s+/g, ""), spoken.replace(/\s+/g, ""));
  const expectedNeg = expectedGroup.some((word) => meaningChangingWords.has(word.norm));
  const spokenNeg = spokenGroup.some((word) => meaningChangingWords.has(word.norm));
  const polarityChanged = expectedNeg !== spokenNeg;
  // Normal prose is intentionally preservation-first. A cut needs extremely strong
  // evidence from BOTH semantic and textual disagreement. Single-word ASR disagreements
  // are never sufficient to remove speech automatically.
  if (!strict) {
    if (expectedGroup.length < 3 || spokenGroup.length < 3) return false;
    const clearlyOpposite = polarityChanged && semantic < 0.32 && chars < 0.42;
    const clearlyUnrelated = Math.max(expectedGroup.length, spokenGroup.length) >= 4 && semantic < 0.18 && chars < 0.30;
    return clearlyOpposite || clearlyUnrelated;
  }
  // Strict quotations/scripture still use manuscript-first recovery. Similar-sounding
  // words and isolated ASR substitutions must not stop export. Only an unrecoverable,
  // clearly unrelated substitution counts as "not matched".
  if (expectedGroup.length === 1 && spokenGroup.length === 1) {
    // A genuinely unrelated single word in strict scripture is blocking; near spellings/
    // pronunciations have already been recovered and retain a much higher character score.
    return chars < 0.30;
  }
  const clearlyOpposite = polarityChanged && semantic < 0.28 && chars < 0.40;
  const clearlyUnrelated = Math.max(expectedGroup.length, spokenGroup.length) >= 2 && semantic < 0.20 && chars < 0.32;
  return clearlyOpposite || clearlyUnrelated;
}

export function alignScript({ segments, script, duration = 0 }) {
  const spoken = transcriptWords(segments);
  const expected = scriptWords(script);
  const operations = rematchPrefixFalseStarts(
    recoverManuscriptFirstASR(anchoredAlignment(expected, spoken)),
  );
  // Short conversational fillers do not alter the manuscript meaning and
  // should not flood the review track. A conjunction such as "and" or "but"
  // is ignored only when reliable manuscript words exist on both sides.
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.type !== "extra") continue;
    const norm = operation.spoken?.norm;
    const acceptedBefore = operations
      .slice(Math.max(0, index - 3), index)
      .some((item) => ["match", "near"].includes(item.type));
    const acceptedAfter = operations
      .slice(index + 1, index + 4)
      .some((item) => ["match", "near"].includes(item.type));
    const strictNearby = operations
      .slice(Math.max(0, index - 2), index + 3)
      .some((item) => item.expected?.strict);
    if (
      !strictNearby &&
      (harmlessFillers.has(norm) ||
        (harmlessConnectors.has(norm) && acceptedBefore && acceptedAfter))
    ) operation.type = "filler";
  }
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (!["match", "near"].includes(operation.type) || !operation.expected) continue;
    const parts = contractionParts(operation.expected);
    if (!parts) continue;
    const next = operations[index + 1];
    if (next?.type === "extra" && parts.slice(1).includes(next.spoken?.norm)) {
      next.type = "filler";
    }
  }
  let lastTime = 0;
  for (const operation of operations) {
    if (operation.spoken) lastTime = operation.spoken.end;
    if (operation.expected) {
      operation.expected.start = operation.spoken?.start ?? lastTime;
      operation.expected.end = operation.spoken?.end ?? lastTime;
      operation.expected.matchType =
        operation.type === "match"
          ? "match"
          : operation.type === "near"
            ? "near"
            : "error";
    }
  }
  const issues = [];
  // Single fillers and conjunctions bounded by reliable manuscript anchors are
  // silently absorbed. They neither change the exported manuscript nor crowd
  // the pending track.
  let cursor = 0;
  while (cursor < operations.length) {
    if (["match", "near", "filler"].includes(operations[cursor].type)) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    let groupedSpoken = 0,
      groupedExpected = 0,
      firstSpokenStart = null;
    while (
      cursor < operations.length &&
      !["match", "near", "filler"].includes(operations[cursor].type)
    ) {
      const operation = operations[cursor];
      if (operation.spoken) {
        groupedSpoken += 1;
        firstSpokenStart ??= Number(operation.spoken.start || 0);
      }
      if (operation.expected) groupedExpected += 1;
      cursor += 1;
      const spokenSpan = operation.spoken && firstSpokenStart !== null
        ? Number(operation.spoken.end || firstSpokenStart) - firstSpokenStart
        : 0;
      // Review decisions stay short and timestamp-local.  Longer groups make
      // the red pending clip cover good speech and make later captions look
      // unanchored, so split at a practical phrase boundary.
      if (groupedSpoken >= 10 || groupedExpected >= 10 || spokenSpan >= 4.5)
        break;
    }
    const group = operations.slice(start, cursor);
    const spokenGroup = group.map((item) => item.spoken).filter(Boolean);
    const expectedGroup = group.map((item) => item.expected).filter(Boolean);
    let issueType =
      spokenGroup.length && expectedGroup.length
        ? group.every((item) => item.type === "near")
          ? "near"
          : "mismatch"
        : spokenGroup.length
          ? "extra"
          : "missing";
    const strictGroup = expectedGroup.some((word) => word.strict) ||
      operations.slice(Math.max(0, start - 1), cursor + 1).some((item) => item.expected?.strict);
    const semanticScore = semanticPhraseSimilarity(expectedGroup, spokenGroup);
    if (issueType === "mismatch" && !strictGroup && semanticScore >= 0.58)
      issueType = "semantic";
    let repeatKeepLater = false;
    let abandonedPrefix = false;
    let earlierOperationIndexes = [];
    if (issueType === "extra" && spokenGroup.length) {
      const phrase = spokenGroup.map((word) => word.norm).join(" ");
      const before = operations
        .slice(Math.max(0, start - Math.max(spokenGroup.length + 4, 8)), start)
        .map((item) => item.expected?.norm)
        .filter(Boolean)
        .join(" ");
      const after = operations
        .slice(cursor, cursor + Math.max(spokenGroup.length + 2, 8))
        .map((item) => item.expected?.norm)
        .filter(Boolean)
        .join(" ");
      if (looksLikeAbandonedPrefix(phrase, after)) {
        // "we're treating it" then the complete "We're treating as ordinary..."
        // is an abandoned first take. Cut it and keep the later complete sentence.
        issueType = "repeat";
        abandonedPrefix = true;
      } else if (after.startsWith(phrase) && !before.endsWith(phrase)) {
        // The manuscript itself can intentionally repeat a sentence.  In that case
        // this spoken phrase belongs to the upcoming repeated manuscript text and
        // must be preserved, not treated as an accidental re-read.
        issueType = "semantic";
      } else if (
        phraseWordList(before).join(" ").endsWith(phraseWordList(phrase).join(" ")) ||
        looksLikeRestart(phrase, before)
      ) {
        issueType = "repeat";
        const candidate = [];
        for (let opIndex = start - 1; opIndex >= 0 && candidate.length < spokenGroup.length; opIndex -= 1) {
          const op = operations[opIndex];
          if (op.spoken && op.expected && ["match", "near"].includes(op.type)) {
            if (/[.!?…]["'”’)]*$/.test(String(op.expected.display || "").trim()) && candidate.length)
              break;
            candidate.unshift(opIndex);
            if (/[.!?…]["'”’)]*$/.test(String(operations[opIndex - 1]?.expected?.display || "").trim()))
              break;
          } else if (op.spoken && !["filler"].includes(op.type)) break;
        }
        const candidatePhrase = candidate.map((opIndex) => operations[opIndex].expected?.norm).filter(Boolean).join(" ");
        if (candidate.length && (candidatePhrase === phrase || looksLikeRestart(phrase, candidatePhrase))) {
          const previousRun = [];
          for (let opIndex = start - 1; opIndex >= 0; opIndex -= 1) {
            const op = operations[opIndex];
            if (op.spoken && op.expected && ["match", "near"].includes(op.type)) {
              previousRun.unshift(op);
              if (/[.!?…]["'”’)]*$/.test(String(operations[opIndex - 1]?.expected?.display || "").trim()))
                break;
            } else break;
          }
          const previousEnded = /[,.!?…]["'”’)]*$/.test(
            String(operations[start - 1]?.expected?.display || "").trim(),
          );
          const extraIsOnlyTail = previousRun.length > spokenGroup.length + 1;
          // Trailing echo: "Why I say to you, to you" keeps the complete clause
          // and cuts the later extra. A same-length restart still prefers later.
          if (!previousEnded && !extraIsOnlyTail) {
            repeatKeepLater = true;
            earlierOperationIndexes = candidate;
          }
        }
      } else {
        const boundedBefore = operations
          .slice(Math.max(0, start - 4), start)
          .some((item) => ["match", "near"].includes(item.type));
        const boundedAfter = operations
          .slice(cursor, cursor + 4)
          .some((item) => ["match", "near"].includes(item.type));
        const safeWords = spokenGroup.every(
          (word) => !meaningChangingWords.has(word.norm),
        );
        const phraseWords = phrase.split(" ").filter(Boolean);
        const conversational =
          phraseWords.every(
            (word) =>
              harmlessFillers.has(word) ||
              harmlessConnectors.has(word) ||
              optionalSpeechAdditions.has(word),
          ) ||
          optionalSpeechAdditions.has(phrase);
        const closingAddition = closingAdditionPhrases.some((pattern) => pattern.test(phrase));
        const titleHook = isSpokenHookForManuscript(
          phraseWords,
          upcomingExpectedNorms(operations, cursor),
        );
        if (
          !strictGroup && safeWords && spokenGroup.length <= 10 &&
          (titleHook ||
            (boundedBefore && boundedAfter && (conversational || spokenGroup.length <= 3)) ||
            (boundedBefore && !boundedAfter && closingAddition))
        ) issueType = "addition";
      }
    }
    let confirmedCut = false;
    let confirmedError = false;
    if (issueType === "repeat") {
      // Cut the abandoned take. Trailing echoes such as "to you / to you"
      // delete the later extra; false starts delete the earlier take.
      confirmedCut = true;
      confirmedError = false;
    } else if (issueType === "mismatch") {
      confirmedCut = confirmedMismatchEvidence(expectedGroup, spokenGroup, strictGroup);
      // Only strict text can block, and only after the much stronger mismatch test above.
      confirmedError = strictGroup && confirmedCut;
    } else if (issueType === "extra") {
      // 严格区多读自动剪，不阻止导出。普通内容只有在可靠文案锚点之间且明显不是口头语时才自动剪。
      const strictAddedWord = strictGroup && spokenGroup.length >= 1;
      const boundedBefore = operations.slice(Math.max(0, start - 4), start).some((item) => ["match", "near"].includes(item.type));
      const boundedAfter = operations.slice(cursor, cursor + 4).some((item) => ["match", "near"].includes(item.type));
      const phrase = spokenGroup.map((word) => word.norm).join(" ");
      const conversational = spokenGroup.every((word) =>
        harmlessFillers.has(word.norm) || harmlessConnectors.has(word.norm) || optionalSpeechAdditions.has(word.norm)
      ) || optionalSpeechAdditions.has(phrase) || closingAdditionPhrases.some((pattern) => pattern.test(phrase));
      const anchoredFalseRead = !strictGroup && boundedBefore && boundedAfter && spokenGroup.length >= 2 && !conversational;
      const longUnrelated = !strictGroup && spokenGroup.length >= 5 && !conversational;
      confirmedCut = strictAddedWord || anchoredFalseRead || longUnrelated;
      confirmedError = false;
    } else if (issueType === "missing") {
      // 1-2 ASR omissions between reliable anchors have already been recovered above.
      // Any strict manuscript token still missing after that recovery is a genuine
      // "cannot match" condition and is the main reason to stop export.
      confirmedError = strictGroup && expectedGroup.length >= 1;
    }
    if (!issueIsMajor(issueType, spokenGroup, expectedGroup)) continue;
    const previousTime = [...operations.slice(0, start)]
      .reverse()
      .find((item) => item.spoken)?.spoken?.end;
    const nextTime = operations
      .slice(cursor)
      .find((item) => item.spoken)?.spoken?.start;
    const earlierWords = repeatKeepLater
      ? earlierOperationIndexes.map((opIndex) => operations[opIndex].spoken).filter(Boolean)
      : [];
    const rangeStart = earlierWords[0]?.start ?? spokenGroup[0]?.start ?? previousTime ?? nextTime ?? 0;
    let rangeEnd = earlierWords.at(-1)?.end ?? spokenGroup.at(-1)?.end ?? rangeStart + 0.08;
    // Word timestamps often end before the voice does. For a cut extra/reread,
    // stretch to the next kept word so leftover "to you" audio is not left behind.
    if (
      confirmedCut &&
      !repeatKeepLater &&
      Number.isFinite(nextTime) &&
      nextTime > rangeEnd &&
      nextTime - rangeEnd <= 2.8
    )
      rangeEnd = nextTime;
    else if (confirmedCut && !repeatKeepLater)
      rangeEnd = Math.max(rangeEnd, rangeStart + 0.08) + 0.06;
    const issue = {
      id: crypto.randomUUID(),
      type: issueType,
      label: abandonedPrefix ? "没读完又重来" : issueLabel(issueType),
      spokenText: formatDisplayWords(spokenGroup) || "—",
      expectedText: formatDisplayWords(expectedGroup) || "—",
      start: rangeStart,
      end: Math.max(rangeStart + 0.04, rangeEnd),
      suggested: ["repeat", "extra", "mismatch"].includes(issueType),
      severity:
        issueType === "repeat"
          ? "high"
          : ["near", "semantic", "addition"].includes(issueType)
            ? "low"
          : Math.max(spokenGroup.length, expectedGroup.length) >= 3
            ? "high"
            : "medium",
      strict: strictGroup,
      scripture: strictGroup,
      confirmedCut,
      confirmedError,
      repeatKeepLater,
      abandonedPrefix,
      earlierOperationIndexes,
      laterOperationIndexes: repeatKeepLater ? group.map((_, offset) => start + offset) : [],
    };
    for (const operation of group) {
      operation.issueId = issue.id;
      operation.issueType = issueType;
      operation.action = confirmedCut
        ? "cut"
        : ["addition", "semantic", "extra", "mismatch", "repeat"].includes(issueType)
          ? "insert"
          : issueType === "missing"
            ? "missing"
            : "replace";
    }
    issues.push(issue);
  }
  issues.push(...collectFalseStartGapIssues(operations));
  snapMatchesAfterAbandonedPrefixes(operations, issues);
  return { spoken, expected, operations, issues };
}

function snapMatchesAfterAbandonedPrefixes(operations = [], issues = []) {
  for (const issue of issues) {
    if (!issue?.abandonedPrefix && !(issue?.type === "repeat" && issue?.confirmedCut && !issue.repeatKeepLater))
      continue;
    const extraEnd = Number(issue.end || 0);
    if (!(extraEnd > 0)) continue;
    let cursor = extraEnd;
    for (const operation of operations) {
      if (!operation?.spoken || !["match", "near"].includes(operation.type)) continue;
      const start = Number(operation.spoken.start || 0);
      const end = Number(operation.spoken.end || start);
      if (end <= extraEnd + 0.01) continue;
      if (start >= cursor - 0.02) break;
      const duration = Math.max(0.04, end - start);
      operation.spoken.start = cursor;
      operation.spoken.end = cursor + duration;
      if (operation.expected) {
        operation.expected.start = operation.spoken.start;
        operation.expected.end = operation.spoken.end;
      }
      cursor = operation.spoken.end;
    }
  }
}

export function buildCaptions(expectedWords, options = {}) {
  const maxWords = Math.max(2, Math.min(14, Number(options.maxWords || 7)));
  const lineChars = Math.max(12, Number(options.maxChars || 28));
  const lineCount = Math.max(1, Number(options.maxLines || 2));
  const maxChars = lineChars * lineCount;
  const captions = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    captions.push({
      id: crypto.randomUUID(),
      start: group[0].start,
      end: Math.max(group.at(-1).end, group[0].start + 0.25),
      text: formatDisplayWords(group),
      words: group.map((word) => ({
        display: word.display,
        start: word.start,
        end: word.end,
        matchType: word.matchType || "match",
        issueType: word.issueType || "",
        expectedDisplay: word.expectedDisplay || "",
        issueId: word.issueId || "",
        action: word.action || "",
      })),
    });
    group = [];
  };
  for (const word of expectedWords) {
    if (!word.end || word.end <= word.start) continue;
    const candidate = [...group, word].map((item) => item.display).join(" ");
    const priorWord = group.at(-1);
    const timingGap = priorWord
      ? Number(word.start || 0) - Number(priorWord.end || 0)
      : 0;
    const priorEnds = /[.!?][\"'\u201d\u2019)]*$/.test(
      priorWord?.display || "",
    );
    const keepReferenceTogether = !!word.keepWithPrevious;
    const splitGap = priorEnds ? 0.62 : 1.85;
    if (
      group.length &&
      !keepReferenceTogether &&
      (timingGap > splitGap ||
        timingGap < -0.02 ||
        group.length >= maxWords ||
        candidate.length > maxChars ||
        priorEnds)
    )
      flush();
    group.push(word);
  }
  flush();
  for (let index = 0; index < captions.length; index += 1) {
    const caption = captions[index];
    if (caption.words.length >= 2) continue;
    const next = captions[index + 1];
    const previous = captions[index - 1];
    const gapToNext = next ? Number(next.start) - Number(caption.end) : Infinity;
    const gapFromPrevious = previous
      ? Number(caption.start) - Number(previous.end)
      : Infinity;
    const singleton = caption.words[0]?.display || "";
    const closesSentence = /[.!?][\"'\u201d\u2019)]*$/.test(singleton);
    const previousClosesSentence = /[.!?][\"'\u201d\u2019)]*$/.test(
      previous?.words?.at(-1)?.display || "",
    );
    const joinsNext = /^(?:and|but|or|so|because|for|yet|then|when|while|if|that|which|who)$/i.test(
      singleton.replace(/[^\p{L}]/gu, ""),
    );
    const shortCloser = /^(?:me|you|it|us|him|her|them)[.!?]["'\u201d\u2019)]*$/i.test(
      singleton.replace(/^[\"“]+/, ""),
    );
    const canMergePrevious =
      previous &&
      (gapFromPrevious <= 0.62 || (shortCloser && !previousClosesSentence && gapFromPrevious <= 1.8)) &&
      previous.words.length + caption.words.length <= maxWords + 1 &&
      !previousClosesSentence;
    const canMergeNext =
      next &&
      (gapToNext <= 0.62 || (!closesSentence && gapToNext <= 1.85)) &&
      caption.words.length + next.words.length <= maxWords + 1 &&
      !closesSentence;
    const target = closesSentence
      ? canMergePrevious
        ? previous
        : null
      : joinsNext
        ? canMergeNext
          ? next
          : canMergePrevious
            ? previous
            : null
        : canMergePrevious
          ? previous
          : canMergeNext
            ? next
            : null;
    if (!target) continue;
    const mergedWords =
      target === next
        ? [...caption.words, ...next.words]
        : [...previous.words, ...caption.words];
    const merged = {
      id: target === next ? caption.id : previous.id,
      start: mergedWords[0].start,
      end: mergedWords.at(-1).end,
      words: mergedWords,
      text: formatDisplayWords(mergedWords),
    };
    if (target === next) captions.splice(index, 2, merged);
    else {
      captions.splice(index - 1, 2, merged);
      index -= 1;
    }
  }
  return captions;
}

export function buildReviewCaptions(
  issues = [],
  expectedWords = [],
  outputDuration = Infinity,
) {
  void expectedWords;
  return issues
    .filter((issue) => issue.start < outputDuration && !issue.suppressReview && issue.action !== "keep")
    .map((issue) => {
      const explicit = String(issue.expectedText || "")
        .replace(/^\s*[—-]\s*$/, "")
        .trim();
      const cuttable = ["extra", "repeat", "mismatch"].includes(issue.type);
      const acceptable = issue.type === "addition" || issue.action === "insert";
      if (!explicit && !cuttable && !acceptable) return null;
      const spoken = String(issue.spokenText || "")
        .replace(/^\s*[—-]\s*$/, "")
        .trim();
      return {
        id: issue.id,
        issueId: issue.id,
        type: issue.type,
        scripture: !!issue.scripture,
        start: issue.start,
        end: Math.min(outputDuration, Math.max(issue.start + 0.12, issue.end)),
        text: cuttable || acceptable
          ? spoken || explicit || "未识别出文字"
          : explicit || "需补录",
        expectedText: explicit,
        spokenText: issue.spokenText,
        action: cuttable ? "cut" : acceptable ? "insert" : "missing",
      };
    })
    .filter(Boolean);
}

export function manuscriptCaptionWords(aligned = {}) {
  const words = [];
  for (const operation of aligned.operations || []) {
    if (!operation?.expected) continue;
    const start = Number(operation.expected.start ?? operation.spoken?.start ?? 0);
    const end = Number(operation.expected.end ?? operation.spoken?.end ?? start);
    words.push({
      display: operation.expected.display,
      start,
      end,
      matchType:
        operation.expected.matchType ||
        (["match", "near"].includes(operation.type) ? operation.type : "error"),
      issueType: operation.issueType || "",
      expectedDisplay: operation.expected.display,
      issueId: operation.issueId || "",
      action: operation.action || "",
      keepWithPrevious: !!operation.expected.keepWithPrevious,
      scriptureReference: !!operation.expected.scriptureReference,
    });
  }
  interpolateManuscriptTimes(words);
  return words.filter((word) => Number(word.end) > Number(word.start) + 0.001);
}

function interpolateManuscriptTimes(words = []) {
  const anchored = (word) =>
    ["match", "near"].includes(word.matchType) && Number(word.end) > Number(word.start) + 0.02;
  let index = 0;
  while (index < words.length) {
    if (anchored(words[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < words.length && !anchored(words[index])) index += 1;
    const previous = start > 0 ? words[start - 1] : null;
    const next = index < words.length ? words[index] : null;
    const count = index - start;
    const previousEnded = /[.!?…]["'”’)]*$/.test(String(previous?.display || "").trim());
    const nextStart = next
      ? Number(next.start)
      : Number(previous?.end || 0) + Math.max(0.24, count * 0.22);
    // After a finished sentence, park unanchored words on the later take.
    // Filling the hole would stretch the complete sentence over a false start.
    let from = previous
      ? Number(previous.end)
      : next
        ? Math.max(0, Number(next.start) - Math.max(0.24, count * 0.22))
        : 0;
    if (previousEnded && next && nextStart - Number(previous.end) > 0.62)
      from = Math.max(from, nextStart - Math.max(0.24, count * 0.22));
    const to = next
      ? Number(next.start)
      : from + Math.max(0.24, count * 0.22);
    const span = Math.max(0.08 * count, to - from);
    const base = to >= from ? from : Math.max(0, from);
    for (let offset = 0; offset < count; offset += 1) {
      words[start + offset].start = base + (span * offset) / count;
      words[start + offset].end = base + (span * (offset + 1)) / count;
    }
  }
}

export function spokenCaptionWords(operations = []) {
  return operations
    .filter(
      (operation) =>
        operation.spoken &&
        operation.expected &&
        ["match", "near"].includes(operation.type),
    )
    .map((operation) => {
      const spoken = operation.spoken;
      const expected = operation.expected;
      return {
        display: expected.display,
        norm: expected.norm,
        start: spoken.start,
        end: spoken.end,
        matchType: "match",
        issueType: "",
        expectedDisplay: expected.display,
        issueId: "",
        action: "",
        keepWithPrevious:
          !!spoken.keepWithPrevious || !!expected.keepWithPrevious,
        scriptureReference:
          !!spoken.scriptureReference || !!expected.scriptureReference,
      };
    });
}
