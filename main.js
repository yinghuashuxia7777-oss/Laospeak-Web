import {
  MODES,
  buildStatusText,
  cleanText,
  resolveMode,
  selectCopyText,
  trimHistory,
  validateRuntimeConfig
} from "./core.js";

const MAX_RECORDING_SECONDS = 60;
const HISTORY_DAYS = 3;
const CONFIG_KEY = "laospeak.web.config.v1";
const HISTORY_KEY = "laospeak.web.history.v1";

const elements = {
  shell: document.querySelector(".app-shell"),
  settingsToggle: document.querySelector("#settingsToggle"),
  setupPanel: document.querySelector("#setupPanel"),
  workerUrlInput: document.querySelector("#workerUrlInput"),
  accessCodeInput: document.querySelector("#accessCodeInput"),
  saveConfigButton: document.querySelector("#saveConfigButton"),
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
  timer: null,
  autoStopTimer: null,
  currentResult: null,
  history: loadHistory()
};

init();

function init() {
  const config = loadConfig();
  elements.workerUrlInput.value = config.workerUrl;
  elements.accessCodeInput.value = config.accessCode;
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
  const config = getValidConfig();
  if (!config) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    fail("This browser cannot record audio. Please use Safari on iPhone with HTTPS.");
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = preferredAudioMimeType();
    state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    state.chunks = [];
    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.chunks.push(event.data);
      }
    });
    state.recorder.addEventListener("stop", () => submitRecordedAudio(config));
    state.recorder.start();
    state.startedAt = Date.now();
    setWorkflow("recording");
    state.timer = window.setInterval(updateTimer, 250);
    state.autoStopTimer = window.setTimeout(stopRecording, MAX_RECORDING_SECONDS * 1000);
  } catch (error) {
    fail(error?.name === "NotAllowedError"
      ? "Microphone permission was denied. Allow microphone access and try again."
      : "Could not start the microphone. Please try again.");
  }
}

function stopRecording() {
  if (state.recorder && state.recorder.state !== "inactive") {
    state.recorder.stop();
  }
  stopTracks();
  window.clearInterval(state.timer);
  window.clearTimeout(state.autoStopTimer);
  state.timer = null;
  state.autoStopTimer = null;
}

async function submitRecordedAudio(config) {
  const mimeType = state.chunks[0]?.type || "audio/webm";
  const audio = new Blob(state.chunks, { type: mimeType });
  state.chunks = [];

  if (audio.size < 512) {
    fail("No clear audio was recorded. Please try again closer to the microphone.");
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

    const data = await requestWorker(config, "/api/voice", {
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
  const elapsed = Math.min(MAX_RECORDING_SECONDS, Math.floor((Date.now() - state.startedAt) / 1000));
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  elements.timerText.textContent = `${minutes}:${seconds}`;
}

function stopTracks() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
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
