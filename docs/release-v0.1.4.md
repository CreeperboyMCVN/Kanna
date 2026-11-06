## Kanna v0.1.4 — the mood system update

Phases 1–5 of the mood-system plan shipped.

### Affect engine & triggers
- Internal decaying emotional state (valence/arousal/social energy, jump caps, per-family decay) — moods read as continuous, not one emote per turn
- Chat behavior triggers: same-message spam (variants included), message flooding, and repeated window shakes all feed one grudge pool that cools one level per quiet turn
- Tone reading (unkind / affectionate / apology / tease / praise) with guardrails: teasing can't soften her while she's fed up or angry, apologies melt a grudge only over repeated turns, warmth has to build back-to-back before she melts

### Model-driven moods
- Standing emotional direction + continuity line in every system prompt — the model owns Kanna's mood from recent chat history
- Optional `"intensity": 0-1` reply field (Phase 3): face scales subtly in three bands; absent keys fall back gracefully to the engine's computed intensity
- Intensity emote variants (Phase 4): `happy/angry/sad/shy/strained/surprise/teasing/boring` speak as `-i1/i2/i3` art; `neutral`/`dizzy` speak as `-speak-all`; protocol labels unchanged

### Reactions
- **Shake detection rework**: counting is now weighted by swing distance (gentle +1, firm +2, violent +3), totaled when the burst settles
- Shake → **position freeze** → the model answers in her mood (dizzy 1–3 shakes, angry past that) with conversation context from the chat tail → unfreeze after typing + voice finish, with lock/unlock toasts
- Shake events and replies enter chat history; fallback canned pool if the model is unreachable
- Tiered welcome-back lines after ≥5 min away; sleepy still after ~3 min idle with wake-on-interaction

### Phase 5 — long-term affinity + report UI
- Persistent relationship score 0–100 (`%APPDATA%\Kanna\affect.json`): sweet/praise/apology turns raise it, meanness and shaking lower it; the resting baseline tilts with it
- New **Settings → Mood** panel: live affect snapshot, affinity bar, `Reset mood` (keeps affinity) and `Reset affinity` (back to 30)

### Installers
- `Kanna Setup 0.1.4.exe` — regular, CPU Piper voice server
- `Kanna-Setup-0.1.4-cuda.exe` — GPU Piper (`--gpu`, 14 NVIDIA DLLs bundled)
