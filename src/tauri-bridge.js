// Tauri bridge — wraps invoke() to match the window.codexBridge / window.ardyBridge API
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const codexBridge = {
  getStatus: () => invoke('codex_get_status'),
  login: () => invoke('codex_login'),
  logout: () => invoke('codex_logout'),
  listModels: () => invoke('codex_list_models'),
  generateMotion: (request) => invoke('codex_generate_motion', { request }),
  onAccountChanged: (listener) => {
    let unlisten;
    listen('codex:account-changed', (event) => listener(event.payload)).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  },
};

export const ardyBridge = {
  getStatus: () => invoke('ardy_get_status'),
  start: () => invoke('ardy_start'),
  stop: () => invoke('ardy_stop'),
  setup: () => invoke('ardy_setup'),
};
