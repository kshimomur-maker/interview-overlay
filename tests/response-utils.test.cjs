"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractResponseText,
  normalizeAnalysis,
  normalizePhraseMemoryRecord,
  parseJsonResponse,
  selectRelevantContext,
  stripCodeFence
} = require("../lib/response-utils.cjs");
const { consumeResponseStream } = require("../lib/openai-client.cjs");
const {
  createPhraseMemoryDraft,
  createPhraseMemoryImport
} = require("../lib/phrase-memory-bridge.cjs");
const {
  containsInterviewQuestionSignal,
  extractLatestQuestion,
  repairLikelyInterviewQuestion,
  getTranscriptionWindowRange,
  mergeTranscript,
  shouldReplaceLockedQuestion
} = require("../renderer/transcription-utils.js");

test("extractResponseText reads Responses API output items", () => {
  const result = extractResponseText({
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "hello" }]
      }
    ]
  });
  assert.equal(result, "hello");
});

test("parseJsonResponse accepts fenced JSON", () => {
  const result = parseJsonResponse({
    output_text: '```json\n{"language":"en"}\n```'
  });
  assert.deepEqual(result, { language: "en" });
});

test("stripCodeFence leaves normal text unchanged", () => {
  assert.equal(stripCodeFence("plain"), "plain");
});

test("normalizeAnalysis constrains key points and defaults", () => {
  const result = normalizeAnalysis({
    language: "fr",
    key_points: ["a", "b", "c", "d", "e"],
    should_answer: 1
  });
  assert.equal(result.language, "en");
  assert.equal(result.key_points.length, 4);
  assert.equal(result.should_answer, true);
});

test("normalizeAnalysis keeps completed post-modifier phrases", () => {
  const result = normalizeAnalysis({
    useful_phrases: [
      {
        phrase: "a project I led",
        japanese: "自分が率いたプロジェクト",
        noun: "a project",
        modifier: "I led"
      },
      { phrase: "", noun: "ignored" }
    ]
  });
  assert.deepEqual(result.useful_phrases, [
    {
      phrase: "a project I led",
      japanese: "自分が率いたプロジェクト",
      noun: "a project",
      modifier: "I led"
    }
  ]);
});

test("Phrase Memory bridge produces the shared local-first record shape", () => {
  const draft = createPhraseMemoryDraft({
    id: "interview-1",
    original: "Tell me about a project you led.",
    answer_standard: "I led a project that reduced manual work.",
    useful_phrases: [{ phrase: "a project that reduced manual work" }],
    createdAt: "2026-07-31T00:00:00.000Z"
  });
  assert.deepEqual(draft.chunks, ["a project that reduced manual work"]);
  assert.equal(draft.spoken, "I led a project that reduced manual work.");
  assert.equal(draft.written, draft.spoken);
  assert.equal(draft.status, "learning");
  assert.equal(draft.source.app, "interview-overlay");
});

test("Phrase Memory import contains only usable entries", () => {
  const payload = createPhraseMemoryImport([
    { answer_standard: "A useful answer.", useful_phrases: [] },
    { answer_standard: "", useful_phrases: [] }
  ]);
  assert.equal(payload.schema, "phrase-memory-import.v1");
  assert.equal(payload.phrases.length, 1);
  assert.equal(normalizePhraseMemoryRecord(payload.phrases[0]).status, "learning");
});

test("selectRelevantContext keeps matching profile blocks within the limit", () => {
  const profile = [
    "Executive summary about operations leadership.",
    "Built an insurance claims automation team and improved processing speed.",
    "Unrelated education details and general background.",
    "Led a Japan operations team for an AI startup."
  ].join("\n\n");
  const result = selectRelevantContext(
    profile.repeat(20),
    "Tell me about your insurance automation experience",
    220
  );
  assert.match(result, /insurance claims automation/i);
  assert.ok(result.length <= 220);
});

test("consumeResponseStream forwards text deltas in order", async () => {
  const deltas = [];
  const usage = [];
  const response = new Response(
    [
      'data: {"type":"response.output_text.delta","delta":"I can "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"explain."}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":8}}}\n\n',
      "data: [DONE]\n\n"
    ].join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
  const result = await consumeResponseStream(
    response,
    (delta) => deltas.push(delta),
    (value) => usage.push(value)
  );
  assert.equal(result, "I can explain.");
  assert.deepEqual(deltas, ["I can ", "explain."]);
  assert.deepEqual(usage, [{ input_tokens: 12, output_tokens: 8 }]);
});

test("interview question detector catches tell me about yourself variants", () => {
  assert.equal(containsInterviewQuestionSignal("So, tell me about yourself."), true);
  assert.equal(containsInterviewQuestionSignal("Can you tell me about your self?"), true);
  assert.equal(containsInterviewQuestionSignal("What is your favorite movie?"), true);
});

test("transcript merge removes overlapping rolling-window text", () => {
  assert.equal(
    mergeTranscript("So, tell me about", "tell me about yourself."),
    "So, tell me about yourself."
  );
});

test("transcription windows use a small overlap without resending the whole history", () => {
  assert.deepEqual(getTranscriptionWindowRange(4, 0, 4, 1, 3), {
    start: 0,
    end: 4,
    nextWindowEnd: 4
  });
  assert.deepEqual(getTranscriptionWindowRange(7, 4, 4, 1, 3), {
    start: 3,
    end: 7,
    nextWindowEnd: 7
  });
  assert.equal(getTranscriptionWindowRange(6, 4, 4, 1, 3), null);
});

test("latest question display trims earlier speech and keeps the question", () => {
  assert.equal(
    extractLatestQuestion("Thanks for joining today. Why should we hire you?"),
    "Why should we hire you?"
  );
  assert.equal(
    extractLatestQuestion("Thanks for joining today, so tell me about yourself"),
    "tell me about yourself"
  );
  assert.equal(extractLatestQuestion("Tell me about yourself."), "Tell me about yourself.");
});

test("question detector accepts common open interview prompts", () => {
  assert.equal(containsInterviewQuestionSignal("Describe a difficult decision you made."), true);
  assert.equal(containsInterviewQuestionSignal("Could you explain your role there?"), true);
  assert.equal(containsInterviewQuestionSignal("That project sounds important."), false);
});

test("question detector accepts an incomplete but meaningful customer prompt", () => {
  assert.equal(
    containsInterviewQuestionSignal("For our customer and how you handle"),
    true
  );
  assert.equal(
    extractLatestQuestion("For our customer and how you handle"),
    "For our customer and how you handle"
  );
});

test("locked question stays visible during supplementary explanation", () => {
  assert.equal(
    shouldReplaceLockedQuestion(
      "Why should we hire you?",
      "Could you focus on the operations side?",
      false
    ),
    false
  );
  assert.equal(
    shouldReplaceLockedQuestion(
      "Why should we hire you?",
      "What was the biggest challenge?",
      true
    ),
    true
  );
});

test("repairs a dropped final word in the good customer service question", () => {
  assert.equal(
    repairLikelyInterviewQuestion("What is your impression of good customers?"),
    "What is your impression of good customer service?"
  );
  assert.equal(
    extractLatestQuestion("What is your impression of good customer?"),
    "What is your impression of good customer service?"
  );
  assert.equal(
    repairLikelyInterviewQuestion("How do you identify good customers?"),
    "How do you identify good customers?"
  );
});
