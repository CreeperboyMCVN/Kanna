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
  onChunk: (listener) => {
    ipcRenderer.on('chat:chunk', (_e, text) => listener(text));
  },
  onMeta: (listener) => {
    ipcRenderer.on('chat:meta', (_e, meta) => listener(meta));
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
