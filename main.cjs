"use strict";

const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session,
  shell
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  analyzeInterview,
  generateMinutes,
  streamInterviewAnswer,
  testApiKey,
  transcribeAudio
} = require("./lib/openai-client.cjs");
const { createPhraseMemoryImport } = require("./lib/phrase-memory-bridge.cjs");
const { autoUpdater } = require("electron-updater");

let mainWindow;
let clickThrough = false;
let usageWrite = Promise.resolve();
let updateDialogOpen = false;

function configureAutoUpdates() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => {
    console.error("Automatic update failed:", error?.message || error);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    if (updateDialogOpen || !mainWindow || mainWindow.isDestroyed()) return;
    updateDialogOpen = true;
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Interview Overlay update ready",
        message: `Version ${info.version} is ready to install.`,
        detail: "Restart now to use the latest version. You can also update automatically when you close the app.",
        buttons: ["Restart and update", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (result.response === 0) autoUpdater.quitAndInstall(false, true);
    } finally {
      updateDialogOpen = false;
    }
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error) => {
      console.error("Update check failed:", error?.message || error);
    });
  }, 5000);
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function usagePath() {
  return path.join(app.getPath("userData"), "usage.json");
}

function emptyUsage() {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    updatedAt: null,
    requests: 0,
    responseRequests: 0,
    transcriptionRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    tokenResponses: 0,
    transcriptionRequestsWithoutTokenUsage: 0
  };
}

async function readUsageRaw() {
  try {
    return { ...emptyUsage(), ...JSON.parse(await fs.readFile(usagePath(), "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return emptyUsage();
    throw error;
  }
}

function usageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function recordApiUsage(kind, usage = null) {
  usageWrite = usageWrite.catch(() => {}).then(async () => {
    const current = await readUsageRaw();
    current.updatedAt = new Date().toISOString();
    current.requests += 1;
    if (kind === "transcription") {
      current.transcriptionRequests += 1;
      current.transcriptionRequestsWithoutTokenUsage += 1;
    } else {
      current.responseRequests += 1;
    }

    if (usage && typeof usage === "object") {
      current.tokenResponses += 1;
      current.inputTokens += usageNumber(usage.input_tokens);
      current.outputTokens += usageNumber(usage.output_tokens);
      current.reasoningTokens += usageNumber(usage.output_tokens_details?.reasoning_tokens);
      current.cachedInputTokens += usageNumber(usage.input_tokens_details?.cached_tokens);
    }

    await fs.mkdir(path.dirname(usagePath()), { recursive: true });
    await fs.writeFile(usagePath(), JSON.stringify(current, null, 2), "utf8");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("usage:updated", current);
    }
  });
  return usageWrite;
}

async function publicUsage() {
  await usageWrite;
  const usage = await readUsageRaw();
  return {
    ...usage,
    totalTokens: usage.inputTokens + usage.outputTokens,
    note:
      "Response token usage is recorded from this app. Audio transcription is billed separately and is not included in token totals."
  };
}

async function encryptSecret(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows encryption is not available on this device.");
  }
  if (typeof safeStorage.encryptStringAsync === "function") {
    return (await safeStorage.encryptStringAsync(value)).toString("base64");
  }
  return safeStorage.encryptString(value).toString("base64");
}

async function decryptSecret(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return "";
  const buffer = Buffer.from(value, "base64");
  if (typeof safeStorage.decryptStringAsync === "function") {
    return safeStorage.decryptStringAsync(buffer);
  }
  return safeStorage.decryptString(buffer);
}

async function readSettingsRaw() {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function readRuntimeSettings() {
  const stored = await readSettingsRaw();
  return {
    apiKey: await decryptSecret(stored.apiKeyEncrypted),
    profile: String(stored.profile || ""),
    cheatSheet: String(stored.cheatSheet || ""),
    style: String(
      stored.style ||
        "Clear, concise, warm, and easy for a non-native English speaker to say."
    ),
    responseModel: String(stored.responseModel || "gpt-5.6-sol"),
    transcriptionModel: String(stored.transcriptionModel || "gpt-transcribe"),
    opacity: Number(stored.opacity || 0.92)
  };
}

async function publicSettings() {
  const settings = await readRuntimeSettings();
  return {
    hasApiKey: Boolean(settings.apiKey),
    profile: settings.profile,
    cheatSheet: settings.cheatSheet,
    style: settings.style,
    responseModel: settings.responseModel,
    transcriptionModel: settings.transcriptionModel,
    opacity: settings.opacity,
    contentProtected: Boolean(mainWindow?.isContentProtected())
  };
}

async function saveSettings(input) {
  const existing = await readSettingsRaw();
  const next = {
    ...existing,
    profile: String(input.profile || "").slice(0, 100000),
    cheatSheet: String(input.cheatSheet || "").slice(0, 30000),
    style: String(input.style || "").slice(0, 1000),
    responseModel: String(input.responseModel || "gpt-5.6-sol"),
    transcriptionModel: String(input.transcriptionModel || "gpt-transcribe"),
    opacity: Math.min(1, Math.max(0.55, Number(input.opacity || 0.92)))
  };
  if (String(input.apiKey || "").trim()) {
    next.apiKeyEncrypted = await encryptSecret(String(input.apiKey).trim());
  }
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  mainWindow?.setOpacity(next.opacity);
  return publicSettings();
}

async function saveCheatSheet(value) {
  const existing = await readSettingsRaw();
  const next = {
    ...existing,
    cheatSheet: String(value || "").slice(0, 30000)
  };
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  return publicSettings();
}

function setClickThrough(enabled) {
  clickThrough = Boolean(enabled);
  mainWindow?.setIgnoreMouseEvents(clickThrough, { forward: true });
  if (!clickThrough) mainWindow?.focus();
  mainWindow?.webContents.send("window:click-through-changed", clickThrough);
  return clickThrough;
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(920, Math.max(620, workArea.width - 120));
  const height = Math.min(780, Math.max(620, workArea.height - 120));

  mainWindow = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 28,
    y: workArea.y + 28,
    minWidth: 520,
    minHeight: 560,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: "Interview Overlay",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setContentProtection(true);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", async () => {
    const settings = await readRuntimeSettings();
    mainWindow.setOpacity(settings.opacity);
    mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
}

function configureMediaCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 }
      });
      if (!sources[0]) return callback({});
      callback({ video: sources[0], audio: "loopback" });
    } catch {
      callback({});
    }
  });
}

function registerIpc() {
  ipcMain.handle("settings:get", () => publicSettings());
  ipcMain.handle("settings:save", (_event, settings) => saveSettings(settings));
  ipcMain.handle("settings:save-cheat-sheet", (_event, value) => saveCheatSheet(value));
  ipcMain.handle("settings:test-key", async (_event, suppliedKey) => {
    const runtime = await readRuntimeSettings();
    const key = String(suppliedKey || "").trim() || runtime.apiKey;
    if (!key) throw new Error("API key is not configured.");
    await testApiKey(key);
    return true;
  });
  ipcMain.handle("usage:get", () => publicUsage());
  ipcMain.handle("usage:open-dashboard", () =>
    shell.openExternal("https://platform.openai.com/usage")
  );

  ipcMain.handle("interview:transcribe-chunk", async (_event, payload) => {
    const settings = await readRuntimeSettings();
    if (!settings.apiKey) throw new Error("OpenAI API key is not configured.");
    const audioBuffer = Buffer.from(payload.arrayBuffer);
    const transcript = await transcribeAudio({
      apiKey: settings.apiKey,
      audioBuffer,
      mimeType: payload.mimeType,
      model: settings.transcriptionModel,
      context: settings.profile.slice(0, 1200)
    });
    void recordApiUsage("transcription");
    if (!transcript || transcript.replace(/[.\s]/g, "").length < 2) {
      return { transcript: "" };
    }
    return { transcript };
  });

  ipcMain.handle("interview:stream-answer", async (event, payload) => {
    const settings = await readRuntimeSettings();
    if (!settings.apiKey) throw new Error("OpenAI API key is not configured.");
    const requestId = String(payload.requestId || "");
    const answer = await streamInterviewAnswer({
      apiKey: settings.apiKey,
      transcript: String(payload.transcript || "").slice(0, 12000),
      recentHistory: String(payload.recentHistory || "").slice(-12000),
      profile: settings.profile,
      style: settings.style,
      forced: Boolean(payload.forced),
      model: settings.responseModel,
      onUsage: (usage) => void recordApiUsage("response", usage),
      onDelta: (delta) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("interview:answer-delta", { requestId, delta });
      }
    });
    return { requestId, answer };
  });

  ipcMain.handle("interview:analyze-transcript", async (_event, payload) => {
    const settings = await readRuntimeSettings();
    if (!settings.apiKey) throw new Error("OpenAI API key is not configured.");
    const analysis = await analyzeInterview({
      apiKey: settings.apiKey,
      transcript: String(payload.transcript || "").slice(0, 12000),
      recentHistory: String(payload.recentHistory || "").slice(-12000),
      answer: String(payload.answer || "").slice(0, 12000),
      model: settings.responseModel,
      onUsage: (usage) => void recordApiUsage("response", usage)
    });
    return { analysis };
  });

  ipcMain.handle("interview:minutes", async (_event, entries) => {
    const settings = await readRuntimeSettings();
    if (!settings.apiKey) throw new Error("OpenAI API key is not configured.");
    return generateMinutes({
      apiKey: settings.apiKey,
      entries: Array.isArray(entries) ? entries.slice(-300) : [],
      profile: settings.profile,
      model: settings.responseModel,
      onUsage: (usage) => void recordApiUsage("response", usage)
    });
  });

  ipcMain.handle("interview:export", async (_event, content) => {
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save interview notes",
      defaultPath: `Interview_Notes_${date}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, String(content || ""), "utf8");
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle("interview:phrase-memory-export", async (_event, entries) => {
    const payload = createPhraseMemoryImport(
      Array.isArray(entries) ? entries.slice(-300) : [],
      { version: "0.2.5" }
    );
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export phrases for Phrase Memory",
      defaultPath: `Phrase_Memory_Import_${date}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { canceled: false, filePath: result.filePath, count: payload.phrases.length };
  });

  ipcMain.handle("window:opacity", (_event, value) => {
    const opacity = Math.min(1, Math.max(0.55, Number(value)));
    mainWindow?.setOpacity(opacity);
    return opacity;
  });
  ipcMain.handle("window:click-through", (_event, enabled) =>
    setClickThrough(enabled)
  );
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:toggle-visibility", () => {
    if (!mainWindow) return false;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.showInactive();
    return mainWindow.isVisible();
  });
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+H", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.showInactive();
  });
  globalShortcut.register("CommandOrControl+Shift+T", () => {
    setClickThrough(!clickThrough);
  });
}

app.whenReady().then(() => {
  configureMediaCapture();
  registerIpc();
  createWindow();
  registerShortcuts();
  configureAutoUpdates();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
