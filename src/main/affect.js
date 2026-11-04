'use strict';

// Affect engine — Phase 1 of the mood-system plan (design doc:
// %USERPROFILE%\.opencode\plan\mood-system.md).
// Keeps an internal, decaying emotional state so Kanna's moods read as
// continuous instead of one label per turn. Phase 1 is telemetry only:
// nothing here changes what the renderer sees (chat:meta still carries the
// model's `mood` verbatim, the 8 emote pairs are untouched) and the reply
// JSON protocol stays exactly as it was. Transitions and dimension drift go
// to the log file so the decay curves can be tuned from real sessions.

const log = require('./log');

// Dimension targets per emote family: valence (-1 negative → +1 positive),
// arousal (0..1), socialEnergy (0..1). `neutral` doubles as the resting
// baseline every dimension decays toward.
const MOOD_DIMS = {
  happy:    { v: +0.8, a: 0.70, s: 0.65 },
  surprise: { v: +0.4, a: 0.90, s: 0.60 },
  shy:      { v: +0.2, a: 0.45, s: 0.30 },
  neutral:  { v:  0.0, a: 0.35, s: 0.40 },
  dizzy:    { v: -0.2, a: 0.40, s: 0.35 },
  strained: { v: -0.4, a: 0.70, s: 0.40 },
  sad:      { v: -0.7, a: 0.30, s: 0.25 },
  angry:    { v: -0.7, a: 0.85, s: 0.45 },
};

// Loose labels models come up with → one of the 8 families above. Unknown
// words fall back to neutral, matching the renderer's behavior.
const FAMILY_ALIASES = {
  excited: 'happy', excitedly: 'happy', joy: 'happy', joyous: 'happy',
  cheerful: 'happy', delighted: 'happy', pleased: 'happy', love: 'happy',
  loving: 'happy', warm: 'happy', warmth: 'happy', affectionate: 'happy',
  caring: 'happy', tender: 'happy', playful: 'happy', giddy: 'happy',
  grin: 'happy', smiling: 'happy',
  shocked: 'surprise', astonished: 'surprise', amazed: 'surprise',
  startled: 'surprise', stunned: 'surprise', wow: 'surprise',
  bashful: 'shy', embarrassed: 'shy', embarrassedly: 'shy', blushing: 'shy',
  timid: 'shy', nervous: 'shy', flustered: 'shy', sheepish: 'shy',
  calm: 'neutral', serene: 'neutral', soft: 'neutral', gentle: 'neutral',
  content: 'neutral', quiet: 'neutral', sleepy: 'neutral',
  tired: 'neutral', drowsy: 'neutral', bored: 'neutral', curious: 'neutral',
  spacey: 'dizzy', woozy: 'dizzy', dazed: 'dizzy', confused: 'dizzy',
  sleepyhead: 'dizzy',
  anxious: 'strained', worried: 'strained', stress: 'strained',
  stressed: 'strained', uneasy: 'strained', pout: 'strained',
  determined: 'strained', teasing: 'strained',
  disappointed: 'sad', lonely: 'sad', gloomy: 'sad', down: 'sad',
  melancholy: 'sad', hurt: 'sad', apologetic: 'sad', sorry: 'sad',
  angry: 'angry', mad: 'angry', annoyed: 'angry', irritated: 'angry',
  indignant: 'angry', frustrated: 'angry', upset: 'angry', scolding: 'angry',
  furious: 'angry', raging: 'angry', fuming: 'angry', cross: 'angry',
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const clampJ = (x) => Math.min(1, Math.max(-1, x));

// In-memory session state — deliberately not persisted yet (persistence +
// long-term affinity is Phase 2+). Starts every launch at baseline.
const state = {
  family: 'neutral',
  held: false,
  v: 0,     // valence
  a: 0.35,  // arousal
  s: 0.40,  // social energy
  lastAt: Date.now(),
  turnsSinceHeld: 0,
};

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

// Family for a raw mood string from the model.
function familyFor(rawMood) {
  const word = String(rawMood || '').trim().toLowerCase();
  if (MOOD_DIMS[word]) return word;
  if (FAMILY_ALIASES[word]) return FAMILY_ALIASES[word];
  // Substring rescue: "slightlyHappy", "happy!?" …
  for (const f of Object.keys(MOOD_DIMS)) {
    if (word.includes(f)) return f;
  }
  for (const [alias, f] of Object.entries(FAMILY_ALIASES)) {
    if (word.includes(alias)) return f;
  }
  return 'neutral';
}

// Time decay: every dimension eases toward its baseline. `held` moods decay
// slower (she is choosing to stay there), valence slower than arousal so
// angry/sad smolders instead of snapping off. Returns the decayed snapshot.
function tick(now = Date.now()) {
  const elapsedMs = Math.max(0, now - state.lastAt);
  state.lastAt = now;
  if (elapsedMs === 0) return snapshot();

  const decay = (value, baseline, halfLifeMs) =>
    baseline + (value - baseline) * Math.pow(0.5, elapsedMs / halfLifeMs);

  const baseline = MOOD_DIMS.neutral;
  const vHalf = state.held ? 240_000 : 120_000; // held feelings linger ~2–4 min
  state.v = clampJ(decay(state.v, baseline.v, vHalf));
  state.a = clamp01(decay(state.a, baseline.a, 60_000));
  state.s = clamp01(decay(state.s, baseline.s, 150_000));
  return snapshot();
}

// One turn begins: idle time since the last turn first decays what was left
// behind, so tiny gaps keep a mood alive and long gaps land her near baseline.
function beginTurn() {
  tick();
}

// Feed the model's reply protocol meta ({ mood, speed, hold }). Blends the
// internal dimensions toward the new family with per-turn jump caps so
// opposite feelings take a couple of turns unless `hold` forces it. The
// visible behavior stays the renderer's business — this only logs.
function observe(meta, source = 'reply') {
  const target = familyFor(meta?.mood);
  const dims = MOOD_DIMS[target];
  const sameFamily = target === state.family;

  // Per-turn jump caps (plan: no wild one-turn whiplash).
  const CAP_V = 0.65;
  const CAP_A = 0.50;
  const CAP_S = 0.50;

  const before = { family: state.family, v: state.v, a: state.a };

  // Strong blend toward the target, then clamp any overshoot.
  const blend = 0.6;
  let nv = clampJ(state.v + clampJ(dims.v - state.v) * blend);
  let na = clamp01(state.a + (dims.a - state.a) * blend);
  let ns = clamp01(state.s + (dims.s - state.s) * blend);
  nv = clampJ(state.v + Math.max(-CAP_V, Math.min(CAP_V, nv - state.v)));
  na = clamp01(state.a + Math.max(-CAP_A, Math.min(CAP_A, na - state.a)));
  ns = clamp01(state.s + Math.max(-CAP_S, Math.min(CAP_S, ns - state.s)));

  const changedFamily = !sameFamily;
  state.family = target;
  state.v = nv;
  state.a = na;
  state.s = ns;
  state.lastAt = Date.now();

  // `hold` sticks: she stays on this face across turns (renderer decides how
  // long the emote shows; here it just slows decay and counts turns).
  const hold = !!meta?.hold;
  if (hold !== state.held) state.held = hold;
  if (!hold) state.turnsSinceHeld = 0; else state.turnsSinceHeld++;

  // Log only real changes — one line per family transition keeps the file
  // readable while still auditable.
  if (changedFamily) {
    log.info('[affect]', `${source}: ${before.family} → ${target} `
      + `v ${r2(before.v)}→${r2(state.v)} a ${r2(before.a)}→${r2(state.a)} `
      + `hold=${hold ? 'true' : 'false'}`);
  }
  return snapshot();
}

// User stop/interrupt mid-reply: a small arousal bump, slight negative valence
// — she registers it but nothing dramatic (full trigger priority is Phase 2).
function onInterrupt(reason = 'stop') {
  const before = { family: state.family, v: state.v, a: state.a };
  state.a = clamp01(state.a + 0.08);
  state.v = clampJ(state.v - 0.05);
  state.lastAt = Date.now();
  log.info('[affect]', `${reason}: a ${r2(before.a)}→${r2(state.a)} v ${r2(before.v)}→${r2(state.v)}`);
  return snapshot();
}

// Turn end marker: a one-line state snapshot so sessions are reconstructible
// from the log without logging the conversation itself.
function endTurn() {
  log.info('[affect]', `turn end — ${describe()}`);
  return snapshot();
}

// Human-readable one-liner of the current internal state.
function describe() {
  const dims = MOOD_DIMS[state.family];
  // Intensity = how far she sits from baseline right now (0..1).
  const intensity = clamp01(Math.abs(state.v - dims.v) * 0.15
    + Math.abs(state.v) * 0.35
    + Math.max(0, state.a - 0.35) * 0.5);
  return `${state.family}${state.held ? ' (held)' : ''} `
    + `v=${r2(state.v)} a=${r2(state.a)} s=${r2(state.s)}`
    + ` intensity=${r2(intensity)}`;
}

function snapshot() {
  const dims = MOOD_DIMS[state.family];
  return {
    family: state.family,
    held: state.held,
    valence: r2(state.v),
    arousal: r2(state.a),
    socialEnergy: r2(state.s),
    intensity: r2(clamp01(Math.abs(state.v) * 0.5 + Math.max(0, state.a) * 0.5)),
    targets: dims,
    ageMs: Date.now() - state.lastAt,
    turnsSinceHeld: state.turnsSinceHeld,
    describe: describe(),
  };
}

// Debug/mood-reset hook (Settings panel comes later).
function reset() {
  state.family = 'neutral';
  state.held = false;
  state.turnsSinceHeld = 0;
  const b = MOOD_DIMS.neutral;
  state.v = b.v;
  state.a = b.a;
  state.s = b.s;
  state.lastAt = Date.now();
  log.info('[affect]', 'reset to baseline');
  return snapshot();
}

module.exports = {
  MOOD_DIMS,
  FAMILY_ALIASES,
  beginTurn,
  observe,
  onInterrupt,
  endTurn,
  tick,
  describe,
  snapshot,
  reset,
};
