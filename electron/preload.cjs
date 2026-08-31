const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexBridge', {
  getStatus: () => ipcRenderer.invoke('codex:get-status'),
  login: () => ipcRenderer.invoke('codex:login'),
  logout: () => ipcRenderer.invoke('codex:logout'),
  listModels: () => ipcRenderer.invoke('codex:list-models'),
  generateMotion: (request) => ipcRenderer.invoke('codex:generate-motion', request),
  onAccountChanged: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on('codex:account-changed', handler);
    return () => ipcRenderer.removeListener('codex:account-changed', handler);
  },
});

contextBridge.exposeInMainWorld('ardyBridge', {
  getStatus: () => ipcRenderer.invoke('ardy:get-status'),
  start: () => ipcRenderer.invoke('ardy:start'),
  stop: () => ipcRenderer.invoke('ardy:stop'),
  setup: () => ipcRenderer.invoke('ardy:setup'),
});

contextBridge.exposeInMainWorld('localApiBridge', {
  getStatus: () => ipcRenderer.invoke('local-api:get-status'),
  start: (config) => ipcRenderer.invoke('local-api:start', config),
  stop: () => ipcRenderer.invoke('local-api:stop'),
  regenerateToken: () => ipcRenderer.invoke('local-api:regenerate-token'),
});
