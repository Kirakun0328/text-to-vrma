const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('appBridge', { restart: () => ipcRenderer.invoke('app:restart') });

contextBridge.exposeInMainWorld('jevBridge', {
  analyze: input => ipcRenderer.invoke('jev:analyze', input),
});

contextBridge.exposeInMainWorld('codexBridge', {
  getStatus: () => ipcRenderer.invoke('codex:get-status'),
  getUsage: () => ipcRenderer.invoke('codex:get-usage'),
  login: () => ipcRenderer.invoke('codex:login'),
  logout: () => ipcRenderer.invoke('codex:logout'),
  listModels: () => ipcRenderer.invoke('codex:list-models'),
  generateMotion: (request) => ipcRenderer.invoke('codex:generate-motion', request),
  generateJson: (request) => ipcRenderer.invoke('codex:generate-json', request),
  generateJsonStream: async (request, { requestId, onDelta } = {}) => {
    let rejectDelta;
    const failed = new Promise((_, reject) => { rejectDelta = reject; });
    const handler = (_event, event) => {
      if (event.requestId !== requestId) return;
      try { onDelta?.(event.delta); }
      catch (error) {
        ipcRenderer.send('codex:cancel-json-stream', requestId);
        rejectDelta(error);
      }
    };
    ipcRenderer.on('codex:json-delta', handler);
    try { return await Promise.race([ipcRenderer.invoke('codex:generate-json-stream', { requestId, request }), failed]); }
    finally { ipcRenderer.removeListener('codex:json-delta', handler); }
  },
  cancelJsonStream: requestId => ipcRenderer.send('codex:cancel-json-stream', requestId),
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
