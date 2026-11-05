'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanna', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  listModels: (provider) => ipcRenderer.invoke('models:list', provider),
  getMemory: () => ipcRenderer.invoke('memory:get'),
  removeMemory: (key) => ipcRenderer.invoke('memory:remove', key),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  sendChat: (messages) => ipcRenderer.invoke('chat:send', messages),
  stopChat: () => ipcRenderer.send('chat:stop'),

  // Shake flow: renderer asks for the model's shake reaction, and tells
  // main when the voice finished so the window position unfreezes. Main
  // also pushes the freeze/unfreeze notifications for the toasts.
  shakeAsk: (shakes) => ipcRenderer.invoke('kanna:shakeAsk', shakes),
  unfreeze: () => ipcRenderer.send('kanna:unfreeze'),
  onShakeLock: (listener) => {
    ipcRenderer.on('kanna:shakeLock', (_e, info) => listener(info));
  },
  onFreezeOff: (listener) => {
    ipcRenderer.on('kanna:freezeOff', (_e, info) => listener(info));
  },

  // Welcome-back greeting when the user returns after a while (main picks
  // line + mood by absence length; no model involved).
  back: (awayMs) => ipcRenderer.invoke('kanna:back', awayMs),
  onChunk: (listener) => {
    ipcRenderer.on('chat:chunk', (_e, text) => listener(text));
  },
  onMeta: (listener) => {
    ipcRenderer.on('chat:meta', (_e, meta) => listener(meta));
  },
  // Main-pushed canned reactions (shake dizzy/angry lines).
  onShake: (listener) => {
    ipcRenderer.on('kanna:shake', (_e, g) => listener(g));
  },
  minimize: () => ipcRenderer.send('win:min'),
  close: () => ipcRenderer.send('win:close'),

  // TTS: ask the main process to synthesize audio (keys stay in main process).
  ttsSpeak: (payload) => ipcRenderer.invoke('tts:speak', payload),
  ttsCancel: () => ipcRenderer.send('tts:cancel'),

  // STT: microphone transcription through the local Vosk server.
  sttStart: () => ipcRenderer.invoke('stt:start'),
  sttAudio: (pcmBuffer) => ipcRenderer.invoke('stt:audio', pcmBuffer),
  sttFinish: () => ipcRenderer.invoke('stt:finish'),
  sttCancel: () => ipcRenderer.send('stt:cancel'),
});
