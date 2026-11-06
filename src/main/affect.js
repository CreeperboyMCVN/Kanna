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
  teasing:  { v: +0.35, a: 0.60, s: 0.70 },
  shy:      { v: +0.2, a: 0.45, s: 0.30 },
  neutral:  { v:  0.0, a: 0.35, s: 0.40 },
  bored:    { v: -0.15, a: 0.20, s: 0.30 },
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
  content: 'neutral', quiet: 'neutral', curious: 'neutral',
  spacey: 'dizzy', woozy: 'dizzy', dazed: 'dizzy', confused: 'dizzy',
  sleepyhead: 'dizzy',
  teasing: 'teasing', teasingly: 'teasing', tease: 'teasing',
  smirk: 'teasing', smirking: 'teasing', smug: 'teasing',
  mischievous: 'teasing', cheeky: 'teasing', sly: 'teasing',
  bored: 'bored', meh: 'bored', unimpressed: 'bored', listless: 'bored',
  yawn: 'bored', yawning: 'bored', drowsy: 'bored', sleepy: 'bored',
  tired: 'strained', exhausted: 'strained',
  anxious: 'strained', worried: 'strained', stress: 'strained',
  stressed: 'strained', uneasy: 'strained', pout: 'strained',
  determined: 'strained',
  disappointed: 'sad', lonely: 'sad', gloomy: 'sad', down: 'sad',
  melancholy: 'sad', hurt: 'sad', apologetic: 'sad', sorry: 'sad',
  angry: 'angry', mad: 'angry', annoyed: 'angry', irritated: 'angry',
  indignant: 'angry', frustrated: 'angry', upset: 'angry', scolding: 'angry',
  furious: 'angry', raging: 'angry', fuming: 'angry', cross: 'angry',
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const clampJ = (x) => Math.min(1, Math.max(-1, x));

// Phase 2 trigger #1 — annoying chat behavior. Two spam flavors share the
// same irritation pool (0 calm … 3 fed up):
//   • repeat — the same content again and again (variants included), and
//   • flood — a pile of unanswered user messages arriving back to back.
// noteRepeat()/noteFlood() feed the emotion, styleNote() turns it into an
// in-character instruction the model receives in its system prompt.
const state = {
  family: 'neutral',
  held: false,
  v: 0,     // valence
  a: 0.35,  // arousal
  s: 0.40,  // social energy
  lastAt: Date.now(),
  turnsSinceHeld: 0,
  annoyed: 0,  // 0 calm … 3 fed up (spam level, see noteSpam)
  spamKind: null, // 'repeat' | 'flood' — which flavor holds the irritation
  tone: { kind: null, level: 0 }, // last emotional tone read from the user
  modelIntensity: null, // optional "intensity" 0..1 the model itself reports
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
// Irritation (spam) and leftover user tone cool here: one level per turn.
function beginTurn() {
  tick();
  if (state.annoyed > 0) {
    state.annoyed--;
    if (state.annoyed === 0) {
      state.spamKind = null;
      log.info('[affect]', 'irritation cooled — user stopped spamming');
    }
  }
  if (state.tone.level > 0) {
    state.tone.level--;
    if (state.tone.level === 0) state.tone.kind = null;
  }
}

// Irritation can only climb to a higher target and the kind must be fresh:
// refreshes at the same level don't double-dip the dims.
function noteSpam(kind, level) {
  if (level <= 0) return snapshot();
  const prev = state.annoyed;
  if (level < prev) return snapshot(); // existing stronger reaction stands
  const same = level === prev && state.spamKind === kind;
  if (same) return snapshot();
  return raiseIrritation(kind, level);
}

// Move her once to `level` on the shared irritation pool (0 calm … 3 fed up).
function raiseIrritation(kind, level) {
  const bump = level - state.annoyed;
  const before = { v: state.v, a: state.a };
  state.spamKind = kind;
  state.annoyed = level;
  // Irritation: heavier with each extra bump, capped so she sulks, never rages.
  state.v = clampJ(state.v - 0.12 * bump);
  state.a = clamp01(state.a + 0.08 * bump);
  state.lastAt = Date.now();
  log.info('[affect]', `${kind} irritation level ${state.annoyed}: `
    + `v ${r2(before.v)}→${r2(state.v)} a ${r2(before.a)}→${r2(state.a)}`);
  return snapshot();
}

// n = consecutive (fuzzy) repeats of the user's same message (3+ = spamming).
function noteRepeat(n) {
  if (!Number.isFinite(n) || n < 3) return snapshot();
  return noteSpam('repeat', Math.min(3, n - 2)); // 3 repeats → 1 … 6+ → 3 (capped)
}

// n = unanswered user messages stacked up with no reply in between.
function noteFlood(n) {
  if (!Number.isFinite(n) || n < 3) return snapshot();
  return noteSpam('flood', n < 5 ? 1 : 2); // crowded → flustered; 5+ → exasperated
}

// Shaking is physical provocation, not chat spam — but it feeds the same
// irritation pool, so the grudge from rattling *persists across turns*
// (cooling one level per quiet turn like every other annoyance) instead of
// evaporating with the angry reply. Each burst bumps the level by how
// violent the burst was; heavier bursts climb faster.
function noteShake(count) {
  const n = Math.max(1, Math.min(24, Number(count) || 1));
  const bump = n > 9 ? 3 : n > 3 ? 2 : 1;
  return raiseIrritation('shaken', Math.min(3, state.annoyed + bump));
}

// Full style note for the system prompt: spam irritation (either flavor)
// and/or the user's emotional tone, joined. Only present when something is
// actually happening, so normal chat sends the exact same prompt as before.
function styleNote() {
  const notes = [];
  if (state.annoyed > 0) {
    const repeatLines = {
      1: 'Right now, in character: the user has repeated the same message three times — Kanna is getting visibly annoyed. Keep replying as her, call it out plainly or with a strained sigh (mood "strained"). Do not repeat yourself either.',
      2: 'Right now, in character: the user keeps hammering the same message — Kanna is fed up with it. React like a real person would: flustered, exasperated, maybe a little scolding (mood "strained" or "angry", speed higher). Stay Kanna, stay kind underneath.',
      3: 'Right now, in character: the user has now spammed the same message six or more times — Kanna has had ENOUGH. She says so sharply (mood "angry", speed 1.5+), maybe pouts or threatens to ignore further repeats. Still in character, still caring underneath.',
    };
    const floodLines = {
      1: 'Right now, in character: the user rapid-fired several messages without letting you answer. Kanna gets flustered and a bit overwhelmed (mood "strained") — she half-jokes about them sending everything at once ("one at a time!" energy).',
      2: 'Right now, in character: the user keeps firing message after message with no pause — Kanna is genuinely overwhelmed and a bit exasperated (mood "strained" or "angry", speed up). She tells them to stop flooding her and let her breathe.',
    };
    const shakenLines = {
      1: 'Right now, in character: the user grabbed Kanna\'s window and rattled her around — and she hasn\'t forgotten it. She is wobbly and cross (mood "dizzy" or "strained"); a grudge simmering under the surface.',
      2: 'Right now, in character: the user has been shaking Kanna around again — and she is FED UP. Stay properly irritated (mood "angry" or "strained") — squeam or snapping back, but playful jokes land badly.',
      3: 'Right now, in character: the user has been treating her like a rattle toy and she is at the ENOUGH of it: not playful at all (mood "angry", speed high) — she snaps first and asks questions later. No pouting-cute routine.',
    };
    const linesByKind = { repeat: repeatLines, flood: floodLines, shaken: shakenLines };
    const lines = linesByKind[state.spamKind] || repeatLines;
    const l = lines[Math.min(state.annoyed, Object.keys(lines).length)];
    if (l) notes.push(l);
  }
  const tone = toneNote();
  if (tone) notes.push(tone);
  return notes.join(' ');
}

// One-line continuity statement for the system prompt: what she is still
// feeling from previous turns (family/spam), so the model evolves moods
// across the chat history instead of resetting every message.
function moodCarry() {
  const bits = [];
  if (state.held) bits.push(`${state.family} (held from before)`);
  else if (state.family !== 'neutral') bits.push(`${state.family} left over from the last turn`);
  if (state.annoyed > 0) {
    const why = state.spamKind === 'flood' ? 'by message flooding'
      : state.spamKind === 'shaken' ? 'from being shaken around earlier'
      : 'by the repeated message';
    bits.push(`irritated ${why} (level ${state.annoyed}/3)`);
  }
  if (!bits.length) return 'calm and neutral';
  return bits.join('; ');
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

  // She can't be talked out of a grudge with a joke: when she's already fed
  // up with the user, teasing doesn't flip her into playful pouting — it
  // reads as escalating. Hurt stays, the tease note says she stays angry.
  const fedUp = state.annoyed >= 2 || state.family === 'angry';

  // Dimension nudges: small, per level; cruelty hurts more than praise soothes.
  const nudge = ({
    unkind:       { dv: -0.15, da: +0.06 },
    affectionate: { dv: +0.10, da: +0.05 },
    apology:      { dv: +0.02, da: -0.02 },
    tease:        { dv: +0.03, da: +0.08 },
    praise:       { dv: +0.08, da: +0.05 },
  })[kind];
  if (kind === 'tease' && fedUp) { nudge.dv = -0.05; nudge.da = +0.05; }
  state.v = clampJ(state.v + nudge.dv * level);
  state.a = clamp01(state.a + nudge.da * level);
  state.s = clamp01(state.s + (kind === 'tease' || kind === 'affectionate' ? 0.05 * level : -0.05 * level));

  // An honest "sorry" earns trust back at one grudge level per apology TURN,
  // never in one message: she needs to see it kept, not just said.
  let forgive = '';
  if (kind === 'apology' && state.annoyed > 0) {
    const had = state.annoyed;
    state.annoyed = Math.max(0, had - 1);
    forgive = ` (grudge eases ${had}→${state.annoyed})`;
    if (state.annoyed === 0) state.spamKind = null;
  }

  log.info('[affect]', `${source} tone ${kind} x${count}${kind === 'tease' && fedUp ? ' (she stays angry — joke does not land)' : ''}${forgive}: `
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
      'Right now, in character: the user just apologized. Kanna does NOT melt instantly — she gives a guarded half-forgiveness: looking away, small pout, a short "…I guess" (mood "strained" or "shy", slow speed). She softens slowly and needs the good treatment to keep up.',
      'Right now, in character: the user is clearly sorry and has kept apologizing. Kanna gives in properly — a shy, bashful sparkle returning (mood "shy" or "happy", gentle slow tempo) — but she keeps a tiny guilt-trip: "that really hurt, you know".',
    ],
    tease: [
      'Right now, in character: the user is teasing her. Kanna puffs her cheeks and pouts, but she plays along (mood "teasing" or "shy") — not actually upset, she gives as good as she gets.',
      'Right now, in character: the user is really enjoying teasing her. Kanna is properly flustered and mock-annoyed (mood "teasing" or "strained", faster speed) — witty comeback territory.',
    ],
    // Fed-up override — see noteUserTone: a grudge can't be joked away.
    teaseFedUp: [
      'Right now, in character: the user is teasing her, but Kanna is already fed up with them and the joke does NOT land — it reads as twisting the knife. She stays sore and pushes back (mood "angry" or "strained"), maybe snaps a short comeback; no cheeky pouting.',
      'Right now, in character: the user keeps teasing her while she is deliberately irritated with them. Kanna does NOT soften into playing along — her anger holds (mood "angry" or "strained"), she bites back properly.',
    ],
    praise: [
      'Right now, in character: the user just praised/thanked her. Kanna beams, a little proud (mood "happy") — accept it warmly, stay humble.',
      'Right now, in character: the user is really complimenting her. Kanna is overjoyed (mood "happy", faster happy tempo) — feels appreciated.',
    ],
  };
  const arr = lines[state.tone.kind] || [];
  if (state.tone.kind === 'tease' && (state.annoyed >= 2 || state.family === 'angry')) {
    return lines.teaseFedUp[Math.min(lines.teaseFedUp.length - 1, state.tone.level - 1)] || '';
  }
  // Deep grudges take more than words: even repeated sorries only earn the
  // guarded tone until the irritation pool has actually cooled.
  if (state.tone.kind === 'apology' && state.annoyed >= 2) {
    return lines.apology[0] || '';
  }
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

  // Optional model-written intensity (Phase 3 protocol field). Kept even
  // when only reported softly: a model that follows it can drive her face
  // harder than the blended dims (see snapshot). Nothing required from it.
  if (typeof meta?.intensity === 'number' && meta.intensity >= 0 && meta.intensity <= 1) {
    state.modelIntensity = r2(meta.intensity);
  }

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
    intensity: state.modelIntensity != null
      ? state.modelIntensity
      : r2(clamp01(Math.abs(state.v) * 0.5 + Math.max(0, state.a) * 0.5)),
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
  state.spamKind = null;
  state.tone = { kind: null, level: 0 };
  state.modelIntensity = null;
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
  noteFlood,
  noteUserTone,
  noteShake,
  styleNote,
  moodCarry,
  onInterrupt,
  endTurn,
  tick,
  describe,
  snapshot,
  reset,
};
