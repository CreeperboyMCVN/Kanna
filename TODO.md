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

- [ ] **Installer sanity check** — `npm run dist` has never been run; the
  Windows target needs a real `.ico` (can generate from the happy emote),
  then verify the packaged app runs from `dist/`.
- [ ] **TTS — she speaks her replies aloud** *(after the first `npm run dist`)* —
  voice selection: built-in Chromium `speechSynthesis` (offline OS voices,
  zero deps) vs a cloud/engine voice; tie rate & pitch to the reply's
  `speed`/mood fields; mute toggle in the header; keep her from talking over
  the typewriter (speak after each visible sentence, or after finalize).
- [ ] **STT — push-to-talk** *(after the first `npm run dist`)* — a mic button
  (or hotkey hold) recording to a file, transcribed via a local engine
  (whisper.cpp / Vosk) or the provider's audio API, then injected into the
  input as if typed. Pick one engine; config lands in the Brain tab.

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
  favor of the compact chatbox (two latest turns + History tab).
- Maximize/resize handling — the window is fixed 340×560 (`resizable: false`,
  maximize button removed) on purpose.
