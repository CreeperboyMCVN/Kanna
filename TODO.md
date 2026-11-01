# TODO

Backlog of things not built yet. Pick from the top when starting something new.

## Agentic — starts after the simple chat feature is finished

- [ ] **Kanna writes code into a real text editor** — code blocks already
  stay out of the bubble (a `⌘ lang · N lines — written to editor` chip
  appears instead). Next step, on finalize: if the reply contained fenced
  blocks, main writes each one to `%APPDATA%\Kanna\code\<n>.<ext>`
  (extension guessed from the fence tag), opens it with `shell.openPath` so
  the user's default editor picks it up, and the chip confirms. Chips are
  clickable to re-open their file later. The "writing…" state becomes the
  moment she types the file in — fs write while the model streams.

## Next candidates

- [x] **Installer sanity check** — `npm run dist` now runs end to end; a
  512×512 icon was generated from the happy emote (`assets/icon.png`,
  converted to .ico by electron-builder); the packaged app launches from
  `dist/win-unpacked/Kanna.exe` and the installer is `dist/Kanna Setup 0.1.0.exe`.
- [ ] **TTS — she speaks her replies aloud** — voice selection: built-in
  Chromium `speechSynthesis` (offline OS voices, zero deps) vs a cloud/engine
  voice; tie rate & pitch to the reply's `speed`/mood fields; mute toggle in
  the header; keep her from talking over the typewriter (speak after each
  visible sentence, or after finalize).
- [ ] **STT — push-to-talk** — a mic button (or hotkey hold) recording to a
  file, transcribed via a local engine (whisper.cpp / Vosk) or the provider's
  audio API, then injected into the input as if typed. Pick one engine; config
  lands in the Brain tab.

## Protocol / hardening ideas

- [ ] **JSON mode where supported** — OpenAI-compatible endpoints often take
  `response_format: { type: 'json_object' }`; passing it would stop weak
  local models from breaking the reply protocol.
- [ ] **Extraction alias for failed providers** — if the memory-extraction
  request keeps failing on tiny models, consider letting the panel add/edit
  facts by hand.

## Deliberately not done (revisit only if asked)

- Full chat history persistence — memory is durable **facts** only, by
  design; history is in-memory and cleared on close.
- Pet / separate sprite window — tried, undone, then decided against in
  favor of the turn-box chat box (no second window at all).
- Maximize/resize handling — the window is fixed 340×400 (`resizable: false`,
  maximize button removed) on purpose.
