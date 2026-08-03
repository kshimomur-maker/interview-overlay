"use strict";

const { normalizePhraseMemoryRecord } = require("./response-utils.cjs");

const BRIDGE_SCHEMA = "phrase-memory-import.v1";

function createPhraseMemoryDraft(entry, options = {}) {
  const answer = String(entry?.answer_standard || entry?.answer || "").trim();
  const phrases = Array.isArray(entry?.useful_phrases)
    ? entry.useful_phrases
        .map((item) => String(item?.phrase || "").trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const createdAt = String(entry?.createdAt || new Date().toISOString());
  const source = {
    app: "interview-overlay",
    schema: "interview-entry.v1",
    question: String(entry?.original || "").trim(),
    intent: String(entry?.intent || "").trim(),
    createdAt
  };

  return normalizePhraseMemoryRecord({
    id: String(entry?.id || `interview-${Date.parse(createdAt) || Date.now()}`),
    japanese: String(entry?.japanese || options.japanese || "").trim(),
    scene: String(options.scene || "job interview"),
    tags: ["job-interview", "from-interview-assistant"],
    spoken: answer,
    // Keep the field separate now so Phrase Memory can later provide a
    // dedicated written version without changing the bridge contract.
    written: String(entry?.written || answer).trim(),
    chunks: phrases,
    createdAt,
    status: "learning",
    nextReview: null,
    source
  });
}

function createPhraseMemoryImport(entries, options = {}) {
  const phrases = (Array.isArray(entries) ? entries : [])
    .map((entry) => createPhraseMemoryDraft(entry, options))
    .filter((entry) => entry.spoken || entry.chunks.length);

  return {
    schema: BRIDGE_SCHEMA,
    exportedAt: new Date().toISOString(),
    source: {
      app: "interview-overlay",
      version: String(options.version || "0.2.0")
    },
    phrases
  };
}

module.exports = {
  BRIDGE_SCHEMA,
  createPhraseMemoryDraft,
  createPhraseMemoryImport
};
