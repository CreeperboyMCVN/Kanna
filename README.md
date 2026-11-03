# Kanna 🦊

A tiny desktop AI companion built with Electron. Kanna lives in a small window,
reacts to her own replies with expressions, and you can chat with her through
your choice of AI provider.

## Features

- **Simple chat** — streaming replies, Enter to send, Shift+Enter for a newline,
  and a stop button that interrupts Kanna mid-sentence.
- **Every emotion has an emote** — Kanna swaps between `assets/emotes/` artwork:
  a `-speak` variant while her reply streams in, then a mood-matched idle face
  (naive keyword-based mood detection) before settling back to neutral.
- **Settings drawer** — pick your AI provider, store its API key, model and
  (for custom endpoints) base URL, and edit the persona/system prompt.
- **Provider support**
  - OpenAI
  - Anthropic (Claude)
  - Google (Gemini)
  - Any OpenAI-compatible endpoint (OpenRouter, LM Studio, Ollama, …)
  - OpenCode (the opencode.ai gateway — GLM, Kimi, Qwen, Claude, GPT and
    friends, with some free models; pay-as-you-go key from the console)
- **Fetch models ↻** — the Brain tab can pull the live model list for the
  selected provider into a type-ahead list, so model IDs no longer have to
  be typed from memory.
- Per-provider keys/model are remembered separately, so switching providers
  keeps each one configured.
- **Keys are encrypted at rest** — API keys in `settings.json` are sealed
  with your OS account (safeStorage → DPAPI on Windows), decrypted only in
  memory. Existing plaintext keys migrate automatically on first launch.
- **Remembers where she lives** — the window reopens where you last dragged
  it (saved to settings.json), clamped to whichever screen is connected, so
  an unplugged monitor can't strand her offscreen.
- **Tray + summon hotkey** — she lives in the notification area
  (assets/icon.ico): clicking the tray raises her, Ctrl+Shift+K works from
  anywhere. The ✕ button hides her to the tray — **Quit only via the tray
  menu**, so chats and streaming survive accidental closes.
- **Turn-box chat** — one bordered box carries the exchange: her current
  reply fills it big (scrolling inside, no scrollbar), the other half of the
  exchange sits small on top. Clicking the very bottom of the box opens the
  composer *inside* the box — her reply pushes to the small top line, your
  last message takes the big spot — and while she's streaming the same click
  interrupts her. After you send, your message becomes the top line and her
  reply streams into the big spot. The 🕘 History tab in the header opens the
  full in-memory session log, older turns included.
- **Long-term memory** — after each turn, Kanna runs a quiet background
  request to the same provider asking "did anything durable just change?",
  and stores the answers as short facts in `memory.json` (never secrets).
  The facts ride along with every new conversation's system prompt, and you
  can inspect/clear them in ⚙ Settings → Memory.
- **Speech-to-text** — 🎤 in the composer transcribes locally with
  Vosk (click to talk, click again to insert); final text lands in the input
  as if typed.
- **Text-to-speech** — Kanna can speak her replies: built-in OS voices
  (`speechSynthesis`), cloud engines (ElevenLabs, OpenAI TTS, Azure Speech,
  Google Cloud TTS), or local Piper (default model `resources/piper/en_US.onnx`,
  speaker `746`). Piper now prefers a persistent local HTTP server for speed and,
  if present, the optional `kanna-piper-server.exe` bundle. Pick the
  provider/voice/rate/pitch in ⚙ Settings → Brain, test Piper there, mute from
  the header toggle, and reply typing is paced to the spoken duration.
- **Mood + speech speed, decided by the model** — every reply is one JSON
  object `{"mood":"…","speed":…,"hold":…,"text":"…"}`. The mood picks which
  of the 8 emotes she wears (set *before* she starts talking), speed scales
  the typing pace (0.7 hushed → 1.8 excited), and `hold: true` keeps that
  emotion on her face across turns instead of easing back to neutral after
  a few seconds. Replies that don't follow the protocol degrade gracefully
  to plain text with keyword-based moods.

## Quick start

```powershell
npm install
npm start
```

The app opens in development mode with default settings, then:

1. Click the ⚙ button (or let Kanna nudge you) to open Settings.
2. Choose a provider, paste its API key, adjust the model/persona, Save.
3. Chat away.

Conversations are kept in memory only — closing the window clears the chat.
Settings persist across launches.

## Where settings live

`%APPDATA%\Kanna\settings.json` (created on first save), holding the provider
choice, per-provider keys/models, the persona, and the custom base URL.
Keys (AI and TTS) are encrypted at rest on this device with
Electron's `safeStorage` (DPAPI on Windows) and decrypted only in memory;
plaintext keys from older installs migrate automatically. They are never
sent anywhere except to the provider you chose.

## Packaging

```powershell
npm install
npm run piper:build   # optional: build resources/piper/kanna-piper-server.exe (requires Python + PyInstaller)
npm run dist          # current platform -> dist/
npm run dist -- --win # explicit Windows NSIS installer
```

Piper runs from Python by default; if `kanna-piper-server.exe` is present it is
preferred and removes the need for a system Python install.`

## Project structure

```
src/
  main/      Electron main process
    main.js       window + IPC wiring
    settings.js   settings store (defaults, merge, persistence)
    ai.js         provider adapters + SSE streaming
    tts.js        TTS backends (cloud + Piper) via main process
    memory.js     long-term memory store + extraction
  preload/
    preload.js    contextBridge API (window.kanna)
  renderer/
    index.html    layout (header, stage, chat, settings drawer)
    style.css     theme
    renderer.js   chat + emote/mood logic
    settings.js   settings drawer logic
assets/        emote pairs + background art
```

## Build

```bash
npm run dist
```

Produces `dist/Kanna Setup 0.1.0.exe` (NSIS installer) plus `dist/win-unpacked/`
(the unpacked app, handy for a quick smoke test). The tray/window icon is
`assets/icon.ico` (32×32); the installer icon is `assets/icon.png` (512×512,
generated from the happy emote).

- Requests run in the main process (no CORS headaches), stream over IPC, and
  can be aborted.
- API/TTS keys are stored encrypted in `settings.json`; treat the file like a
  `.env`.
