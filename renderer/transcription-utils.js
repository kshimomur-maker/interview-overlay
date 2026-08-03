(function attachTranscriptionUtils(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.TranscriptionUtils = factory();
})(typeof window !== "undefined" ? window : globalThis, function createTranscriptionUtils() {
  function normalizeTranscript(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function repairLikelyInterviewQuestion(value) {
    const text = normalizeTranscript(value);
    if (!text) return "";

    // Speech recognition sometimes drops the final word in a familiar
    // interview phrase. Only repair a narrow, high-confidence pattern so a
    // legitimate question about customers is not broadly rewritten.
    return text.replace(
      /\b(what(?:'s| is) your impression of) good customers?(\s*[?？]?)$/i,
      "$1 good customer service$2"
    );
  }

  function mergeTranscript(previous, incoming) {
    const next = normalizeTranscript(incoming);
    const current = normalizeTranscript(previous);
    if (!current) return next;
    if (!next) return current;
    if (current.toLowerCase().endsWith(next.toLowerCase())) return current;

    const currentWords = current.split(" ");
    const nextWords = next.split(" ");
    const maxOverlap = Math.min(12, currentWords.length, nextWords.length);
    for (let size = maxOverlap; size >= 2; size -= 1) {
      const left = currentWords
        .slice(-size)
        .join(" ")
        .toLowerCase()
        .replace(/[.,!?]/g, "");
      const right = nextWords
        .slice(0, size)
        .join(" ")
        .toLowerCase()
        .replace(/[.,!?]/g, "");
      if (left === right) {
        return `${current} ${nextWords.slice(size).join(" ")}`.trim();
      }
    }
    return `${current} ${next}`.trim();
  }

  function getTranscriptionWindowRange(
    partCount,
    lastWindowEnd,
    windowParts,
    overlapParts,
    emitEveryParts
  ) {
    const count = Math.max(0, Number(partCount) || 0);
    const previousEnd = Math.max(0, Number(lastWindowEnd) || 0);
    const windowSize = Math.max(1, Number(windowParts) || 1);
    const overlap = Math.min(windowSize - 1, Math.max(0, Number(overlapParts) || 0));
    const emitEvery = Math.max(1, Number(emitEveryParts) || 1);

    if (count < windowSize || count - previousEnd < emitEvery) return null;

    return {
      start: Math.max(0, previousEnd - overlap),
      end: count,
      nextWindowEnd: count
    };
  }

  function extractLatestQuestion(value, maxChars = 320) {
    const text = repairLikelyInterviewQuestion(value);
    if (!text) return "";

    const questionMark = Math.max(text.lastIndexOf("?"), text.lastIndexOf("？"));
    if (questionMark >= 0) {
      const prefix = text.slice(0, questionMark);
      const boundary = Math.max(
        prefix.lastIndexOf(". "),
        prefix.lastIndexOf("! "),
        prefix.lastIndexOf("。"),
        prefix.lastIndexOf("！")
      );
      return text.slice(boundary + (prefix[boundary] === " " ? 2 : 1), questionMark + 1).trim();
    }

    const signalPatterns = [
      /\bcan you tell me about your\s*self\b/i,
      /\btell me (a little |a bit |more )?about your\s*self\b/i,
      /\bwalk me through your (resume|background|experience)\b/i,
      /\btell me more about your background\b/i,
      /\bgive me (a quick )?(overview|summary) of your background\b/i,
      /\bwhy are you interested in (this|the) (role|position|job)\b/i,
      /\bwhy do you want to work (here|with us)\b/i,
      /\bwhy should we hire you\b/i
    ];
    let signalIndex = -1;
    for (const pattern of signalPatterns) {
      const match = pattern.exec(text);
      if (match && match.index > signalIndex) signalIndex = match.index;
    }
    if (signalIndex > 0) return text.slice(signalIndex).trim();

    if (text.length <= maxChars) return text;
    return `…${text.slice(-Math.max(40, maxChars - 1)).trim()}`;
  }

  function containsInterviewQuestionSignal(value) {
    const text = normalizeTranscript(value).toLowerCase();
    if (!text) return false;
    if (/[?？]\s*$/.test(text)) return true;
    return [
      /\btell me (a little |a bit |more )?about your\s*self\b/,
      /\bcan you tell me about your\s*self\b/,
      /\bwalk me through your (resume|background|experience)\b/,
      /\btell me more about your background\b/,
      /\bgive me (a quick )?(overview|summary) of your background\b/,
      /\bwhy are you interested in (this|the) (role|position|job)\b/,
      /\bwhy do you want to work (here|with us)\b/,
      /\bwhy should we hire you\b/,
      /\bhow (do|would|can) you handle\b/,
      /\bfor (our|the) customer(s)?\b.*\bhandle\b/i,
      /\bcustomer(s)?\b.*\bhandle\b/i,
      /\b(what|why|how|when|where|who|which)\b/,
      /\b(can|could|would|will|do|did|have|has|are|is|were|was) you\b/,
      /\b(describe|explain|share|give me|talk me through)\b/
    ].some((pattern) => pattern.test(text));
  }

  function shouldReplaceLockedQuestion(currentQuestion, candidateQuestion, newTurn) {
    const current = normalizeTranscript(currentQuestion);
    const candidate = normalizeTranscript(candidateQuestion);
    if (!candidate) return false;
    if (!current) return true;
    if (!newTurn) return false;

    const compact = (value) => value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .trim();
    const currentKey = compact(current);
    const candidateKey = compact(candidate);
    return Boolean(candidateKey && candidateKey !== currentKey);
  }

  return {
    normalizeTranscript,
    repairLikelyInterviewQuestion,
    mergeTranscript,
    getTranscriptionWindowRange,
    extractLatestQuestion,
    containsInterviewQuestionSignal,
    shouldReplaceLockedQuestion
  };
});
