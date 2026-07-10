import {
  APP_VERSION,
  MODES,
  buildMicrophoneErrorMessage,
  buildMicrophoneOpeningDiagnostic,
  buildRecordingStatusText,
  buildStatusText,
  cleanText,
  createRecorderSession,
  formatClientDiagnosticLines,
  formatMicrophoneDiagnosticLines,
  formatRecordingElapsed,
  getWorkflowInteractionState,
  isWorkflowBusy,
  raceWithTimeout,
  requestJSONWithTimeout,
  resolveMode,
  resolveVoiceSubmission,
  selectCopyText,
  stopMediaRecorderWithTimeout,
  trimHistory,
  validateRuntimeConfig
} from "./core.js?v=20260710-sessionguard";

const MAX_RECORDING_SECONDS = 60;
const MICROPHONE_OPEN_TIMEOUT_MS = 8000;
const RECORDER_STOP_TIMEOUT_MS = 2000;
const WORKER_REQUEST_TIMEOUT_MS = 30000;
const AUDIO_MIME_TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
const HISTORY_DAYS = 3;
const CONFIG_KEY = "laospeak.web.config.v1";
const HISTORY_KEY = "laospeak.web.history.v1";

const elements = {
  shell: document.querySelector(".app-shell"),
  settingsToggle: document.querySelector("#settingsToggle"),
  setupPanel: document.querySelector("#setupPanel"),
  workerUrlInput: document.querySelector("#workerUrlInput"),
  accessCodeInput: document.querySelector("#accessCodeInput"),
  versionBadge: document.querySelector("#versionBadge"),
  saveConfigButton: document.querySelector("#saveConfigButton"),
  resetCacheButton: document.querySelector("#resetCacheButton"),
  modeButtons: [...document.querySelectorAll(".mode-button")],
  modeTitle: document.querySelector("#modeTitle"),
  statusText: document.querySelector("#statusText"),
  timerText: document.querySelector("#timerText"),
  voiceStage: document.querySelector("#voiceStage"),
  textStage: document.querySelector("#textStage"),
  recordButton: document.querySelector("#recordButton"),
  recordButtonText: document.querySelector("#recordButtonText"),
  chineseTextInput: document.querySelector("#chineseTextInput"),
  translateTextButton: document.querySelector("#translateTextButton"),
  warningBar: document.querySelector("#warningBar"),
  errorBar: document.querySelector("#errorBar"),
  diagnosticPanel: document.querySelector("#diagnosticPanel"),
  micDebugText: document.querySelector("#micDebugText"),
  transcriptCard: document.querySelector("#transcriptCard"),
  translationCard: document.querySelector("#translationCard"),
  polishedCard: document.querySelector("#polishedCard"),
  laoCard: document.querySelector("#laoCard"),
  transcriptText: document.querySelector("#transcriptText"),
  translationText: document.querySelector("#translationText"),
  polishedText: document.querySelector("#polishedText"),
  laoText: document.querySelector("#laoText"),
  copyButton: document.querySelector("#copyButton"),
  clearButton: document.querySelector("#clearButton"),
  historyList: document.querySelector("#historyList"),
  clearHistoryButton: document.querySelector("#clearHistoryButton")
};

const state = {
  mode: MODES.laoToChinese.id,
  workflow: "idle",
  recorder: null,
  recorderSession: null,
  stream: null,
  startedAt: 0,
  timerInterval: null,
  openingInterval: null,
  openStartedAt: 0,
  autoStopTimer: null,
  canPackageAudio: false,
  recordingToken: 0,
  streamReady: false,
  currentResult: null,
  micDebug: [],
  history: loadHistory()
};

init();

function init() {
  const config = loadConfig();
  elements.workerUrlInput.value = config.workerUrl;
  elements.accessCodeInput.value = config.accessCode;
  elements.versionBadge.textContent = APP_VERSION;
  elements.setupPanel.hidden = Boolean(config.workerUrl && config.accessCode);

  elements.settingsToggle.addEventListener("click", () => {
    elements.setupPanel.hidden = !elements.setupPanel.hidden;
  });

  elements.saveConfigButton.addEventListener("click", () => {
    saveConfig({
      workerUrl: elements.workerUrlInput.value,
      accessCode: elements.accessCodeInput.value
    });
    showError("");
    elements.setupPanel.hidden = true;
  });
  elements.resetCacheButton.addEventListener("click", resetAppCache);

  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  elements.recordButton.addEventListener("click", toggleRecording);
  elements.translateTextButton.addEventListener("click", translateChineseText);
  elements.copyButton.addEventListener("click", copyCurrentResult);
  elements.clearButton.addEventListener("click", clearCurrentResult);
  elements.clearHistoryButton.addEventListener("click", clearHistory);

  render();
  refreshMicrophoneDiagnostics("Ready");
  registerServiceWorker();
}

function setMode(mode) {
  if (isWorkflowBusy(state.workflow)) {
    return;
  }

  state.mode = resolveMode(mode).id;
  clearCurrentResult();
  render();
}

async function toggleRecording() {
  if (state.workflow === "recording") {
    stopRecording();
    return;
  }

  if (isWorkflowBusy(state.workflow)) {
    return;
  }

  await startRecording();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    refreshMicrophoneDiagnostics("Unsupported browser");
    fail("This browser cannot open the microphone. Please use Safari on iPhone with HTTPS.");
    return;
  }

  const token = state.recordingToken + 1;
  state.recordingToken = token;
  state.recorderSession?.close();
  state.recorder = null;
  state.recorderSession = null;
  state.stream = null;
  state.streamReady = false;
  state.canPackageAudio = false;
  beginMicrophoneOpeningUI();
  showError("");
  showWarning("Opening microphone...");
  setBaseMicrophoneDiagnostics("Start tapped", "not checked before request");
  setMicDebugLine("Mic request", "Mic request: sent");
  const streamRequest = requestMicrophoneStream();
  refreshMicrophonePermissionLine();

  try {
    const submission = resolveVoiceSubmission(loadConfig());
    const stream = await streamRequest;
    if (token !== state.recordingToken || state.workflow !== "recording") {
      stopStream(stream);
      return;
    }

    state.stream = stream;
    state.streamReady = true;
    observeAudioTracks(stream);
    setMicDebugLine("Stream", `Stream: connected (${stream.getAudioTracks().length} audio track${stream.getAudioTracks().length === 1 ? "" : "s"})`);
    beginActiveRecordingUI();
    showWarning(submission.canUpload
      ? "Microphone connected. Speak now."
      : "Microphone connected. You can test recording now. Transcription will start after Worker settings are added.");
    startMediaRecorderIfAvailable();
    state.autoStopTimer = window.setTimeout(stopRecording, MAX_RECORDING_SECONDS * 1000);
  } catch (error) {
    if (token !== state.recordingToken) {
      return;
    }
    stopRecordingUI();
    stopTracks();
    setMicDebugLine("Stream", `Stream: failed (${cleanText(error?.name) || "UnknownError"})`);
    fail(buildMicrophoneErrorMessage(error));
  }
}

async function resetAppCache() {
  showError("");
  showWarning("Refreshing Miw cache...");

  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }

    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("miw-laospeak"))
          .map((name) => caches.delete(name))
      );
    }
  } catch {
    showWarning("Cache refresh was attempted. Reloading now.");
  }

  const refreshUrl = new URL(window.location.href);
  refreshUrl.searchParams.set("v", APP_VERSION);
  refreshUrl.searchParams.set("refresh", String(Date.now()));
  window.location.replace(refreshUrl.toString());
}

function stopRecording() {
  state.recordingToken += 1;
  if (!state.streamReady && !state.recorder) {
    stopTracks();
    stopRecordingUI();
    window.clearTimeout(state.autoStopTimer);
    state.autoStopTimer = null;
    setWorkflow("idle");
    showWarning("Microphone opening was cancelled.");
    return;
  }

  if (state.recorder && state.recorder.state !== "inactive") {
    setWorkflow("finalizing");
    finalizeRecorderAndSubmit(state.recorder, state.recorderSession);
  } else {
    const recording = closeRecorderSession(state.recorderSession);
    state.recorder = null;
    submitRecordedAudio(recording);
  }
  stopTracks();
  stopRecordingUI();
  window.clearTimeout(state.autoStopTimer);
  state.autoStopTimer = null;
}

async function finalizeRecorderAndSubmit(recorder, recorderSession) {
  let stoppedNormally = false;
  try {
    await stopMediaRecorderWithTimeout(recorder, RECORDER_STOP_TIMEOUT_MS);
    stoppedNormally = true;
  } catch (error) {
    setMicDebugLine("Recorder", `Recorder: stop fallback (${cleanText(error?.name) || "TimeoutError"})`);
  }

  const recording = closeRecorderSession(recorderSession);
  if (stoppedNormally) {
    setMicDebugLine("Recorder", `Recorder: stopped (${recording.chunks.length} chunk${recording.chunks.length === 1 ? "" : "s"})`);
  }
  state.recorder = null;
  await submitRecordedAudio(recording);
}

function closeRecorderSession(recorderSession) {
  const recording = recorderSession?.close() ?? { chunks: [], chunkBytes: 0 };
  if (state.recorderSession === recorderSession) {
    state.recorderSession = null;
  }
  return recording;
}

async function submitRecordedAudio(recording) {
  const mimeType = recording.chunks[0]?.type || "audio/webm";
  const audio = new Blob(recording.chunks, { type: mimeType });

  if (!state.canPackageAudio || audio.size < 512) {
    const submission = resolveVoiceSubmission(loadConfig());
    if (!submission.canUpload) {
      elements.setupPanel.hidden = false;
      setWorkflow("idle");
      showError("");
      showWarning("Microphone test finished. Add Worker settings before transcription can run.");
      return;
    }

    fail("No clear audio was recorded. Please try again closer to the microphone.");
    return;
  }

  const submission = resolveVoiceSubmission(loadConfig());
  if (!submission.canUpload) {
    elements.setupPanel.hidden = false;
    setWorkflow("idle");
    showError("");
    showWarning(submission.message);
    return;
  }

  setWorkflow("transcribing");
  const translatingTimer = window.setTimeout(() => {
    if (state.workflow === "transcribing" && state.mode === MODES.laoToChinese.id) {
      setWorkflow("translating");
    }
  }, 900);

  try {
    const form = new FormData();
    form.append("mode", state.mode);
    form.append("audio", audio, `laospeak.${fileExtensionForMimeType(mimeType)}`);

    const data = await requestWorker(submission, "/api/voice", {
      method: "POST",
      body: form
    });
    window.clearTimeout(translatingTimer);
    receiveResult(data.result ?? data);
  } catch (error) {
    window.clearTimeout(translatingTimer);
    fail(error.message || "Network request failed. Please try again.");
  }
}

async function translateChineseText() {
  const config = getValidConfig();
  if (!config) {
    return;
  }

  const text = cleanText(elements.chineseTextInput.value);
  if (!text) {
    fail("Paste or type Chinese text first.");
    return;
  }

  setWorkflow("translating");
  try {
    const data = await requestWorker(config, "/api/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    receiveResult(data.result ?? data);
  } catch (error) {
    fail(error.message || "Network request failed. Please try again.");
  }
}

async function requestWorker(config, path, options) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const { response, data } = await requestJSONWithTimeout(
    () => fetch(`${config.workerUrl}${path}`, {
      ...options,
      signal: controller?.signal,
      headers: {
        ...(options.headers ?? {}),
        "x-laospeak-code": config.accessCode
      }
    }),
    WORKER_REQUEST_TIMEOUT_MS,
    () => controller?.abort()
  );

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "The translation service returned an error.");
  }

  return data;
}

function receiveResult(result) {
  state.currentResult = {
    ...result,
    mode: state.mode,
    createdAt: new Date().toISOString()
  };
  setWorkflow("completed");
  showError("");
  showWarning(buildWarning(result));
  saveHistoryRecord(state.currentResult);
  renderResults();
  renderHistory();
}

function buildWarning(result) {
  const confidence = result?.confidence ?? "high";
  const notes = Array.isArray(result?.uncertaintyNotes) ? result.uncertaintyNotes.filter(Boolean) : [];
  if (confidence === "high" && notes.length === 0) {
    return "";
  }
  const prefix = confidence === "low" ? "Uncertain result:" : "Some parts may be uncertain:";
  return [prefix, ...notes].join(" ");
}

function copyCurrentResult() {
  if (isWorkflowBusy(state.workflow)) {
    return;
  }

  const text = selectCopyText(state.mode, state.currentResult);
  if (!text) {
    fail("There is no result to copy yet.");
    return;
  }

  navigator.clipboard.writeText(text)
    .then(() => {
      elements.copyButton.textContent = "Copied";
      window.setTimeout(() => {
        elements.copyButton.textContent = "Copy Result";
      }, 1200);
    })
    .catch(() => showError("Copy failed. Please select the text and copy manually."));
}

function clearCurrentResult() {
  state.currentResult = null;
  showError("");
  showWarning("");
  setWorkflow("idle");
  renderResults();
}

function clearHistory() {
  state.history = [];
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
}

function setWorkflow(workflow) {
  state.workflow = workflow;
  render();
}

function fail(message) {
  setWorkflow("failed");
  showWarning("");
  showError(message);
}

function render() {
  const mode = resolveMode(state.mode);
  elements.modeTitle.textContent = mode.title;
  elements.statusText.textContent = state.workflow === "recording"
    ? buildRecordingStatusText(state.streamReady)
    : buildStatusText(state.workflow, mode.id);
  elements.recordButtonText.textContent = state.workflow === "recording"
    ? (state.streamReady ? "Stop Recording" : "Cancel")
    : (state.workflow === "finalizing" ? "Finishing..." : "Start Recording");
  elements.voiceStage.hidden = mode.id === MODES.chineseToLao.id;
  elements.textStage.hidden = mode.id !== MODES.chineseToLao.id;
  elements.shell.classList.toggle("is-recording", state.workflow === "recording");

  elements.modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode.id);
  });

  const copyText = selectCopyText(state.mode, state.currentResult);
  const interaction = getWorkflowInteractionState(state.workflow, Boolean(copyText));
  elements.modeButtons.forEach((button) => {
    button.disabled = !interaction.canChangeMode;
  });
  elements.recordButton.disabled = !interaction.canUseRecordButton;
  elements.copyButton.disabled = !interaction.canCopy;
  elements.translateTextButton.disabled = !interaction.canTranslate;
  elements.clearButton.disabled = !interaction.canClear;

  renderResults();
  renderHistory();
}

function renderResults() {
  const result = state.currentResult ?? {};
  const showTranscript = Boolean(result.transcript);
  const showTranslation = Boolean(result.chineseTranslation);
  const showPolished = Boolean(result.polishedChinese);
  const laoResult = cleanText(result.shareText || result.laoShareText || result.laoMeaning || result.laoText);

  elements.transcriptCard.hidden = !showTranscript;
  elements.translationCard.hidden = !showTranslation;
  elements.polishedCard.hidden = !showPolished;
  elements.laoCard.hidden = !laoResult;

  elements.transcriptText.textContent = result.transcript ?? "";
  elements.translationText.textContent = result.chineseTranslation ?? "";
  elements.polishedText.textContent = result.polishedChinese ?? "";
  elements.laoText.textContent = laoResult;
}

function renderHistory() {
  state.history = trimHistory(state.history, new Date(), HISTORY_DAYS);
  if (state.history.length === 0) {
    elements.historyList.innerHTML = `<p class="setup-note">No recent records yet.</p>`;
    return;
  }

  elements.historyList.replaceChildren(...state.history.slice(0, 8).map((record) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.disabled = isWorkflowBusy(state.workflow);
    const mode = resolveMode(record.mode);
    const preview = selectCopyText(record.mode, record) || record.transcript || "Saved result";
    button.innerHTML = `<strong>${mode.title}</strong><span></span>`;
    button.querySelector("span").textContent = preview;
    button.addEventListener("click", () => {
      if (isWorkflowBusy(state.workflow)) {
        return;
      }

      state.mode = record.mode;
      state.currentResult = record;
      setWorkflow("completed");
      showWarning(buildWarning(record));
      render();
    });
    return button;
  }));
}

function showError(message) {
  elements.errorBar.hidden = !message;
  elements.errorBar.textContent = message;
}

function showWarning(message) {
  elements.warningBar.hidden = !message;
  elements.warningBar.textContent = message;
}

function refreshMicrophoneDiagnostics(stage) {
  setBaseMicrophoneDiagnostics(stage, "checking");
  refreshMicrophonePermissionLine();
}

function setBaseMicrophoneDiagnostics(stage, permissionState) {
  state.micDebug = [
    `Build: ${APP_VERSION}`,
    `Stage: ${stage}`,
    ...formatClientDiagnosticLines({
      displayMode: getDisplayMode(),
      isStandalone: isStandaloneWebApp(),
      visibilityState: document.visibilityState
    }),
    ...formatMicrophoneDiagnosticLines({
      isSecureContext: window.isSecureContext,
      hasMediaDevices: Boolean(navigator.mediaDevices),
      hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
      hasMediaRecorder: typeof MediaRecorder !== "undefined",
      permissionState,
      supportedMimeTypes: getSupportedAudioMimeTypes()
    })
  ];
  renderMicDebug();
}

function refreshMicrophonePermissionLine() {
  readMicrophonePermissionState().then((permissionState) => {
    setMicDebugLine("Permission", `Permission: ${permissionState}`);
  });
}

async function readMicrophonePermissionState() {
  try {
    if (!navigator.permissions?.query) {
      return "unavailable";
    }

    const status = await Promise.race([
      navigator.permissions.query({ name: "microphone" }),
      new Promise((resolve) => {
        window.setTimeout(() => resolve(null), 600);
      })
    ]);
    return cleanText(status?.state) || "unknown";
  } catch {
    return "unavailable";
  }
}

function setMicDebugLine(key, message) {
  const prefix = `${key}:`;
  const index = state.micDebug.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) {
    state.micDebug[index] = message;
  } else {
    state.micDebug.push(message);
  }
  renderMicDebug();
}

function renderMicDebug() {
  if (!elements.diagnosticPanel || !elements.micDebugText) {
    return;
  }

  elements.diagnosticPanel.hidden = state.micDebug.length === 0;
  elements.micDebugText.textContent = state.micDebug.join("\n");
}

function updateTimer() {
  const elapsed = formatRecordingElapsed(state.startedAt, Date.now(), MAX_RECORDING_SECONDS);
  elements.timerText.textContent = elapsed;
  if (state.workflow === "recording" && state.streamReady) {
    setMicDebugLine("Timer", `Timer: ${elapsed}`);
  }
}

function updateOpeningWait() {
  if (!state.openStartedAt) {
    return;
  }

  const elapsedMs = Date.now() - state.openStartedAt;
  elements.timerText.textContent = formatRecordingElapsed(
    state.openStartedAt,
    Date.now(),
    Math.ceil(MICROPHONE_OPEN_TIMEOUT_MS / 1000)
  );
  if (state.workflow === "recording" && !state.streamReady) {
    setMicDebugLine("Open wait", buildMicrophoneOpeningDiagnostic(elapsedMs, MICROPHONE_OPEN_TIMEOUT_MS));
  }
}

function beginMicrophoneOpeningUI() {
  state.startedAt = 0;
  state.openStartedAt = Date.now();
  setWorkflow("recording");
  elements.timerText.textContent = "00:00";
  updateOpeningWait();
  state.openingInterval = window.setInterval(updateOpeningWait, 250);
}

function beginActiveRecordingUI() {
  stopOpeningTimer();
  state.startedAt = Date.now();
  setWorkflow("recording");
  updateTimer();
  setMicDebugLine("Timer", "Timer: started");
  state.timerInterval = window.setInterval(updateTimer, 250);
}

function stopRecordingUI() {
  stopOpeningTimer();
  if (state.timerInterval) {
    window.clearInterval(state.timerInterval);
  }
  state.timerInterval = null;
  state.startedAt = 0;
}

function stopOpeningTimer() {
  if (state.openingInterval) {
    window.clearInterval(state.openingInterval);
  }
  state.openingInterval = null;
  state.openStartedAt = 0;
}

function startMediaRecorderIfAvailable() {
  if (typeof MediaRecorder === "undefined") {
    setMicDebugLine("Recorder", "Recorder: unavailable");
    showWarning("Microphone is active. This iPhone browser cannot package audio until a compatible recorder is available.");
    return;
  }

  let recorderSession;
  try {
    const mimeType = preferredAudioMimeType();
    state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    setMicDebugLine("Recorder", `Recorder: created (${state.recorder.mimeType || mimeType || "browser default"})`);
    recorderSession = createRecorderSession(state.recorder, ({ chunkCount, chunkBytes }) => {
      setMicDebugLine("Chunks", `Chunks: ${chunkCount}, bytes=${chunkBytes}`);
    });
    state.recorderSession = recorderSession;
    state.recorder.start();
    setMicDebugLine("Recorder", `Recorder: ${state.recorder.state}`);
    state.canPackageAudio = true;
  } catch (error) {
    recorderSession?.close();
    state.recorder = null;
    state.recorderSession = null;
    state.canPackageAudio = false;
    setMicDebugLine("Recorder", `Recorder: failed (${cleanText(error?.name) || "UnknownError"})`);
    showWarning("Microphone is active. Audio packaging failed on this browser, so this is recording-test mode for now.");
  }
}

function observeAudioTracks(stream) {
  const tracks = stream.getAudioTracks();
  tracks.forEach((track, index) => {
    const key = `Track ${index + 1}`;
    const describeTrack = () => `${key}: ${track.readyState}, enabled=${track.enabled}, muted=${track.muted}`;
    setMicDebugLine(key, describeTrack());
    track.addEventListener("ended", () => setMicDebugLine(key, `${key}: ended`));
    track.addEventListener("mute", () => setMicDebugLine(key, `${key}: muted`));
    track.addEventListener("unmute", () => setMicDebugLine(key, describeTrack()));
  });
}

function stopTracks() {
  stopStream(state.stream);
  state.stream = null;
  state.streamReady = false;
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function getDisplayMode() {
  const modes = ["fullscreen", "standalone", "minimal-ui", "browser"];
  return modes.find((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches) ?? "unknown";
}

function isStandaloneWebApp() {
  return Boolean(window.navigator.standalone) || getDisplayMode() === "standalone";
}

function requestMicrophoneStream() {
  const request = navigator.mediaDevices.getUserMedia({ audio: true });

  request.then((stream) => {
    if (state.workflow !== "recording") {
      stopStream(stream);
    }
  }).catch(() => {});

  return raceWithTimeout(
    request,
    MICROPHONE_OPEN_TIMEOUT_MS,
    () => Object.assign(new Error("Microphone request timed out."), { name: "TimeoutError" })
  );
}

function preferredAudioMimeType() {
  return getSupportedAudioMimeTypes()[0] ?? "";
}

function getSupportedAudioMimeTypes() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return [];
  }

  return AUDIO_MIME_TYPES.filter((type) => MediaRecorder.isTypeSupported(type));
}

function fileExtensionForMimeType(mimeType) {
  if (mimeType.includes("mp4")) {
    return "m4a";
  }
  if (mimeType.includes("webm")) {
    return "webm";
  }
  return "audio";
}

function getValidConfig() {
  const config = validateRuntimeConfig(loadConfig());
  if (!config.ok) {
    elements.setupPanel.hidden = false;
    fail(config.message);
    return null;
  }
  return config;
}

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) ?? { workerUrl: "", accessCode: "" };
  } catch {
    return { workerUrl: "", accessCode: "" };
  }
}

function saveConfig(config) {
  const validated = validateRuntimeConfig(config);
  localStorage.setItem(CONFIG_KEY, JSON.stringify({
    workerUrl: validated.workerUrl,
    accessCode: validated.accessCode
  }));
}

function loadHistory() {
  try {
    const records = JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
    return trimHistory(records, new Date(), HISTORY_DAYS);
  } catch {
    return [];
  }
}

function saveHistoryRecord(record) {
  state.history = trimHistory([record, ...state.history], new Date(), HISTORY_DAYS).slice(0, 30);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}
