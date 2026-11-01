'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanna', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  getMemory: () => ipcRenderer.invoke('memory:get'),
  removeMemory: (key) => ipcRenderer.invoke('memory:remove', key),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  sendChat: (messages) => ipcRenderer.invoke('chat:send', messages),
  stopChat: () => ipcRenderer.send('chat:stop'),
  onChunk: (listener) => {
    ipcRenderer.on('chat:chunk', (_e, text) => listener(text));
  },
  minimize: () => ipcRenderer.send('win:min'),
  close: () => ipcRenderer.send('win:close'),
});
