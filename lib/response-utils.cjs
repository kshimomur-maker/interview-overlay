"use strict";

function extractResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string") return payload.output_text;

  const parts = [];
  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n");
}

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

function parseJsonResponse(payload) {
  const raw = stripCodeFence(extractResponseText(payload));
  if (!raw) throw new Error("The model returned an empty response.");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const objectStart = raw.indexOf("{");
    const objectEnd = raw.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(raw.slice(objectStart, objectEnd + 1));
    }
    throw error;
  }
}

function normalizeAnalysis(value, fallbackOriginal = "") {
  const source = value && typeof value === "object" ? value : {};
  const points = Array.isArray(source.key_points)
    ? source.key_points.filter(Boolean).slice(0, 4).map(String)
    : [];
  const usefulPhrases = Array.isArray(source.useful_phrases)
    ? source.useful_phrases
        .filter((item) => item && typeof item === "object")
        .slice(0, 4)
        .map((item) => ({
          phrase: String(item.phrase || "").trim(),
          japanese: String(item.japanese || "").trim(),
          noun: String(item.noun || "").trim(),
          modifier: String(item.modifier || "").trim()
        }))
        .filter((item) => item.phrase)
    : [];

  return {
    language: source.language === "ja" ? "ja" : "en",
    original: String(source.original || fallbackOriginal || "").trim(),
    japanese: String(source.japanese || "").trim(),
    intent: String(source.intent || "").trim(),
    should_answer: Boolean(source.should_answer),
    answer_short: String(source.answer_short || "").trim(),
    answer_standard: String(source.answer_standard || "").trim(),
    key_points: points,
    useful_phrases: usefulPhrases,
    caution: String(source.caution || "").trim()
  };
}

function normalizePhraseMemoryRecord(value) {
  const source = value && typeof value === "object" ? value : {};
  const chunks = Array.isArray(source.chunks)
    ? source.chunks
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  return {
    id: String(source.id || "").trim(),
    japanese: String(source.japanese || "").trim(),
    scene: String(source.scene || "job interview").trim(),
    tags: Array.isArray(source.tags)
      ? source.tags
          .map((tag) => String(tag || "").trim())
          .filter(Boolean)
          .slice(0, 12)
      : ["job-interview"],
    spoken: String(source.spoken || "").trim(),
    written: String(source.written || source.spoken || "").trim(),
    chunks,
    createdAt: String(source.createdAt || new Date().toISOString()),
    views: Number.isFinite(Number(source.views)) ? Number(source.views) : 0,
    quizHistory: Array.isArray(source.quizHistory) ? source.quizHistory : [],
    nextReview: source.nextReview ? String(source.nextReview) : null,
    status: ["learning", "strong", "weak"].includes(source.status)
      ? source.status
      : "learning",
    source: source.source && typeof source.source === "object" ? source.source : {}
  };
}

function selectRelevantContext(profile, transcript, maxChars = 9000) {
  const source = String(profile || "").trim();
  if (!source || maxChars <= 0) return "";
  if (source.length <= maxChars) return source;

  const words = new Set(
    String(transcript || "")
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}'-]{1,}/gu) || []
  );
  const blocks = source
    .split(/\n{2,}/)
    .map((text, index) => ({ text: text.trim(), index }))
    .filter((block) => block.text);

  const scored = blocks.map((block) => {
    const haystack = block.text.toLowerCase();
    let score = block.index === 0 ? 8 : 0;
    for (const word of words) {
      if (word.length >= 3 && haystack.includes(word)) score += 1;
    }
    return { ...block, score };
  });

  const selected = [];
  let used = 0;
  for (const block of scored.sort((a, b) => b.score - a.score || a.index - b.index)) {
    const separatorLength = selected.length ? 2 : 0;
    if (used + separatorLength + block.text.length > maxChars) continue;
    selected.push(block);
    used += separatorLength + block.text.length;
  }

  return selected
    .sort((a, b) => a.index - b.index)
    .map((block) => block.text)
    .join("\n\n")
    .slice(0, maxChars);
}

module.exports = {
  extractResponseText,
  normalizePhraseMemoryRecord,
  normalizeAnalysis,
  parseJsonResponse,
  selectRelevantContext,
  stripCodeFence
};
