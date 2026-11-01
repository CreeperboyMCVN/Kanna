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
- Per-provider keys/model are remembered separately, so switching providers
  keeps each one configured.
- **Long-term memory** — after each turn, Kanna runs a quiet background
  request to the same provider asking "did anything durable just change?",
  and stores the answers as short facts in `memory.json` (never secrets).
  The facts ride along with every new conversation's system prompt, and you
  can inspect/clear them in ⚙ Settings → Memory.
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
Keys are stored on this device only — they are never sent anywhere except to
the provider you chose. (Moving secrets to Electron's `safeStorage` is a nice
future upgrade.)

## Packaging

```powershell
npm run dist          # current platform -> dist/
npm run dist -- --win # explicit Windows NSIS installer
```

## Project structure

```
src/
  main/      Electron main process
    main.js       window + IPC wiring
    settings.js   settings store (defaults, merge, persistence)
    ai.js         provider adapters + SSE streaming
  preload/
    preload.js    contextBridge API (window.kanna)
  renderer/
    index.html    layout (header, stage, chat, settings drawer)
    style.css     theme
    renderer.js   chat + emote/mood logic
    settings.js   settings drawer logic
assets/        emote pairs + background art
```

## Notes

- Requests run in the main process (no CORS headaches), stream over IPC, and
  can be aborted.
- Keys are plain text in the settings file on your machine; treat the file like
  a `.env`.
