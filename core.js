export const APP_VERSION = "20260710-sessionguard";

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
  finalizing: "finalizing",
  transcribing: "transcribing",
  translating: "translating",
  completed: "completed",
  failed: "failed"
});

export const STATE_LABELS = Object.freeze({
  idle: "Ready",
  recording: "Listening",
  finalizing: "Finishing recording",
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

export function isWorkflowBusy(workflow) {
  return [
    WORKFLOW_STATES.recording,
    WORKFLOW_STATES.finalizing,
    WORKFLOW_STATES.transcribing,
    WORKFLOW_STATES.translating
  ].includes(workflow);
}

export function getWorkflowInteractionState(workflow, hasCopyText) {
  const busy = isWorkflowBusy(workflow);

  return {
    busy,
    canChangeMode: !busy,
    canUseRecordButton: !busy || workflow === WORKFLOW_STATES.recording,
    canTranslate: !busy,
    canClear: !busy,
    canCopy: !busy && Boolean(hasCopyText),
    canOpenHistory: !busy
  };
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

export function formatClientDiagnosticLines(diagnostics = {}) {
  const displayMode = cleanText(diagnostics.displayMode) || "unknown";
  const visibilityState = cleanText(diagnostics.visibilityState) || "unknown";
  let standalone = "unknown";

  if (diagnostics.isStandalone === true) {
    standalone = "yes";
  } else if (diagnostics.isStandalone === false) {
    standalone = "no";
  }

  return [
    `Browser shell: ${displayMode}`,
    `Standalone PWA: ${standalone}`,
    `Visibility: ${visibilityState}`
  ];
}

export function buildMicrophoneOpeningDiagnostic(elapsedMs, timeoutMs = 8000) {
  const elapsedSeconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000));
  const timeoutSeconds = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));
  return `Open wait: ${elapsedSeconds}s/${timeoutSeconds}s`;
}

export function buildTaskTimeoutErrorMessage(timeoutMs = 30000) {
  const timeoutSeconds = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));
  return `Background task did not finish within ${timeoutSeconds}s. Input has been unlocked; please try again.`;
}

export function runWithTimeout(operation, timeoutMs = 30000, onTimeout) {
  const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        onTimeout?.();
      } catch {
        // The timeout path must still unlock the UI even if cleanup throws.
      }
      reject(new Error(buildTaskTimeoutErrorMessage(safeTimeoutMs)));
    }, safeTimeoutMs);

    const finish = (complete, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      complete(value);
    };

    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
  });
}

export function raceWithTimeout(request, timeoutMs, createTimeoutError, timers = globalThis) {
  const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      reject(createTimeoutError());
    }, safeTimeoutMs);
  });

  return Promise.race([request, timeout]).finally(() => {
    timers.clearTimeout(timer);
  });
}

export function requestJSONWithTimeout(request, timeoutMs = 30000, onTimeout) {
  return runWithTimeout(async () => {
    const response = await request();
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }, timeoutMs, onTimeout);
}

export async function stopMediaRecorderWithTimeout(recorder, timeoutMs = 2000) {
  let handleStop;
  let handleError;

  try {
    await runWithTimeout(() => new Promise((resolve, reject) => {
      handleStop = () => resolve();
      handleError = (event) => reject(event?.error ?? new Error("Audio recorder failed while stopping."));
      recorder.addEventListener("stop", handleStop, { once: true });
      recorder.addEventListener("error", handleError, { once: true });
      recorder.stop();
    }), timeoutMs);
  } finally {
    if (handleStop) {
      recorder.removeEventListener("stop", handleStop);
    }
    if (handleError) {
      recorder.removeEventListener("error", handleError);
    }
  }
}

export function createRecorderSession(recorder, onChunk) {
  const chunks = [];
  let chunkBytes = 0;
  let closed = false;

  function handleDataAvailable(event) {
    const chunk = event?.data;
    if (closed || !chunk || chunk.size <= 0) {
      return;
    }

    chunks.push(chunk);
    chunkBytes += chunk.size;
    onChunk?.({ chunkCount: chunks.length, chunkBytes });
  }

  function snapshot() {
    return { chunks: [...chunks], chunkBytes };
  }

  recorder.addEventListener("dataavailable", handleDataAvailable);

  return {
    snapshot,
    close() {
      if (!closed) {
        closed = true;
        recorder.removeEventListener("dataavailable", handleDataAvailable);
      }
      return snapshot();
    }
  };
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
    return "Microphone permission was denied. Open this page in Safari, set Microphone to Allow or Ask in Website Settings, and try again. (NotAllowedError)";
  }

  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "No microphone was found. Check the iPhone microphone permission and try again.";
  }

  if (errorName === "TimeoutError") {
    return "The microphone request timed out before Safari returned an audio stream. Open this page in Safari, check this site's Microphone setting, then try Safari before Home Screen. (TimeoutError)";
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
