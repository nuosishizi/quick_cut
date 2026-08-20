import { completeGeminiReview, reviewReady } from "./ai-settings.mjs";

const TARGET_LABELS = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁体中文",
};

function cleanModelText(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function parseCaptionTranslations(raw, expectedIds = []) {
  const cleaned = cleanModelText(raw);
  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");
  const firstArray = cleaned.indexOf("[");
  const lastArray = cleaned.lastIndexOf("]");
  const candidates = [cleaned];
  if (firstObject >= 0 && lastObject > firstObject)
    candidates.push(cleaned.slice(firstObject, lastObject + 1));
  if (firstArray >= 0 && lastArray > firstArray)
    candidates.push(cleaned.slice(firstArray, lastArray + 1));

  let parsed = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // Try the next JSON-shaped span. Models occasionally add a short preface.
    }
  }
  if (!parsed) throw new Error("翻译服务没有返回有效的 JSON，请重试。");

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.translations)
      ? parsed.translations
      : [];
  const allowed = new Set((expectedIds || []).map(String));
  const translations = [];
  const seen = new Set();
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    const text = String(row?.text ?? row?.translation ?? "").trim();
    if (!id || !text || seen.has(id) || (allowed.size && !allowed.has(id))) continue;
    translations.push({ id, text });
    seen.add(id);
  }
  return translations;
}

export function captionTranslationPrompt(captions, targetLanguage = "zh-Hans") {
  const target = TARGET_LABELS[targetLanguage] || TARGET_LABELS["zh-Hans"];
  return {
    system: [
      `你是专业影视字幕翻译。把英文主字幕逐句翻译成${target}辅助字幕。`,
      "翻译要准确、简洁、口语自然，适合直接显示在视频画面上。",
      "保留数字、专有名词、经文含义、称谓和行动号召；不要增加解释或注释。",
      "每个输入 id 必须原样返回一次，顺序不变。",
      '只输出 JSON：{"translations":[{"id":"原 id","text":"译文"}]}。',
    ].join("\n"),
    user: JSON.stringify({ targetLanguage: target, captions }),
  };
}

export async function translateAuxiliaryCaptions(
  { captions = [], targetLanguage = "zh-Hans" } = {},
  complete = completeGeminiReview,
) {
  if (!reviewReady())
    throw new Error("请先在“纠正设置”中配置 Gemini、Vertex 或 Antigravity，再生成中文辅助字幕。");
  const normalized = (captions || [])
    .map((caption) => ({
      id: String(caption?.id || "").trim(),
      text: String(caption?.text || "").trim(),
    }))
    .filter((caption) => caption.id && caption.text);
  if (!normalized.length) return { translations: [], targetLanguage };

  const translations = [];
  const batchSize = 36;
  for (let index = 0; index < normalized.length; index += batchSize) {
    const batch = normalized.slice(index, index + batchSize);
    const prompt = captionTranslationPrompt(batch, targetLanguage);
    const raw = await complete(prompt);
    translations.push(...parseCaptionTranslations(raw, batch.map((item) => item.id)));
  }
  return { translations, targetLanguage };
}
