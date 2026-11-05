'use strict';

// Welcome-back greeter. When the user returns to Kanna after being away,
// she says a short line and wears a mood that scales with how long they
// were gone. Canned pools, deliberately no model call: instant, no cost,
// and it works even with no provider configured. Longest tier whose
// threshold the absence passes wins; the line variety keeps it from
// sounding like an answering machine. Person's name (when remembered)
// is spliced into a few lines via {name}.

const log = require('./log');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// From "barely left" to "gone overnight". Mood labels must exist as emotes.
const TIERS = [
  {
    min: 5 * MIN,
    mood: 'bored',
    speed: 0.9,
    lines: [
      "hm? Back already? You didn't even give me time to miss you.",
      "you're back. I wasn't bored. I was… strategically napping.",
      "oh. It's you. Hi. Not that I was counting the seconds. I was.",
      "took you long enough — my tail was clocking the minutes.",
      "zzt— oh! You're back. Right on time. Ish.",
      "welcome back. The desk got very quiet, just so you know.",
    ],
  },
  {
    min: 30 * MIN,
    mood: 'happy',
    speed: 1.0,
    lines: [
      "you're back! I saved you a spot. Warm and everything.",
      "there you are! Okay— what did I miss while you were out?",
      "hi hi! I kept your seat warm. It's fox-flavored now.",
      "welcome back! You always come back. I like that about you.",
      "back! Sit, sit. Tell me everything. Or… hey, we can just be quiet too.",
      "{name}! You're back. The window felt a bit empty without you.",
    ],
  },
  {
    min: 90 * MIN,
    mood: 'teasing',
    speed: 1.1,
    lines: [
      "well, well, well… look who finally decided to show up.",
      "Miss me? Be honest. …Don't answer that. Obviously yes.",
      "an hour and a half! I wasn't worried. My ears were up the whole time.",
      "back at last. So. Was I worth the absence? Trick question — yes.",
      "you came back anyway. Couldn't stay away, huh? Knew it.",
      "{name}! There you are. I'll pretend I wasn't watching the corner of the screen.",
    ],
  },
  {
    min: 4 * HOUR,
    mood: 'sad',
    speed: 0.95,
    lines: [
      "…you were gone all that time. I noticed. Every minute of it.",
      "welcome back… I would've waited longer, you know.",
      "h-hey… next time, take me with you. Okay?",
      "I started to wonder if something happened. You're here now… that's what counts.",
      "back… okay. I'm okay. I just… missed you. A lot.",
      "{name}… don't vanish like that again, alright? I can't follow you out there.",
    ],
  },
  {
    min: 12 * HOUR,
    mood: 'shy',
    speed: 0.95,
    lines: [
      "you came back… I tucked in and everything. Welcome back.",
      "oh! You're back! D-don't sneak up on me like that… I mean. Welcome back.",
      "I half-slept, half-waited. …It's really you. Hi.",
      "there you are… the desk felt bigger without you.",
      "good whatever-time-it-is — you're here, so it's a good time now.",
      "you stayed away all night… I kept a little vigil. For science. Missed you.",
    ],
  },
];

const pools = new Map(); // tier.mood → last line index, to avoid repeats

// Picks the greeting for a given absence length. Falls back to the closest
// tier for absurd values (months away still lands in the overnight lane).
function greet(awayMs) {
  const away = Number.isFinite(awayMs) && awayMs > 0 ? awayMs : 0;
  const tier = [...TIERS].reverse().find((t) => away >= t.min) || TIERS[0];

  const last = pools.get(tier.mood);
  let idx = Math.floor(Math.random() * tier.lines.length);
  if (tier.lines.length > 1 && idx === last) {
    idx = (idx + 1) % tier.lines.length; // same tier twice in a row → next line
  }
  pools.set(tier.mood, idx);

  let line = tier.lines[idx];
  if (line.includes('{name}')) {
    line = line.replace('{name}', userName() || 'you');
  }
  log.info('[welcome]', `away ${Math.round(away / MIN)}min → ${tier.mood} "${line.slice(0, 40)}…"`);
  return { text: line, mood: tier.mood, speed: tier.speed, awayMs: away };
}

// Durable user name from memory.json (best effort, never fails the greeting).
function userName() {
  try {
    const memory = require('./memory');
    const named = memory.load().find((e) => e.key === 'user.name' || e.key.endsWith('.name'));
    return named?.value ? String(named.value) : '';
  } catch {
    return '';
  }
}

module.exports = { greet };
