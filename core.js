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
