import {
  APP_VERSION,
  MODES,
  buildMicrophoneErrorMessage,
  buildStatusText,
  cleanText,
  formatRecordingElapsed,
  resolveMode,
  resolveVoiceSubmission,
  selectCopyText,
  trimHistory,
  validateRuntimeConfig
} from "./core.js?v=20260704-micflow";

const MAX_RECORDING_SECONDS = 60;
const MICROPHONE_OPEN_TIMEOUT_MS = 8000;
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
  stream: null,
  chunks: [],
  startedAt: 0,
  timerFrame: null,
  autoStopTimer: null,
  canPackageAudio: false,
  recordingToken: 0,
  streamReady: false,
  currentResult: null,
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
  registerServiceWorker();
}

function setMode(mode) {
  if (state.workflow === "recording") {
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

  await startRecording();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    fail("This browser cannot open the microphone. Please use Safari on iPhone with HTTPS.");
    return;
  }

  const token = state.recordingToken + 1;
  state.recordingToken = token;
  state.recorder = null;
  state.stream = null;
  state.streamReady = false;
  state.chunks = [];
  state.canPackageAudio = false;
  beginRecordingUI();
  showError("");
  showWarning("Opening microphone...");

  try {
    const submission = resolveVoiceSubmission(loadConfig());
    const stream = await requestMicrophoneStream();
    if (token !== state.recordingToken || state.workflow !== "recording") {
      stopStream(stream);
      return;
    }

    state.stream = stream;
    state.streamReady = true;
    showWarning(submission.canUpload
      ? ""
      : "You can test recording now. Transcription will start after Worker settings are added.");
    startMediaRecorderIfAvailable();
    state.autoStopTimer = window.setTimeout(stopRecording, MAX_RECORDING_SECONDS * 1000);
  } catch (error) {
    if (token !== state.recordingToken) {
      return;
    }
    stopRecordingUI();
    stopTracks();
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
    state.recorder.stop();
  } else {
    submitRecordedAudio();
  }
  stopTracks();
  stopRecordingUI();
  window.clearTimeout(state.autoStopTimer);
  state.autoStopTimer = null;
}

async function submitRecordedAudio() {
  const mimeType = state.chunks[0]?.type || "audio/webm";
  const audio = new Blob(state.chunks, { type: mimeType });
  state.chunks = [];

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
  const response = await fetch(`${config.workerUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      "x-laospeak-code": config.accessCode
    }
  });
  const data = await response.json().catch(() => ({}));

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
    .catch(() => fail("Copy failed. Please select the text and copy manually."));
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
  elements.statusText.textContent = buildStatusText(state.workflow, mode.id);
  elements.recordButtonText.textContent = state.workflow === "recording" ? "Stop Recording" : "Start Recording";
  elements.voiceStage.hidden = mode.id === MODES.chineseToLao.id;
  elements.textStage.hidden = mode.id !== MODES.chineseToLao.id;
  elements.shell.classList.toggle("is-recording", state.workflow === "recording");

  elements.modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode.id);
  });

  const busy = ["recording", "transcribing", "translating"].includes(state.workflow);
  elements.copyButton.disabled = !selectCopyText(state.mode, state.currentResult);
  elements.translateTextButton.disabled = busy;

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
    const mode = resolveMode(record.mode);
    const preview = selectCopyText(record.mode, record) || record.transcript || "Saved result";
    button.innerHTML = `<strong>${mode.title}</strong><span></span>`;
    button.querySelector("span").textContent = preview;
    button.addEventListener("click", () => {
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

function updateTimer() {
  elements.timerText.textContent = formatRecordingElapsed(state.startedAt, Date.now(), MAX_RECORDING_SECONDS);
}

function beginRecordingUI() {
  state.startedAt = Date.now();
  setWorkflow("recording");
  updateTimer();
  tickRecordingTimer();
}

function tickRecordingTimer() {
  if (state.workflow !== "recording") {
    return;
  }

  updateTimer();
  state.timerFrame = window.requestAnimationFrame(tickRecordingTimer);
}

function stopRecordingUI() {
  if (state.timerFrame) {
    window.cancelAnimationFrame(state.timerFrame);
  }
  state.timerFrame = null;
}

function startMediaRecorderIfAvailable() {
  if (typeof MediaRecorder === "undefined") {
    showWarning("Microphone is active. This iPhone browser cannot package audio until a compatible recorder is available.");
    return;
  }

  try {
    const mimeType = preferredAudioMimeType();
    state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.chunks.push(event.data);
      }
    });
    state.recorder.addEventListener("stop", submitRecordedAudio);
    state.recorder.start();
    state.canPackageAudio = true;
  } catch {
    state.recorder = null;
    state.canPackageAudio = false;
    showWarning("Microphone is active. Audio packaging failed on this browser, so this is recording-test mode for now.");
  }
}

function stopTracks() {
  stopStream(state.stream);
  state.stream = null;
  state.streamReady = false;
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function requestMicrophoneStream() {
  const request = navigator.mediaDevices.getUserMedia({ audio: true });
  const timeout = new Promise((_, reject) => {
    window.setTimeout(() => {
      reject(Object.assign(new Error("Microphone request timed out."), { name: "TimeoutError" }));
    }, MICROPHONE_OPEN_TIMEOUT_MS);
  });

  request.then((stream) => {
    if (state.workflow !== "recording") {
      stopStream(stream);
    }
  }).catch(() => {});

  return Promise.race([request, timeout]);
}

function preferredAudioMimeType() {
  const types = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
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
