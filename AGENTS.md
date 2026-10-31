# AGENTS.md

Kanna — a desktop AI companion app. Stack: JavaScript + Electron, packaged with electron-builder, managed with npm.

## Repo state

Scaffolded (verified Nov 2026):

- `package.json` + `package-lock.json` at the root. Dev deps: `electron`, `electron-builder`. Scripts: `npm start` (run app), `npm run dist` (electron-builder; output in `dist/`).
- No git history, tests, or CI yet.
- Source layout:
  - `src/main/main.js` — window + IPC wiring (`settings:get/save`, `chat:send`, `chat:stop`).
  - `src/main/settings.js` — settings store; persists to `%APPDATA%\Kanna\settings.json` (plaintext API keys: openai/anthropic/gemini/custom blocks + `provider`, `persona`).
  - `src/main/ai.js` — provider adapters with SSE streaming (OpenAI + any OpenAI-compatible base URL (`custom`), Anthropic, Gemini).
  - `src/preload/preload.js` — contextBridge API as `window.kanna`.
  - `src/renderer/` — `index.html`, `style.css`, `renderer.js` (chat + emote/mood logic), `settings.js` (settings drawer).
- Renderer uses these assets: all 16 emote files (`<emotion>.png`/`-speak.png`) and `assets/background/1.png` as the chat backdrop.
- Conversation history lives in the renderer only (in-memory, cleared on close); each request sends the last 24 messages plus the persona as system prompt.
- If you change chat behavior, keep the IPC contract in mind: `runChat` emits `chat:chunk` events and resolves `{ stopped, text }`; streaming errors reject the `chat:send` invoke.
- Note: this machine's npm gates install scripts ("allowScripts"). If Electron's binary is ever missing (`node_modules/electron/dist/`), run `node node_modules/electron/install.js`. `electron-winstaller`'s install script may still be pending-approval; only relevant for Squirrel.Windows packaging.
- Trust `package.json` over this file if they disagree.

## Assets — naming conventions

- `assets/emotes/` holds Kanna's expressions. Every emotion is a **pair**: `<emotion>.png` (idle) and `<emotion>-speak.png` (talking variant). The `-speak` suffix is the only marker of the talking art, never rename one of a pair.
- Current emotions (8): `angry`, `dizzy`, `happy`, `neutral`, `sad`, `shy`, `strained`, `surprise`. New emotions need both files.
- `assets/background/` holds numbered background images (`1.png`); new ones continue the numbering.
