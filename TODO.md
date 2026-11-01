# TODO

Backlog of things not built yet. Pick from the top when starting something new.

## Next candidates

- [ ] **Markdown in bubbles** — replies with code/lists render as a text soup
  today. Small safe pass: bold, italic, inline/code blocks, newlines. No
  links/images (nothing clickable).
- [ ] **Encrypt API keys with `safeStorage`** — they sit plaintext in
  `%APPDATA%\Kanna\settings.json` (DPAPI on Windows). Rename legacy plaintext
  values on first load after upgrade.
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
