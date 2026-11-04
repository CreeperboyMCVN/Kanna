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
- [x] **TTS — she speaks her replies aloud (done; needs more testing)** — implemented: built-in
  `speechSynthesis`, cloud backends (ElevenLabs, OpenAI TTS, Azure Speech,
  Google Cloud TTS) and local Piper; provider/voice/rate/pitch config,
  encrypted keys, header mute toggle, speech-paced typing. Piper now loads a
  model from `resources/piper`, defaults to speaker `746`, and can run as a
  persistent local HTTP server (`resources/piper/piper_server.py`) for faster
  repeat synthesis, with `npm run piper:build` producing the optional
  `resources/piper/kanna-piper-server.exe`. Remaining polish: Piper checker
  diagnostics in Settings, crate/bundle cleanup, tune sync/timing, and tie
  rate/pitch/mood more closely to the reply's `speed`/mood fields.
- [x] **STT — push-to-talk (implemented via Python Vosk; needs more testing)** —
  mic button in header captures 16 kHz PCM in the renderer, streams it to
  the local Vosk server (`resources/stt/stt_server.py`), and inserts the
  final transcript into the composer. Partial results appear as toasts.

## Assistant / pet ideas (later)

- [ ] **Screen-aware reactions (opt-in)** — let Kanna capture a low-res
  screenshot on an explicit trigger or hotkey, send it to a vision-capable
  model, and react in character. Needs a visible capture indicator, strict
  opt-in, and blur/full-screen privacy controls.
- [ ] **Clipboard companion** — offer summarize/translate/explain/review
  actions when the clipboard changes, especially for pasted errors, links,
  JSON, or code.
- [ ] **Proactive check-ins** — suggest remembered tasks or follow-ups based on
  durable memory and time of day, with quiet hours and an easy mute/disable.
- [ ] **Action tools with confirmation** — safe explicit helpers such as
  opening files/URLs, searching notes, creating snippets, or changing
  settings; always show a confirmation chip before side effects.
- [ ] **Optional overlay pet window (settings toggle)** — a separate
  transparent, always-on-top sprite window walking along the bottom of the
  screen; click summons the chat window. Reinforces the pet feel but brings
  back a second-window lifecycle.
- [ ] **Lively in-window pet states** — idle animations, wandering/siting
  (sit/sleep), edge peeking, and reactions to long pauses without leaving the
  main window.
- [ ] **Active-window awareness (opt-in)** — position Kanna above/near the
  focused window using a native dependency and polled window rects. Privacy
  and performance implications need a clear opt-in.
- [ ] **Playful but harmless "dragging"** — let the pet appear to grab and
  drag an overlay-only object (plushie/icon/branch), not real OS windows.

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

## Completed recently (v0.1.3)

- [x] **New emotes: teasing + bored, dozing still** — two new emote pairs
  (`teasing`, `bored`, with `-speak` variants) wired into `EMOTES`,
  `MOOD_ALIASES`, the keyword `MOOD_RULES` fallback, the protocol's mood
  list, and the affect engine (`MOOD_DIMS` + `FAMILY_ALIASES`; teaser
  words like `smirk`/`mischievous` → teasing, `meh`/`unimpressed`/`sleepy`
  → bored). Non-mood art lives in `assets/still/`: after ~3 min idle
  (nothing held, not busy) the renderer shows `assets/still/sleep.png`;
  any pointer/key activity or new turn wakes her back to neutral.
  Tone-note for user teasing now suggests the `teasing` mood.

- [x] **Mood system — model directs the mood (history-aware)** — every chat
  system prompt now carries a standing `Emotional direction` block: the
  model judges mood from the whole recent history (not per-message), keeps
  `hold` for lingering feelings, and can optionally write
  `"intensity": 0-1` (parsed in the reply reader, feeds
  `affect.state.modelIntensity` for snapshot/TTS use). A one-line
  `Feeling carried over from previous turns: …` (`affect.moodCarry()`)
  gives the model continuity: current family, held flag, and active
  irritation level/kind.
- [x] **Mood system — broader spam detection** — `userRepeatCount` now
  normalizes hard (case/whitespace/punctuation/emoji stripped, letter-runs
  like `hiiii`→`hi` collapsed) and applies a Levenshtein ratio ≥ 0.7 so
  near-variants ("why did you say that" vs "WHY DID YOU SAY THAT…!").
  New `rapidUserStreak` catches the other shape: ≥ 3 unanswered user
  messages in a row (`noteFlood`) — different content still counts, style
  note differs (flustered "one at a time!" vs exasperated "stop flooding
  me"). Repeat and flood share one irritation pool; only escalation moves
  the dimensions.

- [x] **Mood system — Phase 2 trigger #2 (emotional tone read)** —
  `noteUserTone` in `src/main/affect.js` keyword-reads the user's latest
  message (unkind / affectionate / apology / tease / praise, incl. hearts,
  `<3`, `:3`; severity-ordered so unkind beats sweet). Each tone nudges
  valence/arousal/social plus emits a level-matched in-character style note
  (sweet → shy/happy flustered, mean → hurt sad, sorry → warm forgiveness,
  tease → pouting comeback, praise → beaming happy). Tones cool one level
  per turn, and `beginTurn`/`noteRepeat`/`noteUserTone` are all skipped for
  memory-extraction chat runs (`plain: true`) so her mood isn't polluted
  by background calls.

- [x] **Mood system — Phase 2 first trigger (repeat-spam annoyance)** —
  consecutive identical user messages (case/whitespace-normalized, 3+ in a
  row) raise Kanna's annoyance level (1–3, capped) in `src/main/affect.js`:
  internal valence/arousal nudge plus a level-matched style note injected
  into the system prompt so she visibly calls it out in character
  (strained → fed-up → angry). Annoyance cools one level per turn without
  repeats. `[affect] repeat xN` log line per escalation.

- [x] **Mood system — Phase 1 (affect engine)** — new `src/main/affect.js`:
  internal valence/arousal/socialEnergy per emote family, blend toward the
  model's chosen mood with per-turn jump caps, time decay back to the neutral
  baseline (held moods decay slower), alias table for loose mood words
  (`furious`, `cheerful`, …), stop/interrupt nudges, and `[affect]` log lines
  for every family transition + one turn-end snapshot line. In-memory only —
  reply protocol, `chat:meta`, and the 8 emote pairs are unchanged (renderer
  untouched). Phase 2 (trigger priorities, error stress, persistent affinity)
  still to do.

- [x] **Packaging split** — `npm run dist:all` cleans `dist/`, then builds normal Piper + app + CUDA Piper + CUDA app. Installers: `Kanna Setup X.Y.Z.exe` and `Kanna-Setup-X.Y.Z-cuda.exe`.
- [x] **Piper GPU (NVIDIA)** — `--gpu` flag with CUDA/cuDNN staged via `_add_cuda_dll_dirs()`; Settings → Voice **Piper GPU** checkbox (`tts.piperUseGpu`); server stops on save and the next speak rebuilds it with refreshed flags.
- [x] **File logging** — rotating `kanna.log` under `%APPDATA%\Kanna\logs`, including startup snapshot, server lifecycle (with deliberate-stop vs. crash distinction), IPC traces, and global exception/rejection handlers.
- [x] **One-file CUDA EXE** — isolated `.opencode/cuda-venv` with onnxruntime-gpu (CUDA execution provider verified via nvidia-smi).