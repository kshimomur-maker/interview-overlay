"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("interviewOverlay", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  saveCheatSheet: (value) => ipcRenderer.invoke("settings:save-cheat-sheet", value),
  testApiKey: (apiKey) => ipcRenderer.invoke("settings:test-key", apiKey),
  getUsage: () => ipcRenderer.invoke("usage:get"),
  openUsageDashboard: () => ipcRenderer.invoke("usage:open-dashboard"),
  transcribeAudioChunk: (payload) =>
    ipcRenderer.invoke("interview:transcribe-chunk", payload),
  streamAnswer: (payload) => ipcRenderer.invoke("interview:stream-answer", payload),
  analyzeTranscript: (payload) =>
    ipcRenderer.invoke("interview:analyze-transcript", payload),
  generateMinutes: (entries) => ipcRenderer.invoke("interview:minutes", entries),
  exportMinutes: (content) => ipcRenderer.invoke("interview:export", content),
  exportPhraseMemory: (entries) =>
    ipcRenderer.invoke("interview:phrase-memory-export", entries),
  setOpacity: (value) => ipcRenderer.invoke("window:opacity", value),
  setClickThrough: (enabled) => ipcRenderer.invoke("window:click-through", enabled),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  toggleVisibility: () => ipcRenderer.invoke("window:toggle-visibility"),
  onClickThroughChanged: (callback) => {
    const handler = (_event, enabled) => callback(enabled);
    ipcRenderer.on("window:click-through-changed", handler);
    return () => ipcRenderer.removeListener("window:click-through-changed", handler);
  },
  onAnswerDelta: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("interview:answer-delta", handler);
    return () => ipcRenderer.removeListener("interview:answer-delta", handler);
  },
  onUsageUpdated: (callback) => {
    const handler = (_event, usage) => callback(usage);
    ipcRenderer.on("usage:updated", handler);
    return () => ipcRenderer.removeListener("usage:updated", handler);
  }
});
