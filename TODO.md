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

- [ ] **"Fetch models" button per provider** — hit `/models` (OpenAI +
  custom OpenAI-compatible), Anthropic and Gemini listing endpoints, so
  nobody has to type model IDs blind.
- [ ] **Tray icon + summon hotkey** — global accelerator (e.g. Ctrl+Shift+K)
  to show/focus the chat, close-to-tray instead of quitting.
- [ ] **Remember window position** — dragging works but position resets
  every launch; persist x/y and restore (with on-screen sanity clamping).
- [ ] **Pet window, done right** — separate always-on-top sprite window,
  own remembered screen position, mood broadcast from main so both windows
  stay in sync. (An earlier two-window split was tried and undone — redo
  only if wanted.)
- [ ] **Installer sanity check** — `npm run dist` has never been run; the
  Windows target needs a real `.ico` (can generate from the happy emote),
  then verify the packaged app runs from `dist/`.

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
- Maximize/resize handling — the window is fixed 340×560 (`resizable: false`,
  maximize button removed) on purpose.
