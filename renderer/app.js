"use strict";

const $ = (id) => document.getElementById(id);

const elements = {
  apiKeyHint: $("apiKeyHint"),
  apiKeyInput: $("apiKeyInput"),
  cautionText: $("cautionText"),
  cheatSheetButton: $("cheatSheetButton"),
  cheatSheetInput: $("cheatSheetInput"),
  cheatSheetPanel: $("cheatSheetPanel"),
  cheatSheetStatus: $("cheatSheetStatus"),
  saveCheatSheetButton: $("saveCheatSheetButton"),
  clickThroughButton: $("clickThroughButton"),
  closeButton: $("closeButton"),
  closeCheatSheetButton: $("closeCheatSheetButton"),
  closeNotesButton: $("closeNotesButton"),
  closeSettingsButton: $("closeSettingsButton"),
  exportNotesButton: $("exportNotesButton"),
  forceAnswerButton: $("forceAnswerButton"),
  intentText: $("intentText"),
  knowledgeFileInput: $("knowledgeFileInput"),
  languageBadge: $("languageBadge"),
  liveDot: $("liveDot"),
  minimizeButton: $("minimizeButton"),
  minutesButton: $("minutesButton"),
  notesContent: $("notesContent"),
  notesError: $("notesError"),
  notesLoading: $("notesLoading"),
  notesModal: $("notesModal"),
  opacityInput: $("opacityInput"),
  opacityValue: $("opacityValue"),
  originalText: $("originalText"),
  answerGuidance: $("answerGuidance"),
  phraseMemoryButton: $("phraseMemoryButton"),
  usefulPhrases: $("usefulPhrases"),
  profileInput: $("profileInput"),
  protectionStatus: $("protectionStatus"),
  responseLatency: $("responseLatency"),
  responseModelInput: $("responseModelInput"),
  refreshUsageButton: $("refreshUsageButton"),
  resumeButton: $("resumeButton"),
  saveSettingsButton: $("saveSettingsButton"),
  settingsButton: $("settingsButton"),
  settingsDrawer: $("settingsDrawer"),
  settingsError: $("settingsError"),
  shortAnswer: $("shortAnswer"),
  shortAnswerToggle: $("shortAnswerToggle"),
  standardAnswer: $("standardAnswer"),
  startButton: $("startButton"),
  statusText: $("statusText"),
  styleInput: $("styleInput"),
  testKeyButton: $("testKeyButton"),
  thinkingIndicator: $("thinkingIndicator"),
  transcriptionModelInput: $("transcriptionModelInput"),
  usageInputTokens: $("usageInputTokens"),
  usageNote: $("usageNote"),
  usageOutputTokens: $("usageOutputTokens"),
  usagePeriod: $("usagePeriod"),
  usageRequests: $("usageRequests"),
  usageTranscriptions: $("usageTranscriptions"),
  openUsageButton: $("openUsageButton")
};

const {
  mergeTranscript,
  containsInterviewQuestionSignal,
  extractLatestQuestion,
  getTranscriptionWindowRange,
  shouldReplaceLockedQuestion
} = window.TranscriptionUtils;

const state = {
  active: false,
  clickThrough: false,
  stream: null,
  recorder: null,
  restartTimer: null,
  speechFlushTimer: null,
  processing: 0,
  pendingWork: new Set(),
  answerTasks: new Set(),
  entries: [],
  settings: null,
  heardSpeech: false,
  audioContext: null,
  analyser: null,
  levelFrame: null,
  answerRequestId: "",
  answerShownAt: 0,
  answerText: "",
  // Text currently visible to the candidate. This is deliberately separate
  // from the next response being streamed or analyzed so metadata updates
  // cannot blank or rewrite a usable answer.
  displayedAnswerText: "",
  streamingAnswerText: "",
  firstAnswerDeltaReceived: false,
  audioParts: [],
  audioHeaderPart: null,
  lastWindowEnd: 0,
  speechSinceWindow: false,
  lastSpeechAt: 0,
  lastProcessedSpeechEndAt: 0,
  rollingTranscript: "",
  latestTranscript: "",
  answerTimer: null,
  answerInFlight: false,
  pendingAnswer: null,
  lastScheduledQuestionKey: "",
  captureGeneration: 0,
  cheatSheet: "",
  transcriptionPending: [],
  transcriptionResults: new Map(),
  transcriptionInFlight: 0,
  transcriptionSequence: 0,
  nextTranscriptionSequence: 1,
  idleStopTimer: null,
  lockedQuestion: ""
};

const RECORDING_TIMESLICE_MS = 500;
const TRANSCRIPTION_WINDOW_PARTS = 4;
const TRANSCRIPTION_OVERLAP_PARTS = 1;
const TRANSCRIPTION_EMIT_EVERY_PARTS = 3;
const SPEECH_LEVEL_THRESHOLD = 0.018;
const ANSWER_QUIET_PERIOD_MS = 1400;
const NEW_QUESTION_SILENCE_MS = 1600;
const PRIORITY_QUESTION_DELAY_MS = 250;
const TRANSCRIPTION_MAX_IN_FLIGHT = 3;
const SPEECH_FLUSH_SILENCE_MS = 800;
const IDLE_AUTO_STOP_MS = 15 * 60 * 1000;

function resetIdleStopTimer(generation = state.captureGeneration) {
  if (state.idleStopTimer) clearTimeout(state.idleStopTimer);
  state.idleStopTimer = setTimeout(async () => {
    state.idleStopTimer = null;
    if (!isCurrentCapture(generation)) return;
    await stopInterview("Stopped automatically · 15 minutes without speech");
  }, IDLE_AUTO_STOP_MS);
}

function setStatus(text, active = state.active) {
  elements.statusText.textContent = text;
  elements.liveDot.classList.toggle("active", active);
}

function updateForceAnswerButton() {
  const hasQuestionContext = Boolean(
    (state.lockedQuestion || state.latestTranscript || state.rollingTranscript).trim()
  );
  elements.forceAnswerButton.disabled = !state.active || !hasQuestionContext;
  elements.forceAnswerButton.textContent = state.pendingAnswer?.forced
    ? "Answer queued"
    : "Generate Answer";
}

function showError(target, error) {
  target.textContent = error?.message || String(error);
  target.classList.remove("hidden");
}

function hideError(target) {
  target.textContent = "";
  target.classList.add("hidden");
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function renderUsage(usage) {
  if (!usage) return;
  elements.usageRequests.textContent = formatCount(usage.requests);
  elements.usageInputTokens.textContent = formatCount(usage.inputTokens);
  elements.usageOutputTokens.textContent = formatCount(usage.outputTokens);
  elements.usageTranscriptions.textContent = formatCount(usage.transcriptionRequests);
  elements.usageNote.textContent = usage.note ||
    "Exact dollar spend is shown in the OpenAI Usage dashboard. Audio transcription is not included in token totals.";
  if (usage.updatedAt) {
    elements.usagePeriod.textContent = `Updated ${new Date(usage.updatedAt).toLocaleString()}`;
  }
}

function recentHistory() {
  return state.entries
    .slice(-2)
    .map((entry) => `[${entry.time}] ${String(entry.original || "").slice(-1800)}`)
    .join("\n");
}

function renderUsefulPhrases(phrases) {
  elements.usefulPhrases.replaceChildren();
  const items = Array.isArray(phrases) ? phrases.filter((item) => item?.phrase) : [];
  if (!items.length) {
    const empty = document.createElement("span");
    empty.className = "phrase-card muted";
    empty.textContent = "No reusable phrase found yet.";
    elements.usefulPhrases.append(empty);
    return;
  }

  for (const item of items.slice(0, 4)) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "phrase-card";
    card.title = "Copy phrase";
    const phrase = document.createElement("span");
    phrase.className = "phrase-text";
    if (item.noun && item.modifier) {
      const noun = document.createElement("strong");
      noun.textContent = item.noun;
      const modifier = document.createElement("em");
      modifier.textContent = ` ${item.modifier}`;
      phrase.append(noun, modifier);
    } else {
      phrase.textContent = item.phrase;
    }
    card.append(phrase);
    if (item.japanese) {
      const translation = document.createElement("small");
      translation.textContent = item.japanese;
      card.append(translation);
    }
    card.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(item.phrase);
      card.classList.add("copied");
      setTimeout(() => card.classList.remove("copied"), 900);
    });
    elements.usefulPhrases.append(card);
  }
}

function updateAnalysisMetadata(analysis, transcript = "") {
  if (!analysis) return;
  elements.originalText.textContent = extractLatestQuestion(
    transcript || analysis.original || ""
  );
  elements.originalText.classList.remove("empty");
  elements.languageBadge.textContent = analysis.language === "ja" ? "JA" : "EN";
  elements.intentText.textContent = analysis.intent || "Response";
  elements.answerGuidance.textContent =
    analysis.japanese || "この質問に直接答えます。";
  elements.answerGuidance.classList.remove("is-pending");

  // Analysis is a second, slower phase. Never replace the answer here:
  // the candidate may already be speaking while this result arrives.
  if (!analysis.should_answer && !state.displayedAnswerText.trim()) {
    elements.standardAnswer.textContent = "Listen — no answer is needed yet.";
    elements.standardAnswer.classList.add("empty");
  }

  renderUsefulPhrases(analysis.useful_phrases);

  elements.cautionText.textContent = analysis.caution || "";
  elements.cautionText.classList.toggle("hidden", !analysis.caution);
}

function beginAnswerDisplay(transcript, requestId) {
  state.answerRequestId = requestId;
  state.answerShownAt = performance.now();
  state.answerText = "";
  state.streamingAnswerText = "";
  state.firstAnswerDeltaReceived = false;
  elements.originalText.textContent = extractLatestQuestion(transcript);
  elements.originalText.classList.remove("empty");
  elements.languageBadge.textContent = "AUTO";
  elements.intentText.textContent = "Preparing answer";
  elements.answerGuidance.textContent = "質問の意図を確認しています…";
  elements.answerGuidance.classList.add("is-pending");
  // Keep the previous answer visible while the next answer is being
  // prepared. The old implementation cleared this area indirectly during
  // the confirmation/analysis transition, which caused a visible flash.
  elements.standardAnswer.classList.toggle(
    "is-updating",
    Boolean(state.displayedAnswerText.trim())
  );
  if (!state.displayedAnswerText.trim() && !elements.standardAnswer.textContent.trim()) {
    elements.standardAnswer.textContent = "A speakable answer will appear here.";
    elements.standardAnswer.classList.add("empty");
  }
  renderUsefulPhrases([]);
  elements.shortAnswer.textContent = "";
  elements.shortAnswer.classList.add("hidden");
  elements.shortAnswerToggle.classList.add("hidden");
  elements.responseLatency.textContent = "";
  elements.responseLatency.classList.add("hidden");
  elements.responseLatency.classList.remove("slow");
}

function handleAnswerDelta(payload) {
  if (!payload || payload.requestId !== state.answerRequestId) return;
  const delta = String(payload.delta || "");
  state.streamingAnswerText += delta;
  state.answerText = state.streamingAnswerText;
  if (!state.firstAnswerDeltaReceived && state.streamingAnswerText.trim()) {
    state.firstAnswerDeltaReceived = true;
    const elapsedMs = Math.max(0, performance.now() - state.answerShownAt);
    elements.responseLatency.textContent = `Started ${(elapsedMs / 1000).toFixed(1)}s`;
    elements.responseLatency.classList.remove("hidden");
    elements.responseLatency.classList.toggle("slow", elapsedMs > 1000);
  }
  if (state.streamingAnswerText.trim()) {
    // Commit atomically on the first real delta. Until then the previous
    // answer remains visible; after that point every update is a replacement
    // of the same answer, never an empty intermediate state.
    state.displayedAnswerText = state.streamingAnswerText.trimStart();
    elements.standardAnswer.textContent = state.displayedAnswerText;
    elements.standardAnswer.classList.remove("empty");
    elements.standardAnswer.classList.remove("is-updating");
  }
}

function setFinalAnswer(answer) {
  const text = String(answer || state.answerText || "").trim();
  if (!text) return;
  state.answerText = text;
  state.streamingAnswerText = text;
  state.displayedAnswerText = text;
  elements.standardAnswer.textContent = text;
  elements.standardAnswer.classList.remove("empty", "is-updating");
  const short = text.split(/(?<=[.!?。！？])\s+/).slice(0, 2).join(" ").trim();
  if (short && short !== text) {
    elements.shortAnswer.textContent = short;
    elements.shortAnswerToggle.classList.remove("hidden");
  }
}

function questionKey(transcript) {
  return extractLatestQuestion(String(transcript || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

async function loadSettings() {
  const settings = await window.interviewOverlay.getSettings();
  state.settings = settings;
  state.cheatSheet = settings.cheatSheet || "";
  elements.cheatSheetInput.value = state.cheatSheet;
  elements.profileInput.value = settings.profile || "";
  elements.styleInput.value = settings.style || "";
  elements.responseModelInput.value = settings.responseModel || "gpt-5.6-sol";
  elements.transcriptionModelInput.value =
    settings.transcriptionModel || "gpt-transcribe";
  elements.opacityInput.value = String(Math.round((settings.opacity || 0.92) * 100));
  elements.opacityValue.textContent = `${elements.opacityInput.value}%`;
  elements.apiKeyHint.textContent = settings.hasApiKey
    ? "An encrypted API key is saved. Leave this blank to keep it."
    : "Stored with Windows encryption on this PC.";
  elements.protectionStatus.textContent = settings.contentProtected
    ? "Share protection: on · verify preview"
    : "Share protection: unavailable";
  elements.protectionStatus.classList.toggle("on", settings.contentProtected);
  renderUsage(await window.interviewOverlay.getUsage());
  if (!settings.hasApiKey) openSettings();
}

function openSettings() {
  elements.settingsDrawer.classList.remove("hidden");
}

function closeSettings() {
  elements.settingsDrawer.classList.add("hidden");
}

async function saveSettings() {
  hideError(elements.settingsError);
  elements.saveSettingsButton.disabled = true;
  elements.saveSettingsButton.textContent = "Saving…";
  try {
    state.settings = await window.interviewOverlay.saveSettings({
      apiKey: elements.apiKeyInput.value,
      profile: elements.profileInput.value,
      cheatSheet: elements.cheatSheetInput.value,
      style: elements.styleInput.value,
      responseModel: elements.responseModelInput.value,
      transcriptionModel: elements.transcriptionModelInput.value,
      opacity: Number(elements.opacityInput.value) / 100
    });
    elements.apiKeyInput.value = "";
    elements.apiKeyHint.textContent =
      "An encrypted API key is saved. Leave this blank to keep it.";
    closeSettings();
  } catch (error) {
    showError(elements.settingsError, error);
  } finally {
    elements.saveSettingsButton.disabled = false;
    elements.saveSettingsButton.textContent = "Save settings";
  }
}

async function testConnection() {
  hideError(elements.settingsError);
  elements.testKeyButton.disabled = true;
  elements.testKeyButton.textContent = "Testing…";
  try {
    await window.interviewOverlay.testApiKey(elements.apiKeyInput.value);
    elements.testKeyButton.textContent = "Connected";
    setTimeout(() => {
      elements.testKeyButton.textContent = "Test connection";
    }, 1800);
  } catch (error) {
    showError(elements.settingsError, error);
    elements.testKeyButton.textContent = "Test connection";
  } finally {
    elements.testKeyButton.disabled = false;
  }
}

async function importKnowledgeFiles(event) {
  const files = [...event.target.files];
  if (!files.length) return;
  const blocks = [];
  for (const file of files) {
    blocks.push(`\n\n--- ${file.name} ---\n${await file.text()}`);
  }
  elements.profileInput.value = `${elements.profileInput.value}${blocks.join("")}`.trim();
  event.target.value = "";
}

function monitorAudioLevel(stream) {
  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 1024;
  source.connect(state.analyser);
  const samples = new Uint8Array(state.analyser.fftSize);

  const measure = () => {
    if (!state.active || !state.analyser) return;
    state.analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / samples.length);
    if (rms > SPEECH_LEVEL_THRESHOLD) {
      state.heardSpeech = true;
      state.speechSinceWindow = true;
      state.lastSpeechAt = performance.now();
      resetIdleStopTimer(state.captureGeneration);
      scheduleSpeechFlush(state.captureGeneration);
    }
    state.levelFrame = requestAnimationFrame(measure);
  };
  measure();
}

function scheduleSpeechFlush(generation) {
  if (state.speechFlushTimer) clearTimeout(state.speechFlushTimer);
  state.speechFlushTimer = setTimeout(() => {
    state.speechFlushTimer = null;
    if (!isCurrentCapture(generation) || !state.speechSinceWindow) return;
    flushTranscriptionWindow(state.recorder, generation);
  }, SPEECH_FLUSH_SILENCE_MS);
}

function chooseMimeType() {
  const options = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function isCurrentCapture(generation) {
  return state.active && generation === state.captureGeneration;
}

function emitTranscriptionWindow(recorder, generation) {
  if (!isCurrentCapture(generation) || recorder !== state.recorder) return;
  const parts = state.audioParts;
  const range = getTranscriptionWindowRange(
    parts.length,
    state.lastWindowEnd,
    TRANSCRIPTION_WINDOW_PARTS,
    TRANSCRIPTION_OVERLAP_PARTS,
    TRANSCRIPTION_EMIT_EVERY_PARTS
  );
  if (!range) return;
  const selected = parts.slice(range.start, range.end);
  // MediaRecorder timeslice blobs after the first one can be WebM fragments
  // without the EBML/container header. The first window worked while later
  // windows could therefore be rejected or transcribed as empty. Prefix the
  // original header-bearing part whenever a window starts after part zero.
  if (range.start > 0 && state.audioHeaderPart) {
    selected.unshift(state.audioHeaderPart);
  }
  const blob = new Blob(selected, { type: recorder.mimeType || "audio/webm" });
  state.lastWindowEnd = range.nextWindowEnd;
  const hadSpeech = state.speechSinceWindow;
  const speechEndAt = state.lastSpeechAt;
  state.speechSinceWindow = false;
  if (hadSpeech && blob.size > 1000) enqueueChunk(blob, speechEndAt, generation);
}

function flushTranscriptionWindow(recorder, generation) {
  if (!isCurrentCapture(generation) || recorder !== state.recorder) return;
  const parts = state.audioParts;
  if (!state.speechSinceWindow || parts.length <= state.lastWindowEnd) return;
  const start = Math.max(0, state.lastWindowEnd - TRANSCRIPTION_OVERLAP_PARTS);
  const selected = parts.slice(start);
  if (start > 0 && state.audioHeaderPart) {
    selected.unshift(state.audioHeaderPart);
  }
  if (!selected.length) return;
  const blob = new Blob(selected, { type: recorder.mimeType || "audio/webm" });
  state.lastWindowEnd = parts.length;
  const speechEndAt = state.lastSpeechAt;
  state.speechSinceWindow = false;
  if (blob.size > 1000) enqueueChunk(blob, speechEndAt, generation);
}

function beginRecording() {
  if (!state.active || !state.stream) return;
  const generation = state.captureGeneration;
  const audioTracks = state.stream.getAudioTracks();
  if (!audioTracks.length) {
    stopInterview();
    setStatus("System audio was not available", false);
    return;
  }

  const mimeType = chooseMimeType();
  const recorder = new MediaRecorder(
    new MediaStream(audioTracks),
    mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined
  );
  state.audioParts = [];
  state.audioHeaderPart = null;
  state.lastWindowEnd = 0;
  state.speechSinceWindow = false;
  state.heardSpeech = false;
  state.recorder = recorder;
  recorder.addEventListener("dataavailable", (event) => {
    if (!isCurrentCapture(generation) || recorder !== state.recorder) return;
    if (!event.data.size) return;
    if (!state.audioHeaderPart) state.audioHeaderPart = event.data;
    state.audioParts.push(event.data);
    emitTranscriptionWindow(recorder, generation);
  });
  recorder.addEventListener(
    "stop",
    () => flushTranscriptionWindow(recorder, generation),
    { once: true }
  );
  recorder.start(RECORDING_TIMESLICE_MS);
}

function updateThinkingIndicator() {
  elements.thinkingIndicator.classList.toggle(
    "hidden",
    state.processing <= 0 && !state.answerInFlight
  );
}

function publishTranscript(rawTranscript, speechEndAt, generation) {
  if (!isCurrentCapture(generation)) return;
  const normalized = String(rawTranscript || "").replace(/\s+/g, " ").trim();
  const compactLength = normalized.replace(/[^\p{L}\p{N}]/gu, "").length;
  const isShortQuestion = /[?？]\s*$/.test(normalized) && compactLength >= 3;
  if (!normalized || (compactLength < 8 && !isShortQuestion)) return;
  if (/you are chatgpt|large language model|trained by openai/i.test(normalized)) return;

  const startsNewTurn = Boolean(
    state.lastProcessedSpeechEndAt &&
    speechEndAt &&
    speechEndAt - state.lastProcessedSpeechEndAt > NEW_QUESTION_SILENCE_MS
  );
  if (startsNewTurn) {
    state.rollingTranscript = "";
  }
  if (speechEndAt) state.lastProcessedSpeechEndAt = speechEndAt;

  const transcript = mergeTranscript(state.rollingTranscript, normalized);
  if (!transcript || transcript === state.rollingTranscript) return;
  state.rollingTranscript = transcript.length > 2800
    ? `…${transcript.slice(-2799).trim()}`
    : transcript;
  state.latestTranscript = transcript;
  updateForceAnswerButton();
  const isQuestion = containsInterviewQuestionSignal(normalized);
  if (!isQuestion) return;

  const candidateQuestion = extractLatestQuestion(normalized);
  if (
    shouldReplaceLockedQuestion(
      state.lockedQuestion,
      candidateQuestion,
      startsNewTurn
    )
  ) {
    state.lockedQuestion = candidateQuestion;
  }
  if (!state.lockedQuestion) return;

  elements.originalText.textContent = state.lockedQuestion;
  elements.originalText.classList.remove("empty");
  elements.languageBadge.textContent = "AUTO";
  scheduleAnswer(state.lockedQuestion, generation, true);
}

function scheduleAnswer(transcript, generation, priority = false, forced = false) {
  if (!isCurrentCapture(generation)) return;
  const key = questionKey(transcript);
  // Rolling transcription can report the same question several times while
  // it moves from "checking" to "confirmed". Do not start a second answer
  // for that same question; doing so is what made the displayed answer jump.
  if (!forced && key && key === state.lastScheduledQuestionKey) return;
  state.latestTranscript = transcript;
  state.lastScheduledQuestionKey = key;
  if (state.answerTimer) clearTimeout(state.answerTimer);
  const delay = priority ? PRIORITY_QUESTION_DELAY_MS : ANSWER_QUIET_PERIOD_MS;
  state.answerTimer = setTimeout(() => {
    state.answerTimer = null;
    if (!isCurrentCapture(generation)) return;
    state.pendingAnswer = { transcript, generation, forced };
    updateForceAnswerButton();
    runLatestAnswer();
  }, delay);
}

function forceGenerateAnswer() {
  if (!state.active) return;
  const question = String(state.lockedQuestion || state.latestTranscript || "").trim();
  const context = String(state.rollingTranscript || state.latestTranscript || "").trim();
  if (!question && !context) {
    setStatus("No interviewer speech is available yet");
    return;
  }

  const transcript = context && question && !context.includes(question)
    ? `${question}\nInterviewer follow-up: ${context}`
    : (context || question);

  if (state.answerTimer) clearTimeout(state.answerTimer);
  state.answerTimer = null;
  state.pendingAnswer = {
    transcript,
    generation: state.captureGeneration,
    forced: true
  };
  elements.intentText.textContent = state.answerInFlight
    ? "Answer queued"
    : "Generating answer now";
  elements.answerGuidance.textContent = "現在の質問と補足から回答を作成します。";
  elements.answerGuidance.classList.add("is-pending");
  updateForceAnswerButton();
  runLatestAnswer();
}

function trackTask(set, task) {
  set.add(task);
  task.then(
    () => set.delete(task),
    () => set.delete(task)
  );
  return task;
}

function flushTranscriptionResults(generation) {
  if (generation !== state.captureGeneration) return;
  while (state.transcriptionResults.has(state.nextTranscriptionSequence)) {
    const result = state.transcriptionResults.get(state.nextTranscriptionSequence);
    state.transcriptionResults.delete(state.nextTranscriptionSequence);
    state.nextTranscriptionSequence += 1;
    if (result.transcript) {
      publishTranscript(result.transcript, result.speechEndAt, generation);
    }
  }
}

function pumpTranscriptionQueue() {
  while (
    state.active &&
    state.transcriptionInFlight < TRANSCRIPTION_MAX_IN_FLIGHT &&
    state.transcriptionPending.length
  ) {
    const item = state.transcriptionPending.shift();
    state.transcriptionInFlight += 1;
    state.processing += 1;
    updateThinkingIndicator();
    elements.thinkingIndicator.classList.remove("hidden");
    setStatus("Listening · transcribing");

    const task = (async () => {
      let transcript = "";
      try {
        if (!isCurrentCapture(item.generation)) return;
        const arrayBuffer = await item.blob.arrayBuffer();
        const result = await window.interviewOverlay.transcribeAudioChunk({
          arrayBuffer,
          mimeType: item.blob.type || "audio/webm"
        });
        transcript = String(result.transcript || "").trim();
      } catch (error) {
        if (isCurrentCapture(item.generation)) {
          setStatus(error.message || "Could not process audio", false);
        }
      } finally {
        if (item.generation === state.captureGeneration) {
          state.transcriptionResults.set(item.sequence, {
            transcript,
            speechEndAt: item.speechEndAt
          });
          state.transcriptionInFlight = Math.max(0, state.transcriptionInFlight - 1);
          state.processing = Math.max(0, state.processing - 1);
          flushTranscriptionResults(item.generation);
          pumpTranscriptionQueue();
          updateThinkingIndicator();
          if (state.processing <= 0 && !state.answerInFlight) {
            elements.thinkingIndicator.classList.add("hidden");
            if (state.active) setStatus("Listening");
          }
        }
      }
    })();
    trackTask(state.pendingWork, task);
  }
}

function enqueueChunk(blob, speechEndAt = 0, generation = state.captureGeneration) {
  if (!isCurrentCapture(generation)) return;
  state.transcriptionPending.push({
    blob,
    speechEndAt,
    generation,
    sequence: ++state.transcriptionSequence
  });
  pumpTranscriptionQueue();
}

async function runLatestAnswer() {
  if (state.answerInFlight || !state.pendingAnswer) return;
  const job = state.pendingAnswer;
  state.pendingAnswer = null;
  updateForceAnswerButton();
  if (!isCurrentCapture(job.generation)) return;

  state.answerInFlight = true;
  updateThinkingIndicator();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const history = recentHistory();
  beginAnswerDisplay(job.transcript, requestId);
  setStatus("Listening · answer streaming");

  const task = (async () => {
    const answerResult = await window.interviewOverlay.streamAnswer({
      requestId,
      transcript: job.transcript,
      recentHistory: history,
      forced: Boolean(job.forced)
    });
    if (!isCurrentCapture(job.generation) || requestId !== state.answerRequestId) return;
    setFinalAnswer(answerResult.answer);

    let analysis;
    try {
      analysis = (
        await window.interviewOverlay.analyzeTranscript({
          transcript: job.transcript,
          answer: state.answerText,
          recentHistory: history
        })
      ).analysis;
    } catch {
      analysis = {
        language: "en",
        original: job.transcript,
        japanese: "",
        intent: "Response",
        should_answer: true,
        key_points: [],
        useful_phrases: [],
        caution: ""
      };
    }
    if (!isCurrentCapture(job.generation) || requestId !== state.answerRequestId) return;
    updateAnalysisMetadata(analysis, job.transcript);
    state.entries.push({
      id: `interview-${Date.now()}-${state.entries.length}`,
      createdAt: new Date().toISOString(),
      time: formatTime(),
      ...analysis,
      original: job.transcript,
      answer_short: elements.shortAnswer.textContent || "",
      answer_standard: state.answerText,
      useful_phrases: analysis.useful_phrases || []
    });
    elements.minutesButton.disabled = false;
  })()
    .catch((error) => {
      if (isCurrentCapture(job.generation)) {
        setStatus(error.message || "Could not prepare an answer", false);
      }
    })
    .finally(() => {
      if (job.generation === state.captureGeneration) {
        state.answerInFlight = false;
        // If the next question was detected while the current answer was in
        // analysis, keep the completed answer stable until the next answer
        // has a real first token to commit.
        if (state.displayedAnswerText.trim()) {
          elements.standardAnswer.textContent = state.displayedAnswerText;
          elements.standardAnswer.classList.remove("is-updating");
        }
        updateThinkingIndicator();
        setStatus("Listening");
        if (state.pendingAnswer) runLatestAnswer();
        updateForceAnswerButton();
      }
    });
  trackTask(state.answerTasks, task);
}

async function startInterview() {
  if (state.active) {
    await stopInterview();
    return;
  }
  if (!state.settings?.hasApiKey) {
    openSettings();
    showError(elements.settingsError, new Error("Add and save your OpenAI API key first."));
    return;
  }

  try {
    setStatus("Connecting to system audio", true);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });
    stream.getVideoTracks().forEach((track) => track.stop());
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("System audio capture was not available.");
    }
    state.stream = stream;
    state.active = true;
    state.captureGeneration += 1;
    state.processing = 0;
    state.transcriptionPending = [];
    state.transcriptionResults = new Map();
    state.transcriptionInFlight = 0;
    state.transcriptionSequence = 0;
    state.nextTranscriptionSequence = 1;
    if (state.speechFlushTimer) clearTimeout(state.speechFlushTimer);
    state.speechFlushTimer = null;
    state.pendingAnswer = null;
    state.lastScheduledQuestionKey = "";
    state.answerInFlight = false;
    state.lastSpeechAt = 0;
    state.lastProcessedSpeechEndAt = 0;
    state.rollingTranscript = "";
    state.latestTranscript = "";
    state.lockedQuestion = "";
    updateForceAnswerButton();
    resetIdleStopTimer(state.captureGeneration);
    elements.startButton.classList.add("recording");
    elements.startButton.innerHTML = '<span class="button-dot"></span>Stop interview';
    elements.minutesButton.disabled = state.entries.length === 0;
    setStatus("Listening");
    monitorAudioLevel(stream);
    beginRecording();
  } catch (error) {
    state.active = false;
    setStatus(error.message || "Could not start audio capture", false);
  }
}

async function stopInterview(statusMessage = "Stopped") {
  state.captureGeneration += 1;
  state.active = false;
  state.processing = 0;
  if (state.answerTimer) clearTimeout(state.answerTimer);
  state.transcriptionPending = [];
  state.transcriptionResults.clear();
  state.answerTimer = null;
  if (state.idleStopTimer) clearTimeout(state.idleStopTimer);
  state.idleStopTimer = null;
  if (state.speechFlushTimer) clearTimeout(state.speechFlushTimer);
  state.speechFlushTimer = null;
  state.answerRequestId = "";
  state.pendingAnswer = null;
  if (state.recorder?.state === "recording") state.recorder.stop();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  cancelAnimationFrame(state.levelFrame);
  state.levelFrame = null;
  state.analyser = null;
  if (state.audioContext && state.audioContext.state !== "closed") {
    await state.audioContext.close();
  }
  state.audioContext = null;
  state.recorder = null;
  state.rollingTranscript = "";
  state.latestTranscript = "";
  state.lockedQuestion = "";
  state.answerInFlight = false;
  updateThinkingIndicator();
  elements.startButton.classList.remove("recording");
  elements.startButton.innerHTML = '<span class="button-dot"></span>Start interview';
  updateForceAnswerButton();
  setStatus(statusMessage, false);
}

async function finishAndCreateNotes() {
  if (state.active) await stopInterview();
  elements.notesModal.classList.remove("hidden");
  elements.notesLoading.classList.remove("hidden");
  elements.notesContent.classList.add("hidden");
  elements.exportNotesButton.disabled = true;
  hideError(elements.notesError);
  try {
    await Promise.allSettled([...state.pendingWork]);
    await Promise.allSettled([...state.answerTasks]);
    const notes = await window.interviewOverlay.generateMinutes(state.entries);
    elements.notesContent.value = notes;
    elements.notesLoading.classList.add("hidden");
    elements.notesContent.classList.remove("hidden");
    elements.exportNotesButton.disabled = false;
  } catch (error) {
    elements.notesLoading.classList.add("hidden");
    showError(elements.notesError, error);
  }
}

async function exportNotes() {
  elements.exportNotesButton.disabled = true;
  try {
    await window.interviewOverlay.exportMinutes(elements.notesContent.value);
  } finally {
    elements.exportNotesButton.disabled = false;
  }
}

function toggleCheatSheet() {
  elements.cheatSheetPanel.classList.toggle("hidden");
  if (!elements.cheatSheetPanel.classList.contains("hidden")) {
    elements.cheatSheetInput.focus();
  }
}

async function saveCheatSheet() {
  elements.cheatSheetStatus.textContent = "Saving…";
  try {
    state.settings = await window.interviewOverlay.saveCheatSheet(
      elements.cheatSheetInput.value
    );
    state.cheatSheet = elements.cheatSheetInput.value;
    elements.cheatSheetStatus.textContent = "Saved";
    setTimeout(() => {
      elements.cheatSheetStatus.textContent = "";
    }, 1400);
  } catch (error) {
    elements.cheatSheetStatus.textContent = error.message || "Could not save";
  }
}

async function exportPhraseMemory() {
  elements.phraseMemoryButton.disabled = true;
  try {
    const result = await window.interviewOverlay.exportPhraseMemory(state.entries);
    if (!result.canceled) {
      elements.phraseMemoryButton.textContent = `Exported ${result.count}`;
      setTimeout(() => {
        elements.phraseMemoryButton.textContent = "Export for Phrase Memory";
      }, 1600);
    }
  } finally {
    elements.phraseMemoryButton.disabled = false;
  }
}

async function toggleClickThrough() {
  state.clickThrough = await window.interviewOverlay.setClickThrough(
    !state.clickThrough
  );
  elements.clickThroughButton.classList.toggle("active", state.clickThrough);
  elements.clickThroughButton.textContent = state.clickThrough
    ? "Click-through on · Ctrl+Shift+T to edit"
    : "Click-through off";
}

function bindEvents() {
  elements.settingsButton.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.saveSettingsButton.addEventListener("click", saveSettings);
  elements.testKeyButton.addEventListener("click", testConnection);
  elements.knowledgeFileInput.addEventListener("change", importKnowledgeFiles);
  elements.startButton.addEventListener("click", startInterview);
  elements.forceAnswerButton.addEventListener("click", forceGenerateAnswer);
  elements.minutesButton.addEventListener("click", finishAndCreateNotes);
  elements.closeNotesButton.addEventListener("click", () =>
    elements.notesModal.classList.add("hidden")
  );
  elements.resumeButton.addEventListener("click", () =>
    elements.notesModal.classList.add("hidden")
  );
  elements.exportNotesButton.addEventListener("click", exportNotes);
  elements.phraseMemoryButton.addEventListener("click", exportPhraseMemory);
  elements.clickThroughButton.addEventListener("click", toggleClickThrough);
  elements.cheatSheetButton.addEventListener("click", toggleCheatSheet);
  elements.closeCheatSheetButton.addEventListener("click", () =>
    elements.cheatSheetPanel.classList.add("hidden")
  );
  elements.saveCheatSheetButton.addEventListener("click", saveCheatSheet);
  elements.refreshUsageButton.addEventListener("click", async () => {
    elements.refreshUsageButton.disabled = true;
    try {
      renderUsage(await window.interviewOverlay.getUsage());
    } finally {
      elements.refreshUsageButton.disabled = false;
    }
  });
  elements.openUsageButton.addEventListener("click", () =>
    window.interviewOverlay.openUsageDashboard()
  );
  elements.minimizeButton.addEventListener("click", () =>
    window.interviewOverlay.minimize()
  );
  elements.closeButton.addEventListener("click", () =>
    window.interviewOverlay.close()
  );
  elements.opacityInput.addEventListener("input", async () => {
    elements.opacityValue.textContent = `${elements.opacityInput.value}%`;
    await window.interviewOverlay.setOpacity(
      Number(elements.opacityInput.value) / 100
    );
  });
  elements.shortAnswerToggle.addEventListener("click", () => {
    const hidden = elements.shortAnswer.classList.toggle("hidden");
    elements.shortAnswerToggle.textContent = hidden
      ? "Show short answer"
      : "Hide short answer";
  });
  window.interviewOverlay.onClickThroughChanged((enabled) => {
    state.clickThrough = enabled;
    elements.clickThroughButton.classList.toggle("active", enabled);
    elements.clickThroughButton.textContent = enabled
      ? "Click-through on · Ctrl+Shift+T to edit"
      : "Click-through off";
  });
  window.interviewOverlay.onAnswerDelta(handleAnswerDelta);
  window.interviewOverlay.onUsageUpdated(renderUsage);
}

async function init() {
  bindEvents();
  try {
    await loadSettings();
    setStatus("Ready", false);
  } catch (error) {
    setStatus("Settings could not be loaded", false);
    openSettings();
    showError(elements.settingsError, error);
  }
}

init();
