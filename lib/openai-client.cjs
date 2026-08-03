"use strict";

const {
  extractResponseText,
  normalizeAnalysis,
  parseJsonResponse,
  selectRelevantContext
} = require("./response-utils.cjs");

const API_BASE = "https://api.openai.com/v1";

const INTERVIEW_METADATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "language",
    "original",
    "japanese",
    "intent",
    "should_answer",
    "key_points",
    "useful_phrases",
    "caution"
  ],
  properties: {
    language: { type: "string", enum: ["en", "ja"] },
    original: { type: "string" },
    japanese: { type: "string" },
    intent: { type: "string" },
    should_answer: { type: "boolean" },
    key_points: {
      type: "array",
      maxItems: 4,
      items: { type: "string" }
    },
    useful_phrases: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "japanese", "noun", "modifier"],
        properties: {
          phrase: { type: "string" },
          japanese: { type: "string" },
          noun: { type: "string" },
          modifier: { type: "string" }
        }
      }
    },
    caution: { type: "string" }
  }
};

function authHeaders(apiKey, json = false) {
  const headers = {
    Authorization: `Bearer ${apiKey}`
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function readApiError(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}

async function apiFetch(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const detail = await readApiError(response);
    const error = new Error(`OpenAI API: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function testApiKey(apiKey) {
  const response = await apiFetch("/models", {
    method: "GET",
    headers: authHeaders(apiKey)
  });
  return response.ok;
}

async function transcribeAudio({
  apiKey,
  audioBuffer,
  mimeType = "audio/webm",
  model = "gpt-transcribe",
  context = ""
}) {
  const form = new FormData();
  const extension = mimeType.includes("ogg") ? "ogg" : "webm";
  form.append("file", new Blob([audioBuffer], { type: mimeType }), `chunk.${extension}`);
  form.append("model", model);
  form.append("response_format", "json");
  form.append("languages[]", "en");
  form.append("languages[]", "ja");
  form.append(
    "prompt",
    [
      "Job interview audio in English or Japanese.",
      "Transcribe the interviewer literally, including short questions.",
      "Use the complete conventional wording when the audio supports it; do not drop a quiet final word.",
      "Common questions may include: tell me about yourself; walk me through your resume; why are you interested in this role; why should we hire you; what is your impression of good customer service.",
      context.trim()
        ? `Expected names and context: ${context.replace(/\s+/g, " ").slice(0, 1200)}`
        : ""
    ]
      .filter(Boolean)
      .join(" ")
  );

  const response = await apiFetch("/audio/transcriptions", {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form
  });
  const result = await response.json();
  return String(result.text || "").trim();
}

function buildInterviewMetadataInput({ transcript, recentHistory, answer }) {
  return [
    "Analyze the interviewer's latest spoken segment and the candidate answer.",
    "",
    "Success criteria:",
    "- Preserve the spoken wording in original.",
    "- japanese must be a short, natural Japanese translation of the answer instruction. Keep it to one brief sentence or about 35 Japanese characters. Do not give a detailed explanation, grammar lesson, or English instruction such as 'Keep it simple' or 'You could say'.",
    "- Decide whether the candidate should respond. Statements can still invite a response.",
    "- key_points are not used in the interface; keep them brief for notes only.",
    "- useful_phrases must contain 0-4 complete, speakable English phrases taken from the candidate answer.",
    "- Prefer a noun followed by a natural post-modifier, such as 'a project I led' or 'the process we built for the team'.",
    "- Do not return isolated verbs, labels, instructions, sentence fragments ending in '...', or phrases not present in the answer.",
    "- For each useful phrase, separate the noun and the post-modifier when possible.",
    "",
    "Recent interview context:",
    recentHistory?.trim() || "(No earlier context.)",
    "",
    "Latest spoken segment:",
    transcript,
    "",
    "Candidate answer:",
    answer?.trim() || "(Answer is not available.)"
  ].join("\n");
}

function buildFastAnswerInput({ transcript, recentHistory, profile, style, forced = false }) {
  const relevantProfile = selectRelevantContext(profile, transcript, 9000);
  return [
    "Give the candidate a spoken answer to the interviewer's latest question.",
    forced
      ? "FORCED ANSWER MODE: Generate the best useful answer now from the available question and follow-up context. Do not output 'Listen' and do not respond with only a clarification question. If some detail is uncertain, begin with a brief natural qualifier and answer the clearest reasonable interpretation. Never invent company facts, role facts, or candidate experience."
      : "NORMAL MODE: Ask a clarification question instead of guessing when the question itself is genuinely unclear.",
    "The candidate may begin speaking before the full answer is ready. Make the first sentence safe, natural, and useful even if read by itself.",
    "For a clear question, begin with one brief spoken bridge such as 'Sure. Let me explain that.' or a short restatement of the topic, then answer directly.",
    forced
      ? "If the available wording is incomplete, make the safest explicit interpretation and give a useful answer based only on verified candidate information."
      : "If the question is genuinely unclear, ask a clarification question. However, do not treat normal spoken fragments, missing grammar, or a sentence that ends mid-thought as unclear when the main topic and requested action can be reasonably inferred. In that case, give a useful, general answer immediately and make the first sentence safe to say by itself. Use a clarification question only when two or more materially different interpretations remain.",
    "EARLY ANSWER RULE: The transcript is live and may end before the interviewer finishes speaking. If a fragment contains a recognizable interview topic and action, answer that topic immediately; do not wait for a complete grammatical sentence. For example, 'For our customer and how you handle...' means the candidate should explain how they handle customers. Start with a natural, general answer that remains valid if a later word adds detail. Do not say the question is incomplete and do not ask the interviewer to clarify merely because the transcript ends mid-sentence.",
    "CLARIFICATION RULE: Use a clarification sentence only when the available words genuinely support two or more materially different answers, or when no reasonable interview intent can be inferred. If clarification is needed because the audio may have been missed, take responsibility naturally: 'Sorry, I may have missed part of that. Are you asking about ...?' Never ask for information that is already explicit in the transcript, such as 'company' versus 'role'.",
    "Infer the interviewer's intent from meaningful keywords and context. For example, 'For our customer and how you handle...' should be understood as asking how the candidate handles customers; answer that topic instead of asking the interviewer to repeat the question.",
    "Treat the live transcript as fallible speech recognition. Silently restore an obvious omitted or misheard word when one interpretation is a standard interview question and the literal alternative is unnatural. For example, 'What is your impression of good customers?' should be interpreted as 'What is your impression of good customer service?' and answered about good customer service. Do not mention the correction. Do not rewrite wording when two interpretations are genuinely plausible.",
    "Do not mention AI, an assistant, a prompt, a transcript, or uncertainty in the system. Do not add a heading, label, analysis, or markdown.",
    "Use simple, natural English if the interviewer speaks English; use Japanese if they speak Japanese.",
    "Keep the answer to about 30-45 seconds and make the first sentence immediately useful.",
    "Use only the candidate information supplied below. Never invent experience, numbers, employers, skills, or outcomes.",
    "If the question is clear but candidate information is insufficient, use a short, honest bridge to the closest verified experience without inventing facts.",
    "If no response is needed yet, output exactly: Listen — no answer is needed yet.",
    "",
    `Speaking style: ${style || "Clear, concise, warm, and easy for a non-native English speaker to say."}`,
    "",
    "Most relevant candidate information:",
    relevantProfile || "(No candidate information has been added yet.)",
    "",
    "Recent interview context:",
    recentHistory?.trim() || "(No earlier context.)",
    "",
    "Latest interviewer segment:",
    transcript
  ].join("\n");
}

async function createResponse({ apiKey, model, input, schema, reasoningEffort = "low" }) {
  const body = {
    model,
    store: false,
    reasoning: { effort: reasoningEffort },
    input,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "interview_assist",
        strict: true,
        schema
      }
    }
  };

  return apiFetch("/responses", {
    method: "POST",
    headers: authHeaders(apiKey, true),
    body: JSON.stringify(body)
  });
}

async function analyzeInterview({
  apiKey,
  transcript,
  recentHistory = "",
  answer = "",
  model = "gpt-5.6-sol",
  onUsage
}) {
  const input = buildInterviewMetadataInput({
    transcript,
    recentHistory,
    answer
  });

  try {
    const response = await createResponse({
      apiKey,
      model,
      input,
      schema: INTERVIEW_METADATA_SCHEMA
    });
    const payload = await response.json();
    onUsage?.(payload.usage || null);
    return normalizeAnalysis(parseJsonResponse(payload), transcript);
  } catch (error) {
    if (error.status !== 400) throw error;

    const fallback = await apiFetch("/responses", {
      method: "POST",
      headers: authHeaders(apiKey, true),
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        instructions:
          "Return only valid JSON with these keys: language, original, japanese, intent, should_answer, key_points, useful_phrases, caution.",
        input
      })
    });
    const payload = await fallback.json();
    onUsage?.(payload.usage || null);
    return normalizeAnalysis(parseJsonResponse(payload), transcript);
  }
}

async function consumeResponseStream(response, onDelta = () => {}, onUsage) {
  if (!response.body) throw new Error("The response stream was not available.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";

  const consumeLine = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (event.type === "response.output_text.delta" && event.delta) {
      const delta = String(event.delta);
      output += delta;
      onDelta(delta);
    } else if (event.type === "error") {
      throw new Error(event.error?.message || event.message || "Response stream failed.");
    } else if (event.type === "response.failed") {
      throw new Error(
        event.response?.error?.message || "The model could not prepare an answer."
      );
    } else if (event.type === "response.completed") {
      onUsage?.(event.response?.usage || null);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer.trim()) consumeLine(buffer);
  return output.trim();
}

async function streamInterviewAnswer({
  apiKey,
  transcript,
  recentHistory = "",
  profile = "",
  style = "",
  forced = false,
  model = "gpt-5.6-sol",
  onDelta,
  onUsage
}) {
  const response = await apiFetch("/responses", {
    method: "POST",
    headers: authHeaders(apiKey, true),
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      reasoning: { effort: "low" },
      max_output_tokens: 220,
      text: { verbosity: "low" },
      input: buildFastAnswerInput({
        transcript,
        recentHistory: recentHistory.slice(-3200),
        profile,
        style,
        forced
      })
    })
  });
  return consumeResponseStream(response, onDelta, onUsage);
}

async function generateMinutes({
  apiKey,
  entries,
  profile = "",
  model = "gpt-5.6-sol",
  onUsage
}) {
  const transcript = entries
    .map(
      (entry) =>
        `[${entry.time}] Interviewer: ${entry.original}\nJapanese: ${entry.japanese || ""}\nSuggested answer: ${
          entry.answer_standard || ""
        }`
    )
    .join("\n\n");

  const response = await apiFetch("/responses", {
    method: "POST",
    headers: authHeaders(apiKey, true),
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "low" },
      text: { verbosity: "medium" },
      instructions: [
        "Create concise Markdown interview notes.",
        "Use these sections: Overview, Questions asked, Candidate responses or suggested responses, Strengths observed, Follow-ups, and Practice improvements.",
        "Do not invent facts. Clearly label suggested responses that may not have been spoken.",
        "Write the notes in Japanese, while preserving important English interview phrases."
      ].join(" "),
      input: `Candidate context:\n${profile.slice(0, 20000)}\n\nInterview log:\n${transcript.slice(
        0,
        100000
      )}`
    })
  });
  const payload = await response.json();
  onUsage?.(payload.usage || null);
  return extractResponseText(payload).trim();
}

module.exports = {
  analyzeInterview,
  consumeResponseStream,
  generateMinutes,
  streamInterviewAnswer,
  testApiKey,
  transcribeAudio
};
