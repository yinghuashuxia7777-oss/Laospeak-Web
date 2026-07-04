export const APP_VERSION = "20260704-micdebug";

export const MODES = Object.freeze({
  speechToText: Object.freeze({
    id: "speech-to-text",
    title: "Lao Speech to Text",
    shortTitle: "Speech"
  }),
  laoToChinese: Object.freeze({
    id: "lao-to-chinese",
    title: "Lao to Chinese",
    shortTitle: "Lao -> CN"
  }),
  chineseToLao: Object.freeze({
    id: "chinese-to-lao",
    title: "Chinese to Lao",
    shortTitle: "CN -> Lao"
  })
});

export const WORKFLOW_STATES = Object.freeze({
  idle: "idle",
  recording: "recording",
  transcribing: "transcribing",
  translating: "translating",
  completed: "completed",
  failed: "failed"
});

export const STATE_LABELS = Object.freeze({
  idle: "Ready",
  recording: "Listening",
  transcribing: "Understanding Lao speech",
  translating: "Translating",
  completed: "Completed",
  failed: "Needs your attention"
});

const ALL_MODES = Object.freeze(Object.values(MODES));

export function resolveMode(mode) {
  return ALL_MODES.find((candidate) => candidate.id === mode) ?? MODES.laoToChinese;
}

export function buildStatusText(state, mode) {
  if (state === WORKFLOW_STATES.translating && mode === MODES.chineseToLao.id) {
    return "Writing natural Lao";
  }

  if (state === WORKFLOW_STATES.translating && mode === MODES.laoToChinese.id) {
    return "Writing natural Chinese";
  }

  return STATE_LABELS[state] ?? STATE_LABELS.idle;
}

export function buildRecordingStatusText(isStreamReady) {
  return isStreamReady ? STATE_LABELS.recording : "Opening microphone";
}

export function formatMicrophoneDiagnosticLines(diagnostics = {}) {
  const permissionState = cleanText(diagnostics.permissionState) || "unavailable";
  const supportedMimeTypes = Array.isArray(diagnostics.supportedMimeTypes)
    ? diagnostics.supportedMimeTypes.filter((type) => cleanText(type))
    : [];

  return [
    `Secure context: ${diagnostics.isSecureContext ? "yes" : "no"}`,
    `mediaDevices: ${diagnostics.hasMediaDevices ? "available" : "unavailable"}`,
    `getUserMedia: ${diagnostics.hasGetUserMedia ? "available" : "unavailable"}`,
    `MediaRecorder: ${diagnostics.hasMediaRecorder ? "available" : "unavailable"}`,
    `Permission: ${permissionState}`,
    `Supported audio: ${supportedMimeTypes.length > 0 ? supportedMimeTypes.join(", ") : "none"}`
  ];
}

export function selectCopyText(mode, result = {}) {
  const resolvedMode = resolveMode(mode);

  if (resolvedMode.id === MODES.speechToText.id) {
    return cleanText(result.transcript);
  }

  if (resolvedMode.id === MODES.chineseToLao.id) {
    return firstCleanText(result.shareText, result.laoShareText, result.laoMeaning, result.laoText);
  }

  return firstCleanText(result.polishedChinese, result.chineseTranslation, result.chineseMeaning, result.transcript);
}

export function trimHistory(records, now = new Date(), retentionDays = 3) {
  const cutoffTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  return records
    .filter((record) => {
      const createdTime = new Date(record.createdAt).getTime();
      return Number.isFinite(createdTime) && createdTime >= cutoffTime;
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function validateRuntimeConfig(config = {}) {
  const workerUrl = cleanText(config.workerUrl).replace(/\/+$/, "");
  const accessCode = cleanText(config.accessCode);

  if (!workerUrl || !accessCode) {
    return {
      ok: false,
      workerUrl,
      accessCode,
      message: "Add the Worker URL and access code in Settings first."
    };
  }

  return {
    ok: true,
    workerUrl,
    accessCode,
    message: ""
  };
}

export function resolveVoiceSubmission(config = {}) {
  const validated = validateRuntimeConfig(config);

  if (!validated.ok) {
    return {
      canUpload: false,
      workerUrl: validated.workerUrl,
      accessCode: validated.accessCode,
      message: "Recording captured. Add the Worker URL and access code in Settings before transcription can run."
    };
  }

  return {
    canUpload: true,
    workerUrl: validated.workerUrl,
    accessCode: validated.accessCode,
    message: ""
  };
}

export function formatRecordingElapsed(startedAt, now = Date.now(), maxSeconds = 60) {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const cappedSeconds = Math.min(maxSeconds, elapsedSeconds);
  const minutes = String(Math.floor(cappedSeconds / 60)).padStart(2, "0");
  const seconds = String(cappedSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function buildMicrophoneErrorMessage(error) {
  const errorName = cleanText(error?.name);

  if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
    return "Microphone permission was denied. Open this page in Safari, allow microphone access, and try again. (NotAllowedError)";
  }

  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "No microphone was found. Check the iPhone microphone permission and try again.";
  }

  if (errorName === "TimeoutError") {
    return "The microphone request timed out. Open the page in Safari, check microphone permission for this site, then try again. (TimeoutError)";
  }

  return `Could not start the microphone. Open this page in Safari over HTTPS and try again. Browser error: ${errorName || "UnknownError"}.`;
}

export function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstCleanText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) {
      return text;
    }
  }

  return "";
}
