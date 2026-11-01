# AGENTS.md

Kanna — a desktop AI companion app. Stack: JavaScript + Electron, packaged with electron-builder, managed with npm.

## Repo state

Scaffolded (verified Nov 2026):

- `package.json` + `package-lock.json` at the root. Dev deps: `electron`, `electron-builder`. Scripts: `npm start` (run app), `npm run dist` (electron-builder; output in `dist/`).
- No git history, tests, or CI yet.
- Source layout:
  - `src/main/main.js` — window + IPC wiring (`settings:get/save`, `models:list`, `chat:send`, `chat:stop`, `memory:*`, window buttons), tray (`assets/icon.ico`; close hides to tray, Quit from the tray menu only), Ctrl+Shift+K global summon hotkey, and remembered window position (settings.json `window` block, restored only when it still fits a connected display).
  - `src/main/settings.js` — settings store; persists to `%APPDATA%\Kanna\settings.json`. API keys are encrypted at rest (safeStorage → DPAPI on Windows) as `enc:v1:<base64>`; the in-memory cache stays plaintext for the drawer and adapters, `getSettings()` decrypts on load and migrates legacy plaintext keys on first load; `persist()` re-encrypts every key variant on save. Falls back to plaintext storage if the OS can't encrypt. Everything else (`provider`, `persona`, models, base URL) is plaintext.
  - `src/main/memory.js` — long-term memory: `%APPDATA%\Kanna\memory.json` facts store; after each successful turn `scheduleRemember()` asks the same provider for a JSON add/remove diff (`registerInActive: false` so it can't be aborted by the chat stop button); facts are injected into the chat system prompt via `ai.js → composeChatSystem()`. Extraction is fire-and-forget; parse failures are ignored.
  - `src/main/ai.js` — provider adapters with SSE streaming (OpenAI, OpenCode gateway `https://opencode.ai/inference/openai/v1`, any OpenAI-compatible base URL (`custom`), Anthropic, Gemini) plus `listModels()` for the per-provider fetch-models button. Reply protocol: chat replies are one JSON object `{"mood":…,"speed":…,"hold":…,"text":…}` (keys in that order); `createReplyReader()` incrementally decodes the raw stream, emitting `chat:meta` {mood,speed,hold} plus decoded `chat:chunk` text. Replies that don't start as JSON pass through raw; broken JSON is salvaged as raw so bubbles are never empty. Memory extraction passes `plain: true` to skip the reader.
  - `src/preload/preload.js` — contextBridge API as `window.kanna` (settings, memory, chat, `chat:meta`, window buttons).
  - `src/renderer/` — `index.html`, `style.css`, `renderer.js` (chat + emote/mood logic, lightweight markdown rendering — fenced code blocks become a "written to editor" chip, the agentic editor action is pending in TODO.md), `settings.js` (settings drawer).
- Renderer uses these assets: all 16 emote files (`<emotion>.png`/`-speak.png`) and `assets/background/1.png` as the chat backdrop.
- Conversation history lives in the renderer only (in-memory, cleared on close); each request sends the last 24 messages plus the persona as system prompt.
- If you change chat behavior, keep the IPC contract in mind: `runChat` emits `chat:chunk` (decoded visible text) plus `chat:meta` {mood,speed} events and resolves `{ stopped, text }`; streaming errors reject the `chat:send` invoke.
- Note: this machine's npm gates install scripts ("allowScripts"). If Electron's binary is ever missing (`node_modules/electron/dist/`), run `node node_modules/electron/install.js`. `electron-winstaller`'s install script may still be pending-approval; only relevant for Squirrel.Windows packaging.
- Trust `package.json` over this file if they disagree.

## Assets — naming conventions

- `assets/emotes/` holds Kanna's expressions. Every emotion is a **pair**: `<emotion>.png` (idle) and `<emotion>-speak.png` (talking variant). The `-speak` suffix is the only marker of the talking art, never rename one of a pair.
- Current emotions (8): `angry`, `dizzy`, `happy`, `neutral`, `sad`, `shy`, `strained`, `surprise`. New emotions need both files.
- `assets/background/` holds numbered background images (`1.png`); new ones continue the numbering.
