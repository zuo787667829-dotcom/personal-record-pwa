import { buildCsv, buildExportEnvelope, calculateOvertimeMinutes, markDeleted, normalizeName, restoreDeleted } from "./core.js";
import { transcribeAudio } from "./voice-client.js";
import { voiceConfig } from "./voice-config.js";

const DB_NAME = "shiji-pwa";
const DB_VERSION = 1;
const SCHEMA_VERSION = "1.0.0";
const DAY_MS = 24 * 60 * 60 * 1000;

const state = {
  db: null,
  entries: [],
  categories: [],
  tags: [],
  projects: [],
  currentEntryId: null,
  captureMode: "text",
  captureCategoryId: "",
  captureTagIds: [],
  searchTagIds: [],
  currentFilteredEntryIds: [],
  recording: false,
  recorder: null,
  mediaStream: null,
  audioChunks: [],
  pendingAudioBlob: null,
  discardRecording: false,
  capturePrepared: false,
  voiceGeneration: 0,
  voiceBusy: false,
  voiceStarting: false,
  rawTranscript: null,
  voiceMessage: "",
  voiceAbort: null,
  recordingTimer: null,
  recordingStartedAt: 0
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const newId = () => crypto.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const nowIso = () => new Date().toISOString();
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const activeEntries = () => state.entries.filter(entry => !entry.deleted_at);
const trashedEntries = () => state.entries.filter(entry => entry.deleted_at);
const entryDate = entry => entry.occurred_at || entry.created_at;
const findCategory = id => state.categories.find(item => item.id === id);
const findProject = id => state.projects.find(item => item.id === id);
const findTag = id => state.tags.find(item => item.id === id);
const entryTags = entry => (entry.tag_ids || []).map(findTag).filter(Boolean);
const rawContent = entry => entry.source_type === "voice" ? (entry.raw_transcript || "") : (entry.raw_text || "");

function isoLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function inputToUtc(value) {
  return value ? new Date(value).toISOString() : null;
}

function formatDateTime(value) {
  if (!value) return "未设置时间";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDay(value) {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(value));
}

function monthKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function captureDateSuffix() {
  const localDate = $("#capture-time").value.slice(0, 10) || isoLocal(new Date()).slice(0, 10);
  return localDate.replaceAll("-", "");
}

function generatedCaptureTitle() {
  const suffix = captureDateSuffix();
  const typed = $("#capture-entry-title").value.trim();
  const categoryName = findCategory(state.captureCategoryId)?.name;
  const base = typed || (categoryName ? `${categoryName}随记` : "随记");
  return base.endsWith(`_${suffix}`) ? base : `${base}_${suffix}`;
}

function updateCaptureTitlePreview() {
  $("#capture-title-preview").textContent = `保存为：${generatedCaptureTitle()}`;
}

function summary(entry) {
  const raw = rawContent(entry) || (entry.transcription_status === "pending" ? "语音待转写" : "暂无原始文本");
  return entry.title || raw.slice(0, 38) + (raw.length > 38 ? "…" : "");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "id" });
      if (!db.objectStoreNames.contains("categories")) db.createObjectStore("categories", { keyPath: "id" });
      if (!db.objectStoreNames.contains("tags")) {
        const store = db.createObjectStore("tags", { keyPath: "id" });
        store.createIndex("normalized_name", "normalized_name", { unique: true });
      }
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "entry_id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let request;
    try { request = action(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("本地保存失败"));
  });
}

const dbGetAll = store => dbRequest(store, "readonly", objectStore => objectStore.getAll());
const dbPut = (store, value) => dbRequest(store, "readwrite", objectStore => objectStore.put(value));
const dbDelete = (store, key) => dbRequest(store, "readwrite", objectStore => objectStore.delete(key));

async function seedMetadata() {
  const categories = await dbGetAll("categories");
  if (!categories.length) {
    const names = ["工作", "生活", "人际", "家庭", "学习"];
    for (const [index, name] of names.entries()) {
      await dbPut("categories", { id: `category-${index + 1}`, name, sort_order: index, is_active: true, created_at: nowIso(), updated_at: nowIso() });
    }
  }
  const tags = await dbGetAll("tags");
  if (!tags.length) {
    const names = ["加班", "返工", "沟通", "老板决策", "临时任务", "工作错误", "项目管理", "工作方法", "项目复盘"];
    for (const name of names) await dbPut("tags", makeTag(name));
  }
}

function makeTag(name) {
  const timestamp = nowIso();
  return { id: newId(), name: name.trim(), normalized_name: normalizeName(name), is_active: true, created_at: timestamp, updated_at: timestamp };
}

function makeProject(name) {
  const timestamp = nowIso();
  return { id: newId(), name: name.trim(), is_archived: false, created_at: timestamp, updated_at: timestamp };
}

async function loadState() {
  [state.entries, state.categories, state.tags, state.projects] = await Promise.all([
    dbGetAll("entries"), dbGetAll("categories"), dbGetAll("tags"), dbGetAll("projects")
  ]);
  state.categories.sort((a, b) => a.sort_order - b.sort_order);
  state.tags.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  state.projects.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function purgeExpiredTrash() {
  const expired = state.entries.filter(entry => entry.purge_after && new Date(entry.purge_after).getTime() <= Date.now());
  for (const entry of expired) {
    await dbDelete("entries", entry.id);
    await dbDelete("audio", entry.id);
  }
  if (expired.length) await loadState();
}

function setStatus() {
  const status = $("#app-status");
  const pending = state.entries.filter(entry => entry.sync_status !== "synced").length;
  status.className = "prototype-note status-local";
  status.textContent = navigator.onLine
    ? `仅保存在本机 · ${pending} 条待云端配置 · 请定期导出`
    : `离线模式 · ${pending} 条保存在本机 · 联网后仍需配置云端同步`;
  $("#sync-status").textContent = navigator.onLine ? "仅本机" : "离线";
}

function optionMarkup(items, blankText, currentId = "") {
  const available = items.filter(item => item.is_active !== false && item.is_archived !== true || item.id === currentId);
  return `<option value="">${escapeHtml(blankText)}</option>` + available.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
}

function renderPicker(container, items, selectedIds, onClick) {
  container.innerHTML = items.map(item => `<button class="chip ${selectedIds.includes(item.id) ? "selected" : ""}" type="button" data-value="${item.id}" aria-pressed="${selectedIds.includes(item.id)}">${escapeHtml(item.name)}</button>`).join("");
  container.querySelectorAll("button").forEach(button => button.addEventListener("click", () => onClick(button.dataset.value)));
}

function recordCard(entry) {
  const category = findCategory(entry.category_id);
  const project = findProject(entry.project_id);
  const tags = entryTags(entry);
  const meta = [category ? `<span class="tag category">${escapeHtml(category.name)}</span>` : "", ...tags.map(tag => `<span class="tag">${escapeHtml(tag.name)}</span>`), project ? `<span class="tag">主题：${escapeHtml(project.name)}</span>` : ""].join("");
  const sourceLabel = entry.source_type === "voice" ? (entry.transcription_status === "completed" ? "语音" : "语音·待转写") : "文字";
  return `<button class="card record-card" type="button" data-entry="${entry.id}"><span class="tiny">${formatDateTime(entryDate(entry))} · ${sourceLabel}</span><div class="summary"><strong>${escapeHtml(summary(entry))}</strong></div><div class="meta">${meta}<span class="tag">待同步</span></div></button>`;
}

function bindRecordCards(root) {
  root.querySelectorAll("[data-entry]").forEach(card => card.addEventListener("click", () => {
    state.currentEntryId = card.dataset.entry;
    go("detail");
  }));
}

function go(screen, options = {}) {
  if (screen !== "capture" && state.voiceStarting) {
    state.voiceGeneration++;
    state.voiceStarting = false;
    updateVoiceButton(); updateSaveState();
  }
  if (screen !== "capture" && state.recording) stopRecording();
  $$(".screen").forEach(element => element.classList.toggle("active", element.dataset.screen === screen));
  $$(".nav-btn").forEach(button => {
    const selected = button.id === "nav-voice" ? screen === "capture" : button.dataset.go === screen;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const focusFlow = screen === "detail";
  $(".prototype-shell").classList.toggle("focus-flow", focusFlow);
  $(".bottom-nav").classList.toggle("flow-hidden", focusFlow);
  if (screen === "capture" && !state.capturePrepared) {
    prepareCapture(options.mode || "voice", options.autoRecord || false);
    state.capturePrepared = true;
  }
  if (screen === "home") renderHome();
  if (screen === "timeline") renderTimeline();
  if (screen === "detail") renderDetail(options.openStructure || false);
  window.scrollTo(0, 0);
}

function renderHome() {
  $("#home-date").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
  const entries = activeEntries().sort((a, b) => new Date(entryDate(b)) - new Date(entryDate(a)));
  const recentCategories = [...new Set(entries.map(entry => entry.category_id).filter(Boolean))].map(findCategory).filter(Boolean).slice(0, 4);
  $("#recent-categories").innerHTML = recentCategories.length
    ? recentCategories.map(item => `<button class="chip" type="button" data-category="${item.id}">${escapeHtml(item.name)}</button>`).join("")
    : `<span class="tiny">记录后会显示最近分类</span>`;
  $("#recent-categories").querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    $("#search-category").value = button.dataset.category;
    go("timeline");
  }));
  const todayKey = new Date().toDateString();
  const today = entries.filter(entry => new Date(entryDate(entry)).toDateString() === todayKey).slice(0, 3);
  $("#home-records").innerHTML = today.length ? today.map(recordCard).join("") : `<div class="empty">今天还没有记录</div>`;
  bindRecordCards($("#home-records"));
  setStatus();
}

function resetCapture() {
  state.voiceGeneration++;
  state.voiceAbort?.abort();
  state.voiceBusy = false;
  state.voiceStarting = false;
  state.rawTranscript = null;
  state.voiceMessage = "";
  $("#raw-text").value = "";
  $("#voice-transcript").value = "";
  $("#transcript-wrap").hidden = false;
  $("#new-tag-name").value = "";
  $("#new-project-name").value = "";
  $("#capture-entry-title").value = "";
  state.captureCategoryId = "";
  state.captureTagIds = [];
  state.pendingAudioBlob = null;
  state.recording = false;
  $("#capture-time").value = isoLocal(new Date());
  updateVoiceButton();
  renderCapturePickers();
  updateCaptureTitlePreview();
  updateSaveState();
}

function prepareCapture(mode, autoRecord) {
  resetCapture();
  setCaptureMode(mode);
  if (mode === "text") setTimeout(() => $("#raw-text").focus(), 0);
  if (mode === "voice" && autoRecord) startRecording();
}

function setCaptureMode(mode) {
  if (mode !== "voice" && state.recording) stopRecording();
  if (mode !== "voice" && state.voiceStarting) { state.voiceGeneration++; state.voiceStarting = false; updateVoiceButton(); }
  state.captureMode = mode;
  $("#capture-title").textContent = mode === "voice" ? "语音记录" : "文字记录";
  $("#capture-mode-note").textContent = mode === "voice" ? "停止后可编辑" : "只需正文";
  $("#text-mode").classList.toggle("active", mode === "text");
  $("#voice-mode").classList.toggle("active", mode === "voice");
  $("#text-mode").setAttribute("aria-selected", String(mode === "text"));
  $("#voice-mode").setAttribute("aria-selected", String(mode === "voice"));
  $("#text-panel").classList.toggle("hidden", mode !== "text");
  $("#voice-panel").classList.toggle("active", mode === "voice");
  $("#transcript-wrap").hidden = mode !== "voice";
  updateSaveState();
}

function renderCapturePickers() {
  renderPicker($("#capture-categories"), state.categories.filter(item => item.is_active), state.captureCategoryId ? [state.captureCategoryId] : [], id => {
    state.captureCategoryId = state.captureCategoryId === id ? "" : id;
    if (!isWorkCategory(state.captureCategoryId)) state.captureTagIds = [];
    renderCapturePickers();
  });
  renderPicker($("#capture-tags"), state.tags.filter(item => item.is_active), state.captureTagIds, id => {
    state.captureTagIds = state.captureTagIds.includes(id) ? state.captureTagIds.filter(value => value !== id) : [...state.captureTagIds, id];
    renderCapturePickers();
  });
  $("#capture-work-options").hidden = !isWorkCategory(state.captureCategoryId);
  updateCaptureTitlePreview();
}

function isWorkCategory(categoryId) {
  const category = findCategory(categoryId);
  return category?.name === "工作" || category?.id === "category-1";
}

async function startRecording() {
  if (state.voiceStarting || state.voiceBusy || state.recording) return;
  if ((state.pendingAudioBlob || state.rawTranscript) && !confirm("重新录音会替换当前未保存的录音和转写，是否继续？")) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $("#transcript-wrap").hidden = false;
    $("#voice-status").innerHTML = `<strong>当前浏览器不支持独立录音</strong><br><span class="tiny">仍可使用上方的 iPhone 系统听写。</span>`;
    showToast("当前浏览器不支持录音");
    return;
  }
  const generation = ++state.voiceGeneration;
  state.voiceStarting = true;
  updateVoiceButton(); updateSaveState();
  try {
    state.discardRecording = false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== state.voiceGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    state.mediaStream = stream;
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    state.recorder = recorder;
    state.pendingAudioBlob = null; state.rawTranscript = null; state.voiceMessage = "";
    $("#voice-transcript").value = "";
    recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener("stop", async () => {
      stream.getTracks().forEach(track => track.stop());
      if (generation !== state.voiceGeneration) return;
      clearInterval(state.recordingTimer);
      state.pendingAudioBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      state.recording = false;
      $("#transcript-wrap").hidden = false;
      updateVoiceButton();
      updateSaveState();
      await retryCaptureTranscription();
    });
    recorder.start(1000);
    state.voiceStarting = false;
    state.recording = true;
    state.recordingStartedAt = Date.now();
    state.recordingTimer = setInterval(() => {
      if (Date.now() - state.recordingStartedAt >= 120000) stopRecording();
      updateVoiceButton();
    }, 1000);
    updateVoiceButton();
    updateSaveState();
  } catch (error) {
    if (generation !== state.voiceGeneration) return;
    state.mediaStream?.getTracks().forEach(track => track.stop());
    state.voiceStarting = false;
    state.recording = false;
    $("#transcript-wrap").hidden = false;
    $("#voice-status").innerHTML = `<strong>没有取得独立录音权限</strong><br><span class="tiny">仍可使用上方的 iPhone 系统听写。</span>`;
    showToast("未能开始录音");
    updateSaveState();
    $("#voice-record").disabled = false;
  }
}

function stopRecording() {
  if (state.recorder?.state === "recording") state.recorder.stop();
}

function persistVoiceEntry(entry, audio) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(["entries", "audio"], "readwrite");
    tx.objectStore("entries").put(entry);
    if (audio) tx.objectStore("audio").put({ entry_id: entry.id, blob: audio, created_at: entry.created_at });
    else tx.objectStore("audio").delete(entry.id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("保存失败"));
  });
}

async function retryCaptureTranscription() {
  if (!state.pendingAudioBlob?.size || state.voiceBusy || state.rawTranscript) return;
  const generation = state.voiceGeneration;
  const before = $("#voice-transcript").value;
  state.voiceBusy = true;
  const controller = new AbortController(); state.voiceAbort = controller;
  const timeout = setTimeout(() => controller.abort(), 55000);
  updateVoiceButton(); updateSaveState();
  try {
    const transcript = await transcribeAudio(state.pendingAudioBlob, controller.signal);
    if (generation !== state.voiceGeneration) return;
    state.rawTranscript = transcript;
    // Never overwrite edits typed while a request was in flight.
    if ($("#voice-transcript").value === before && !before) $("#voice-transcript").value = transcript;
    state.voiceMessage = "转写完成，原始转写将单独保留";
  } catch (error) {
    if (generation === state.voiceGeneration) state.voiceMessage = error.name === "AbortError" ? "转写已停止，录音可保存后重试" : error.message;
  } finally {
    clearTimeout(timeout);
    if (generation === state.voiceGeneration) { state.voiceBusy = false; updateVoiceButton(); updateSaveState(); }
  }
}

async function retrySavedTranscription(event) {
  const entry = detailEntry();
  if (!entry || entry.raw_transcript || state.voiceBusy) return;
  const button = event.currentTarget; button.disabled = true;
  state.voiceBusy = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const audio = await dbRequest("audio", "readonly", store => store.get(entry.id));
    if (!audio?.blob) throw new Error("本机没有这条记录的录音，无法重试");
    const transcript = await transcribeAudio(audio.blob, controller.signal);
    const latest = await dbRequest("entries", "readonly", store => store.get(entry.id));
    if (!latest || latest.deleted_at || latest.raw_transcript) return;
    const updated = { ...latest, raw_transcript: transcript, transcription_status: "completed", temporary_audio_key: null, updated_at: nowIso(), sync_status: "pending" };
    await persistVoiceEntry(updated, null);
    await loadState();
    // Update only raw display, preserving unsaved detail edits.
    if (state.currentEntryId === entry.id) $("#detail-raw").textContent = transcript;
    showToast("转写成功，原始文本已保存");
  } catch (error) { showToast(error.name === "AbortError" ? "转写超时，录音仍保留" : error.message); }
  finally { clearTimeout(timeout); button.disabled = false; state.voiceBusy = false; updateVoiceButton(); updateSaveState(); }
}

function cancelCapture() {
  state.voiceGeneration++;
  state.voiceAbort?.abort();
  clearInterval(state.recordingTimer);
  state.voiceStarting = false; state.voiceBusy = false; state.recording = false;
  state.capturePrepared = false;
  state.discardRecording = true;
  if (state.recorder?.state === "recording") state.recorder.stop();
  state.mediaStream?.getTracks().forEach(track => track.stop());
  state.pendingAudioBlob = null;
  go("home");
}

function updateVoiceButton() {
  const button = $("#voice-record");
  button.disabled = state.voiceBusy || state.voiceStarting;
  $("#voice-retry").hidden = !state.pendingAudioBlob || !!state.rawTranscript;
  $("#voice-retry").disabled = state.voiceBusy || state.recording;
  button.classList.toggle("recording", state.recording);
  button.setAttribute("aria-pressed", String(state.recording));
  button.textContent = state.recording ? "停止并转写" : state.pendingAudioBlob ? "重新录音" : "开始录音";
  if (state.voiceStarting || state.voiceBusy) {
    $("#voice-status").textContent = state.voiceStarting ? "等待麦克风权限…" : "正在转写，请稍候…";
  } else if (state.recording) {
    $("#voice-status").textContent = `正在录音 ${Math.floor((Date.now() - state.recordingStartedAt) / 1000)} 秒 · 最长两分钟`;
  } else if (state.voiceMessage || state.rawTranscript) {
    $("#voice-status").textContent = state.voiceMessage || "转写完成，可编辑后保存";
  } else if (state.pendingAudioBlob) {
    $("#voice-status").textContent = "录音已就绪，可转写或保存为待转写";
  } else {
    $("#voice-status").textContent = voiceConfig.endpoint ? "点击开始录音，停止后确认上传转写" : "自动转写尚未配置；可录音并保存为待转写";
  }
}

function updateSaveState() {
  const hasText = $("#raw-text").value.trim().length > 0;
  const hasTranscript = $("#voice-transcript").value.trim().length > 0;
  $("#save-entry").disabled = state.recording || state.voiceBusy || state.voiceStarting || (state.captureMode === "text" ? !hasText : !hasTranscript && !state.pendingAudioBlob);
  $("#save-entry").textContent = state.captureMode === "voice" && state.pendingAudioBlob && !hasTranscript ? "保存为待转写" : "保存记录";
  $("#char-count").textContent = $("#raw-text").value.length;
}

async function saveNewEntry() {
  if ($("#save-entry").disabled) return;
  $("#save-entry").disabled = true;
  const createdAt = nowIso();
  const manualOnly = state.captureMode === "voice" && !state.rawTranscript && !state.pendingAudioBlob;
  const rawText = state.captureMode === "text" ? $("#raw-text").value.trim() : manualOnly ? $("#voice-transcript").value.trim() : null;
  const rawTranscript = state.captureMode === "voice" ? state.rawTranscript : null;
  const id = newId();
  const entry = {
    id,
    created_at: createdAt,
    updated_at: createdAt,
    occurred_at: inputToUtc($("#capture-time").value),
    timezone: timezone(),
    timezone_offset_minutes: -new Date().getTimezoneOffset(),
    category_id: state.captureCategoryId || null,
    project_id: null,
    tag_ids: [...state.captureTagIds],
    title: generatedCaptureTitle(),
    source_type: manualOnly ? "text" : state.captureMode,
    raw_text: rawText,
    raw_transcript: rawTranscript,
    edited_text: state.captureMode === "voice" ? $("#voice-transcript").value : "",
    transcription_status: state.captureMode === "text" || manualOnly ? "not_applicable" : rawTranscript ? "completed" : "pending",
    temporary_audio_key: state.captureMode === "voice" && !rawTranscript && state.pendingAudioBlob ? id : null,
    planned_end_at: null,
    actual_end_at: null,
    calculated_overtime_minutes: null,
    overtime_minutes: null,
    overtime_is_manual: false,
    overtime_reason: "",
    had_rework: null,
    had_requirement_change: null,
    had_decision_delay: null,
    controllable_factors: "",
    uncontrollable_factors: "",
    next_adjustment: "",
    deleted_at: null,
    purge_after: null,
    sync_status: "pending",
    server_version: null,
    conflict_group_id: null
  };
  try {
    await persistVoiceEntry(entry, entry.temporary_audio_key ? state.pendingAudioBlob : null);
  } catch { showToast("保存失败，录音仍保留，请重试或检查存储空间"); updateSaveState(); return; }
  state.pendingAudioBlob = null;
  await loadState();
  state.currentEntryId = id;
  state.capturePrepared = false;
  setStatus();
  $("#saved-dialog").showModal();
}

function detailEntry() {
  return state.entries.find(entry => entry.id === state.currentEntryId) || activeEntries()[0];
}

function renderDetail(openStructure = false) {
  const entry = detailEntry();
  if (!entry) { go("home"); return; }
  state.currentEntryId = entry.id;
  $("#detail-time").textContent = `${formatDateTime(entryDate(entry))} · ${entry.source_type === "voice" ? "语音记录" : "文字记录"}`;
  const raw = rawContent(entry);
  if (raw) $("#detail-raw").textContent = raw;
  else $("#detail-raw").innerHTML = `<strong>待转写</strong><br><span class="tiny">临时音频保存在本机。云端转写服务配置后可重试。</span><br><button class="chip" type="button" id="retry-transcription" style="margin-top:10px">重新尝试转写</button>`;
  $("#retry-transcription")?.addEventListener("click", retrySavedTranscription);
  $("#detail-edited").value = entry.edited_text || "";
  $("#detail-title-input").value = entry.title || "";
  $("#detail-category").innerHTML = optionMarkup(state.categories, "未分类", entry.category_id);
  $("#detail-category").value = entry.category_id || "";
  $("#detail-project").innerHTML = optionMarkup(state.projects, "无项目 / 主题", entry.project_id);
  $("#detail-project").value = entry.project_id || "";
  $("#detail-occurred").value = isoLocal(entry.occurred_at);
  const availableTags = state.tags.filter(tag => tag.is_active || (entry.tag_ids || []).includes(tag.id));
  const renderDetailTags = () => renderPicker($("#detail-tags"), availableTags, entry.tag_ids || [], id => {
    entry.tag_ids = entry.tag_ids.includes(id) ? entry.tag_ids.filter(value => value !== id) : [...entry.tag_ids, id];
    renderDetailTags();
  });
  renderDetailTags();
  $("#planned-end").value = isoLocal(entry.planned_end_at);
  $("#actual-end").value = isoLocal(entry.actual_end_at);
  $("#overtime-minutes").value = entry.overtime_minutes ?? "";
  $("#overtime-minutes").dataset.manual = String(entry.overtime_is_manual);
  $("#overtime-reason").value = entry.overtime_reason || "";
  $("#had-rework").value = nullableBooleanToSelect(entry.had_rework);
  $("#had-change").value = nullableBooleanToSelect(entry.had_requirement_change);
  $("#had-delay").value = nullableBooleanToSelect(entry.had_decision_delay);
  $("#controllable").value = entry.controllable_factors || "";
  $("#uncontrollable").value = entry.uncontrollable_factors || "";
  $("#next-adjustment").value = entry.next_adjustment || "";
  $("#structure-options").open = openStructure;
  updateOvertimeCalculation(false);
}

const nullableBooleanToSelect = value => value === true ? "yes" : value === false ? "no" : "";
const selectToNullableBoolean = value => value === "yes" ? true : value === "no" ? false : null;

function updateOvertimeCalculation(overwrite = false) {
  const calculated = calculateOvertimeMinutes($("#planned-end").value, $("#actual-end").value);
  $("#overtime-calculated").textContent = calculated === null ? "填写计划与实际结束时间后自动计算，可手动覆盖。" : `自动计算：${calculated} 分钟（已处理日期和跨午夜）`;
  if (calculated !== null && (overwrite || $("#overtime-minutes").dataset.manual !== "true")) {
    $("#overtime-minutes").value = calculated;
    $("#overtime-minutes").dataset.manual = "false";
  }
  return calculated;
}

async function saveDetail() {
  const entry = detailEntry();
  if (!entry) return;
  const calculated = updateOvertimeCalculation(false);
  entry.edited_text = $("#detail-edited").value.trim();
  entry.title = $("#detail-title-input").value.trim();
  entry.category_id = $("#detail-category").value || null;
  entry.project_id = $("#detail-project").value || null;
  entry.occurred_at = inputToUtc($("#detail-occurred").value);
  entry.planned_end_at = inputToUtc($("#planned-end").value);
  entry.actual_end_at = inputToUtc($("#actual-end").value);
  entry.calculated_overtime_minutes = calculated;
  entry.overtime_minutes = $("#overtime-minutes").value === "" ? null : Number($("#overtime-minutes").value);
  entry.overtime_is_manual = $("#overtime-minutes").dataset.manual === "true";
  entry.overtime_reason = $("#overtime-reason").value.trim();
  entry.had_rework = selectToNullableBoolean($("#had-rework").value);
  entry.had_requirement_change = selectToNullableBoolean($("#had-change").value);
  entry.had_decision_delay = selectToNullableBoolean($("#had-delay").value);
  entry.controllable_factors = $("#controllable").value.trim();
  entry.uncontrollable_factors = $("#uncontrollable").value.trim();
  entry.next_adjustment = $("#next-adjustment").value.trim();
  entry.updated_at = nowIso();
  entry.sync_status = "pending";
  await dbPut("entries", entry);
  await loadState();
  setStatus();
  showToast("修改已保存，原始记录未改变");
}

async function moveCurrentToTrash() {
  const entry = detailEntry();
  if (!entry || !window.confirm("将这条记录移到回收站？30 天内可以恢复。")) return;
  const deleted = markDeleted(entry, nowIso(), 30);
  await dbPut("entries", deleted);
  await loadState();
  showToast("已移到回收站");
  go("timeline");
}

function renderTimeline() {
  runSearch();
  setStatus();
}

function searchableText(entry) {
  return [entry.title, entry.raw_text, entry.raw_transcript, entry.edited_text, entry.overtime_reason, entry.controllable_factors, entry.uncontrollable_factors, entry.next_adjustment, findCategory(entry.category_id)?.name, findProject(entry.project_id)?.name, ...entryTags(entry).map(tag => tag.name)].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
}

function runSearch() {
  const tokens = $("#search-query").value.trim().toLocaleLowerCase("zh-CN").split(/\s+/).filter(Boolean);
  const categoryId = $("#search-category").value;
  const projectId = $("#search-project").value;
  const from = $("#search-from").value ? new Date(`${$("#search-from").value}T00:00:00`) : null;
  const to = $("#search-to").value ? new Date(`${$("#search-to").value}T23:59:59`) : null;
  const hasCondition = tokens.length || categoryId || projectId || state.searchTagIds.length || from || to;
  const filtered = activeEntries().filter(entry => {
    const haystack = searchableText(entry);
    const date = new Date(entryDate(entry));
    return tokens.every(token => haystack.includes(token))
      && (!categoryId || entry.category_id === categoryId)
      && (!projectId || entry.project_id === projectId)
      && state.searchTagIds.every(tagId => entry.tag_ids.includes(tagId))
      && (!from || date >= from)
      && (!to || date <= to);
  }).sort((a, b) => new Date(entryDate(b)) - new Date(entryDate(a)));
  state.currentFilteredEntryIds = filtered.map(entry => entry.id);
  $("#result-count").textContent = hasCondition ? `找到 ${filtered.length} 条记录` : `共 ${filtered.length} 条记录`;
  const grouped = filtered.reduce((map, entry) => {
    const day = isoLocal(entryDate(entry)).slice(0, 10);
    (map[day] ||= []).push(entry);
    return map;
  }, {});
  $("#search-results").innerHTML = filtered.length ? Object.entries(grouped).map(([day, entries]) => `<h2 class="date-heading">${day}</h2>${entries.map(recordCard).join("")}`).join("") : `<div class="empty">${hasCondition ? "没有找到，可以减少关键词或清除筛选。" : "还没有记录，点下方语音输入开始。"}</div>`;
  bindRecordCards($("#search-results"));
}

function renderSearchTags() {
  renderPicker($("#search-tags"), state.tags, state.searchTagIds, id => {
    state.searchTagIds = state.searchTagIds.includes(id) ? state.searchTagIds.filter(value => value !== id) : [...state.searchTagIds, id];
    renderSearchTags();
    runSearch();
  });
}

async function createTagFromInput() {
  const name = $("#new-tag-name").value.trim();
  if (!name) return;
  const normalized = normalizeName(name);
  if (state.tags.some(tag => tag.normalized_name === normalized)) { showToast("标签名称已存在"); return; }
  const tag = makeTag(name);
  await dbPut("tags", tag);
  await loadState();
  state.captureTagIds.push(tag.id);
  $("#new-tag-name").value = "";
  initializeSelects();
  renderCapturePickers();
  renderSearchTags();
  showToast("标签已创建并选中");
}

async function createProjectFromInput() {
  const name = $("#new-project-name").value.trim();
  if (!name) return;
  const existing = state.projects.find(project => normalizeName(project.name) === normalizeName(name));
  if (existing) { showToast("项目 / 主题名称已存在"); return; }
  const project = makeProject(name);
  await dbPut("projects", project);
  await loadState();
  initializeSelects();
  $("#detail-project").value = project.id;
  $("#new-project-name").value = "";
  showToast("项目 / 主题已创建");
}

function renderTagManager() {
  $("#tag-list").innerHTML = state.tags.length ? state.tags.map(tag => `<div class="dialog-row"><div><strong>${escapeHtml(tag.name)}</strong><br><span class="tiny">${tag.is_active ? "使用中" : "已停用"}</span></div><div class="button-row"><button class="chip" data-rename-tag="${tag.id}" type="button">改名</button><button class="chip ${tag.is_active ? "danger" : ""}" data-toggle-tag="${tag.id}" type="button">${tag.is_active ? "停用" : "恢复"}</button></div></div>`).join("") : `<div class="empty">暂无标签</div>`;
  $("#tag-list").querySelectorAll("[data-toggle-tag]").forEach(button => button.addEventListener("click", async () => {
    const tag = findTag(button.dataset.toggleTag);
    tag.is_active = !tag.is_active;
    tag.updated_at = nowIso();
    await dbPut("tags", tag);
    await loadState();
    initializeSelects(); renderCapturePickers(); renderSearchTags(); renderTagManager();
  }));
  $("#tag-list").querySelectorAll("[data-rename-tag]").forEach(button => button.addEventListener("click", async () => {
    const tag = findTag(button.dataset.renameTag);
    const name = window.prompt("新的标签名称", tag.name)?.trim();
    if (!name || name === tag.name) return;
    const normalized = normalizeName(name);
    if (state.tags.some(item => item.id !== tag.id && item.normalized_name === normalized)) { showToast("标签名称已存在"); return; }
    tag.name = name; tag.normalized_name = normalized; tag.updated_at = nowIso();
    await dbPut("tags", tag);
    await loadState();
    initializeSelects(); renderCapturePickers(); renderSearchTags(); renderTagManager();
  }));
}

function renderTrash() {
  const entries = trashedEntries().sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));
  $("#trash-list").innerHTML = entries.length ? entries.map(entry => {
    const days = Math.max(0, Math.ceil((new Date(entry.purge_after).getTime() - Date.now()) / DAY_MS));
    return `<div class="dialog-row"><div><strong>${escapeHtml(summary(entry))}</strong><br><span class="tiny">${days} 天后可永久清理</span></div><button class="chip" data-restore="${entry.id}" type="button">恢复</button></div>`;
  }).join("") : `<div class="empty">回收站为空</div>`;
  $("#trash-list").querySelectorAll("[data-restore]").forEach(button => button.addEventListener("click", async () => {
    const entry = state.entries.find(item => item.id === button.dataset.restore);
    await dbPut("entries", restoreDeleted(entry, nowIso()));
    await loadState();
    renderTrash(); renderTimeline(); showToast("记录已恢复");
  }));
}

function exportPayload() {
  return buildExportEnvelope({
    entries: state.entries,
    categories: state.categories,
    tags: state.tags,
    projects: state.projects,
    entry_tags: state.entries.flatMap(entry => (entry.tag_ids || []).map(tagId => ({ entry_id: entry.id, tag_id: tagId })))
  }, nowIso(), SCHEMA_VERSION);
}

function downloadBlob(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename, bytes: new Blob([content], { type }).size };
}

function downloadWithNotice(filename, content, type) {
  const result = downloadBlob(filename, content, type);
  showToast(`已生成 ${result.filename}`);
  return result;
}

function entriesToCsv(entries) {
  const headers = ["id", "created_at", "updated_at", "occurred_at", "timezone", "title", "source_type", "raw_text", "raw_transcript", "edited_text", "category_id", "category", "project_id", "project", "tags", "transcription_status", "overtime_minutes", "deleted_at", "sync_status"];
  const rows = entries.map(entry => {
    const category = findCategory(entry.category_id);
    const project = findProject(entry.project_id);
    return [entry.id, entry.created_at, entry.updated_at, entry.occurred_at, entry.timezone, entry.title, entry.source_type, entry.raw_text, entry.raw_transcript, entry.edited_text, entry.category_id, category?.name, entry.project_id, project?.name, entryTags(entry).map(tag => tag.name).join("|"), entry.transcription_status, entry.overtime_minutes, entry.deleted_at, entry.sync_status];
  });
  return buildCsv(headers, rows);
}

function entryToMarkdown(entry) {
  const category = findCategory(entry.category_id)?.name || "未分类";
  const project = findProject(entry.project_id)?.name || "";
  const tags = entryTags(entry).map(tag => tag.name).join("、");
  const rawLabel = entry.source_type === "voice" ? "原始转写" : "原始文字";
  return [`## ${entry.title || formatDateTime(entryDate(entry))}`, "", `- 时间：${formatDateTime(entryDate(entry))}`, `- 分类：${category}`, tags ? `- 标签：${tags}` : "", project ? `- 项目 / 主题：${project}` : "", "", `### ${rawLabel}`, "", rawContent(entry) || "（待转写）", entry.edited_text ? "\n### 整理后的内容\n\n" + entry.edited_text : "", entry.overtime_reason ? "\n### 加班原因\n\n" + entry.overtime_reason : ""].filter(Boolean).join("\n");
}

function exportMarkdown() {
  const groups = activeEntries().sort((a, b) => new Date(entryDate(a)) - new Date(entryDate(b))).reduce((map, entry) => {
    const key = monthKey(entryDate(entry));
    (map[key] ||= []).push(entry);
    return map;
  }, {});
  const months = Object.entries(groups);
  if (!months.length) { showToast("没有可导出的记录"); return; }
  months.forEach(([month, entries], index) => setTimeout(() => downloadBlob(`${month}.md`, `# ${month}\n\n${entries.map(entryToMarkdown).join("\n\n---\n\n")}\n`, "text/markdown;charset=utf-8"), index * 150));
  showToast(`已生成 ${months.length} 个月份文件`);
}

function initializeSelects() {
  $("#search-category").innerHTML = optionMarkup(state.categories, "全部分类");
  $("#search-project").innerHTML = `<option value="">全部项目 / 主题</option>${state.projects.map(project => `<option value="${project.id}">${escapeHtml(project.name)}${project.is_archived ? "（归档）" : ""}</option>`).join("")}`;
  renderSearchTags();
}

function bindEvents() {
  $$('[data-go]').forEach(button => button.addEventListener("click", () => go(button.dataset.go)));
  $("#nav-voice").addEventListener("click", () => go("capture", { mode: "voice" }));
  $("#cancel-capture").addEventListener("click", cancelCapture);
  $("#text-mode").addEventListener("click", () => setCaptureMode("text"));
  $("#voice-mode").addEventListener("click", () => setCaptureMode("voice"));
  $("#voice-record").addEventListener("click", () => state.recording ? stopRecording() : startRecording());
  $("#voice-retry").addEventListener("click", retryCaptureTranscription);
  $("#raw-text").addEventListener("input", updateSaveState);
  $("#voice-transcript").addEventListener("input", updateSaveState);
  $("#voice-transcript").addEventListener("focus", () => { if (state.recording) stopRecording(); });
  $("#capture-entry-title").addEventListener("input", updateCaptureTitlePreview);
  $("#capture-time").addEventListener("change", updateCaptureTitlePreview);
  $("#save-entry").addEventListener("click", saveNewEntry);
  $("#finish-save").addEventListener("click", () => { $("#saved-dialog").close(); go("detail"); });
  $("#continue-structure").addEventListener("click", () => { $("#saved-dialog").close(); go("detail", { openStructure: true }); });
  $("#detail-save").addEventListener("click", saveDetail);
  $("#detail-delete").addEventListener("click", moveCurrentToTrash);
  $("#create-tag").addEventListener("click", createTagFromInput);
  $("#new-tag-name").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); createTagFromInput(); } });
  $("#create-project").addEventListener("click", createProjectFromInput);
  $("#manage-tags").addEventListener("click", () => { renderTagManager(); $("#tag-dialog").showModal(); });
  $("#planned-end").addEventListener("change", () => updateOvertimeCalculation(false));
  $("#actual-end").addEventListener("change", () => updateOvertimeCalculation(false));
  $("#overtime-minutes").addEventListener("input", () => { $("#overtime-minutes").dataset.manual = "true"; });
  $("#search-submit").addEventListener("click", runSearch);
  $("#search-query").addEventListener("input", runSearch);
  ["#search-category", "#search-project", "#search-from", "#search-to"].forEach(id => $(id).addEventListener("change", runSearch));
  $("#search-reset").addEventListener("click", () => { ["#search-query", "#search-category", "#search-project", "#search-from", "#search-to"].forEach(id => $(id).value = ""); state.searchTagIds = []; renderSearchTags(); runSearch(); });
  $("#open-trash").addEventListener("click", () => { renderTrash(); $("#trash-dialog").showModal(); });
  $("#open-export").addEventListener("click", () => $("#export-dialog").showModal());
  $("#sync-status").addEventListener("click", () => $("#sync-dialog").showModal());
  $("#sync-export-shortcut").addEventListener("click", () => { $("#sync-dialog").close(); downloadWithNotice(`shiji-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exportPayload(), null, 2), "application/json;charset=utf-8"); });
  $("#export-json").addEventListener("click", () => downloadWithNotice(`shiji-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exportPayload(), null, 2), "application/json;charset=utf-8"));
  $("#export-csv-all").addEventListener("click", () => downloadWithNotice(`shiji-all-${new Date().toISOString().slice(0, 10)}.csv`, entriesToCsv(activeEntries()), "text/csv;charset=utf-8"));
  $("#export-csv-filtered").addEventListener("click", () => {
    const entries = state.currentFilteredEntryIds.map(id => state.entries.find(entry => entry.id === id)).filter(Boolean);
    downloadWithNotice(`shiji-filtered-${new Date().toISOString().slice(0, 10)}.csv`, entriesToCsv(entries), "text/csv;charset=utf-8");
  });
  $("#export-markdown").addEventListener("click", exportMarkdown);
  $$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
  window.addEventListener("online", setStatus);
  window.addEventListener("offline", setStatus);
}

async function initialize() {
  try {
    state.db = await openDatabase();
    await seedMetadata();
    await loadState();
    await purgeExpiredTrash();
    initializeSelects();
    bindEvents();
    renderCapturePickers();
    renderHome();
    go("capture", { mode: "voice" });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => showToast("离线应用外壳注册失败"));
  } catch (error) {
    console.error(error);
    $("#app-status").textContent = "本地数据初始化失败，请先不要记录并查看已知问题。";
    showToast("本地数据初始化失败");
  }
}

initialize();

export { entriesToCsv, exportPayload };
