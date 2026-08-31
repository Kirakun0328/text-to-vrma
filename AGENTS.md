# AGENTS.md

## Quick commands

```sh
npm run dev          # Vite dev server → http://localhost:5173
npm run build        # Vite build → dist/
npm run app:dev      # Tauri dev (starts Vite + Rust app)
npm run app:build    # Tauri build → release/
npm test             # node --test test/*.test.cjs
```

## Project shape

Vanilla JS + Vite (no framework). ESM (`"type": "module"`). Tauri backend is Rust (`src-tauri/`).

| Area | Files | Notes |
|------|-------|-------|
| Frontend | `src/*.js`, `index.html` | three.js + @pixiv/three-vrm + @pixiv/three-vrm-animation |
| Desktop | `src-tauri/src/*.rs` | Tauri/Rust IPC, Codex client, ARDY client |
| ARDY engine | `tools/ardy-engine/` | Python server (server.py), installers for Win/Mac/Linux |
| Tests | `test/` | Node built-in test runner, CJS only |
| Public assets | `public/` | Bundled VRM models (AvatarSample) |

## Core data flow

1. `src/llm.js` — calls OpenAI/Claude/Codex API, returns motion spec JSON
2. `src/vrmaBuilder.js` — converts motion spec → GLB (.vrma) via VRMC_vrm_animation extension
3. `src/viewer.js` — three.js scene, VRM load, VRMA playback

Motion spec is the shared intermediate format between LLM mode and ARDY mode.

## Key conventions

- VRM coordinate system: +Z forward, +X left (VRM 1.0). Matches three-vrm convention.
- No lint, typecheck, or formatter configured. Follow existing code style.
- i18n via `data-i18n` attributes, translations in `src/i18n.js` (4 languages: ja/en/zh/ko).
- API keys stored in browser localStorage only — never sent to anything other than the selected provider.
- ARDY engine runs on `localhost:2337`.
- Frontend communicates with Rust backend via `src/tauri-bridge.js` using `@tauri-apps/api` `invoke()`.
