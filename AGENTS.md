# AGENTS.md

Kanna — a desktop AI companion app. Stack: JavaScript + Electron, packaged with electron-builder, managed with npm.

**Rule:** build and publish (installer builds, version bumps, GitHub releases) only when explicitly asked.

## Repo state

Current state (Nov 2026): chat, settings, memory, tray/hotkey, turn-box UI, TTS, STT, persistent Piper server, and CUDA installer builds are implemented. File logging is available under `%APPDATA%\\Kanna\\logs`. There is no automated test suite or CI yet.

- `package.json` + `package-lock.json` at root. Dev deps: `electron`, `electron-builder`. Scripts include `npm start`, `npm run clean:dist`, `npm run dist`, `npm run dist:cuda`, `npm run dist:all`, optional `piper:build`/`stt:build`/`piper:build:cuda` (output in `dist/`, GPU server build uses `.opencode/cuda-venv`).
- Packaged artifacts already exist (when built): `dist/Kanna Setup 0.1.x.exe`, `dist/Kanna-Setup-0.1.x-cuda.exe`, `dist/win-unpacked/`. The released version is currently v0.1.3.
- Source layout:
  - `src/main/main.js` — window + IPC (`settings:get/save`, `models:list`, `chat:send`, `chat:stop`, `memory:*`, `tts:speak/cancel`, STT, window buttons), tray, Ctrl+Shift+K summon, remembered window position. `settings:save` stops the Piper server so the next speak rebuilds it with fresh flags.
  - `src/main/settings.js` — settings store at `%APPDATA%\Kanna\settings.json`; API/TTS keys encrypted at rest with safeStorage (DPAPI), plaintext in memory, migration on load. Includes `tts.piperUseGpu`.
  - `src/main/memory.js` — durable facts in `%APPDATA%\Kanna\memory.json`; post-turn extraction; injected into system prompt.
  - `src/main/ai.js` — providers (OpenAI, custom, OpenCode, Anthropic, Gemini), SSE streaming, model listing, JSON reply protocol reader.
  - `src/main/affect.js` — internal affect engine (Phase 1 of the mood system plan): per-family valence/arousal/socialEnergy targets, per-turn blend with jump caps, time decay toward the neutral baseline, alias mapping for loose mood words, stop/interrupt nudges, and one-line `[affect]` logs for transitions and turn ends. Phase 2 triggers live here: consecutive same-message spam (`noteRepeat` + `styleNote`) makes her annoyed; keyword tone read of the user's message (`noteUserTone` — unkind/affectionate/apology/tease/praise incl. hearts and ":3") nudges valence/arousal and emits a level-matched in-character style note into the system prompt. Annoyance and tone cool one level per quiet turn; triggers are skipped for memory-extraction runs (`plain:true`). In-memory only; reply protocol and renderer emotes unchanged.
  - `src/main/stt.js` — local Vosk STT server client (PCM streaming, partial/final results; prefers the frozen `kanna-stt-server.exe`, falls back to `py` + `resources/stt/stt_server.py`).
  - `src/main/log.js` — rotating file logger (`%APPDATA%\Kanna\logs\kanna.log`).
  - `src/main/tts.js` — built-in speechSynthesis or cloud (ElevenLabs, OpenAI, Azure, Google); Piper runs CLI or persistent HTTP server (`resources/piper/piper_server.py` / `kanna-piper-server.exe`). Supports `--gpu`; CUDA DLLs are staged automatically.
  - `src/preload/preload.js` — `window.kanna` bridge.
  - `src/renderer/` — `index.html`, `style.css`, `renderer.js`, `settings.js`.
- Renderer uses all 16 emote files and `assets/background/1.png`.
- History is in-memory only; each request sends last 24 messages plus persona.

## Product behavior

- Fixed 340x400 frameless transparent window; no resize/maximize.
- Close hides to tray; Quit only from tray menu; Ctrl+Shift+K summons.
- Window position restored only when it fits a connected display.
- Turn-box: current reply large, previous half small, tap to compose/interrupt, Escape closes, History drawer.
- Memory: durable facts, never secrets; view/clear in Settings -> Memory.
- Mood/speed/hold controlled by model via JSON reply protocol; graceful fallback to raw text.
- TTS: built-in or cloud/engine voices, free-text voice ID, rate/pitch sliders, mute toggle, speech-paced typing.
- Provider keys/models remembered separately.

## IPC contract

`settings:get`, `settings:save`, `models:list`, `chat:send`, `chat:stop`, `memory:get`, `memory:remove`, `memory:clear`, `tts:speak`, `tts:cancel`, `win:min`, `win:close`.

`chat:send` emits `chat:chunk` and `chat:meta` {mood,speed,hold}, resolves `{ stopped, text }`; streaming errors reject. `runChat(messages, emit, system, opts)` supports `registerInActive` and `plain`.

## Assets

- Emotions are pairs: `<emotion>.png` and `<emotion>-speak.png`.
- Current emotions: angry, dizzy, happy, neutral, sad, shy, strained, surprise.
- Backgrounds numbered in `assets/background/`.
- `assets/icon.ico` tray/window; `assets/icon.png` 512x512 installer icon.

## Notes

- npm may gate install scripts; if Electron binary missing run `node node_modules/electron/install.js`.
- Trust `package.json` over this file.
- Main process owns network requests; abortable with AbortController.
- Treat settings.json like `.env`: encrypted key blobs plus plaintext config.
- `memory.js` and `ai.js` lazy-require each other to avoid circular requires.
- No test framework; run `node --check` on touched JS and smoke-test with `npm start`.