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

// Phase 2 trigger #1 — annoying chat behavior. The user hammering the same
// sentence in (consecutive repeats) is a high-priority social trigger: it
// leaves Kanna irritable even after the repeats stop (cools one level per
// turn). noteRepeat() feeds the emotion, styleNote() turns it into an
// in-character instruction the model receives in its system prompt.
const state = {
  family: 'neutral',
  held: false,
  v: 0,     // valence
  a: 0.35,  // arousal
  s: 0.40,  // social energy
  lastAt: Date.now(),
  turnsSinceHeld: 0,
  annoyed: 0, // 0 calm … 3 fed up (consecutive same-message repeats minus 2)
  tone: { kind: null, level: 0 }, // last emotional tone read from the user
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
// Irritation (message spam) and leftover user tone cool here: one level per turn.
function beginTurn() {
  tick();
  if (state.annoyed > 0) {
    state.annoyed--;
    if (state.annoyed === 0) log.info('[affect]', 'annoyance cooled — user stopped repeating');
  }
  if (state.tone.level > 0) {
    state.tone.level--;
    if (state.tone.level === 0) state.tone.kind = null;
  }
}

// n = consecutive repeats of the user's current message (3+ = spamming).
function noteRepeat(n) {
  if (!Number.isFinite(n) || n < 3) return snapshot();
  const level = Math.min(3, n - 2); // 3 repeats → 1 … 6+ → 3 (capped)
  if (level === state.annoyed) return snapshot();
  const before = { v: state.v, a: state.a };
  state.annoyed = level;
  // Irritation: heavier with each extra repeat, capped so she sulks, never rages.
  state.v = clampJ(state.v - 0.12 * level);
  state.a = clamp01(state.a + 0.08 * level);
  state.lastAt = Date.now();
  log.info('[affect]', `repeat x${n}: annoyed level ${level} `
    + `v ${r2(before.v)}→${r2(state.v)} a ${r2(before.a)}→${r2(state.a)}`);
  return snapshot();
}

// Full style note for the system prompt: annoyance (repeat spam) and/or the
// user's emotional tone, joined. Only present when something is actually
// happening, so normal chat sends the exact same prompt as before.
function styleNote() {
  const notes = [];
  if (state.annoyed > 0) {
    const lines = {
      1: 'Right now, in character: the user has repeated the same message three times — Kanna is getting visibly annoyed. Keep replying as her, call it out plainly or with a strained sigh (mood "strained"). Do not repeat yourself either.',
      2: 'Right now, in character: the user keeps hammering the same message — Kanna is fed up with it. React like a real person would: flustered, exasperated, maybe a little scolding (mood "strained" or "angry", speed higher). Stay Kanna, stay kind underneath.',
      3: 'Right now, in character: the user has now spammed the same message six or more times — Kanna has had ENOUGH. She says so sharply (mood "angry", speed 1.5+), maybe pouts or threatens to ignore further repeats. Still in character, still caring underneath.',
    };
    const l = lines[state.annoyed];
    if (l) notes.push(l);
  }
  const tone = toneNote();
  if (tone) notes.push(tone);
  return notes.join(' ');
}

// --- Phase 2 trigger #2 — how the user SAYS things ---------------------------
// Keyword-based tone read of the user's latest message. Deliberately small
// and conservative: normal chat matches nothing, so the system prompt stays
// byte-identical to before unless an obvious emotional phrase shows up.

const TONE_WORDS = {
  // severity order matters: first match by count wins, ties → first in list
  unkind: /\b(stupid|idiot|dumb|hate you|hate this|shut up|useless|ugly|boring|annoying)\b/g,
  affectionate: /\b(i love you|love you|i adore|adorable|beautiful|pretty|cute|pretty face|good girl|best girl|my girl|mwah|hug|hugging|snuggle|missed you|miss you)\b|❤|❣|💕|💗|🥰|😍|<3|:3/g,
  apology: /\b(sorry|my bad|apologi[sz]e|forgive me|didn'?t mean)\b/g,
  tease: /\b(lol|lmao|haha|hehe|teasing|just kidding|kidding|gotcha|boop|:p|;p)\b/g,
  praise: /\b(thanks|thank you|thx|good job|nice|great|awesome|amazing|you'?re helpful|you helped|well done|good bot)\b/g,
};

const TONE_PRIORITY = ['unkind', 'affectionate', 'apology', 'tease', 'praise'];

// Read the user's message and register the tone. Level 1 = one signal,
// level 2 = several in one message. Emotion nudge lands immediately; the
// style note goes out with the same request so she reacts in character.
function noteUserTone(text, source = 'user') {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return snapshot();

  let kind = null;
  let count = 0;
  for (const k of TONE_PRIORITY) {
    const re = new RegExp(TONE_WORDS[k].source, 'g'); // fresh lastIndex
    const hits = t.match(re);
    if (hits && hits.length > count) {
      kind = k;
      count = hits.length;
      break; // priority order beats count on ties
    }
  }
  if (!kind) return snapshot();

  const level = Math.min(2, count);
  const before = { v: state.v, a: state.a, family: state.family };
  state.tone = { kind, level };
  state.lastAt = Date.now();

  // Dimension nudges: small, per level; cruelty hurts more than praise soothes.
  const nudge = {
    unkind:       { dv: -0.15, da: +0.06 },
    affectionate: { dv: +0.10, da: +0.05 },
    apology:      { dv: +0.06, da: -0.04 },
    tease:        { dv: +0.03, da: +0.08 },
    praise:       { dv: +0.08, da: +0.05 },
  }[kind];
  state.v = clampJ(state.v + nudge.dv * level);
  state.a = clamp01(state.a + nudge.da * level);
  state.s = clamp01(state.s + (kind === 'tease' || kind === 'affectionate' ? 0.05 * level : -0.05 * level));

  log.info('[affect]', `${source} tone ${kind} x${count}: `
    + `v ${r2(before.v)}→${r2(state.v)} a ${r2(before.a)}→${r2(state.a)}`);
  return snapshot();
}

// System-prompt line for the detected tone (empty when calm/neutral).
function toneNote() {
  if (!state.tone.kind || state.tone.level <= 0) return '';
  const lines = {
    unkind: [
      'Right now, in character: the user just said something unkind. Kanna gets hurt — maybe quiet-sad or indignant (mood "sad" or "strained"), never cruel back. Just a short honest callout, then she looks away.',
      'Right now, in character: the user keeps being mean to her. Kanna is properly stung — sad, a little teary, maybe calls it out with a shaky voice (mood "sad" + speed slower). She stays kind, but she shows it hurts.',
    ],
    affectionate: [
      'Right now, in character: the user just said something sweet. Kanna gets flustered but secretly delighted — shy smile, warm reply (mood "shy" or "happy").',
      'Right now, in character: the user is being very affectionate. Kanna melts — properly flustered, beam through the shyness (mood "happy" or "shy"), maybe hugs back.',
    ],
    apology: [
      'Right now, in character: the user just apologized. Kanna forgives quickly and warms up (mood "happy", gentle speed) — maybe a small "it\'s okay".',
      'Right now, in character: the user is clearly sorry about something. Kanna softens fully, reassures them (mood "happy", slow gentle tempo).',
    ],
    tease: [
      'Right now, in character: the user is teasing her. Kanna puffs her cheeks and pouts (mood "strained" or "shy") — playful, not actually upset, she gives as good as she gets.',
      'Right now, in character: the user is really enjoying teasing her. Kanna is properly flustered and mock-annoyed (mood "strained", faster speed) — witty comeback territory.',
    ],
    praise: [
      'Right now, in character: the user just praised/thanked her. Kanna beams, a little proud (mood "happy") — accept it warmly, stay humble.',
      'Right now, in character: the user is really complimenting her. Kanna is overjoyed (mood "happy", faster happy tempo) — feels appreciated.',
    ],
  };
  const arr = lines[state.tone.kind] || [];
  return arr[Math.min(arr.length - 1, state.tone.level - 1)] || '';
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
  const tone = state.tone.kind ? ` tone=${state.tone.kind}x${state.tone.level}` : '';
  return `${state.family}${state.held ? ' (held)' : ''}${state.annoyed ? ` annoyed=${state.annoyed}` : ''}${tone} `
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
    tone: { ...state.tone },
    describe: describe(),
  };
}

// Debug/mood-reset hook (Settings panel comes later).
function reset() {
  state.family = 'neutral';
  state.held = false;
  state.turnsSinceHeld = 0;
  state.annoyed = 0;
  state.tone = { kind: null, level: 0 };
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
  noteRepeat,
  noteUserTone,
  styleNote,
  onInterrupt,
  endTurn,
  tick,
  describe,
  snapshot,
  reset,
};
