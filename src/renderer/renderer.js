'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const sprite = $('#sprite');
  const messagesEl = $('#messages');
  const inputEl = $('#input');
  const sendBtn = $('#send');
  const statusEl = $('#status');
  const toastEl = $('#toast');

  const EMOTES = ['angry', 'dizzy', 'happy', 'neutral', 'sad', 'shy', 'strained', 'surprise'];

  // Crisp icons for the send/stop button (innerHTML, since textContent swaps would clash).
  const SEND_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  const STOP_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';

  // Naive mood detection so Kanna reacts to the vibe of her own replies.
  const MOOD_RULES = [
    { emotion: 'happy',    re: /\b(haha|lol|lmao|yay|awesome|great|nice|love|happy|wonderful|congrats)\b|😂|🤣|😊|😄/i },
    { emotion: 'sad',      re: /\b(sorry|sad|unfortunately|lonely|tired|miss you)\b|😢|😭/i },
    { emotion: 'angry',    re: /\b(angry|mad|furious|hate|annoyed)\b|😠|😤/i },
    { emotion: 'surprise', re: /\b(wow|whoa|surprised|shocking|unbelievable)\b|😲|😱/i },
    { emotion: 'shy',      re: /\b(blush|shy|embarrassed|flattered)\b|😳/i },
  ];

  // Loose mood words models come up with → the 8 available emotes; anything
  // unknown stays neutral.
  const MOOD_ALIASES = {
    joy: 'happy', joyful: 'happy', excited: 'happy', cheerful: 'happy', glad: 'happy',
    love: 'happy', loving: 'happy', proud: 'happy', smile: 'happy', giggling: 'happy',
    cry: 'sad', crying: 'sad', lonely: 'sad', gloomy: 'sad', worried: 'sad', hurt: 'sad',
    mad: 'angry', annoyed: 'angry', furious: 'angry', grumpy: 'angry', frustrated: 'angry',
    blush: 'shy', blushing: 'shy', embarrassed: 'shy', bashful: 'shy', flustered: 'shy',
    shocked: 'surprise', shock: 'surprise', amazed: 'surprise', astonished: 'surprise',
    confused: 'dizzy', sleepy: 'strained', exhausted: 'strained', tired: 'strained', pain: 'strained',
  };

  let settings = null;
  let history = [];           // { role: 'user' | 'assistant', content }
  let busy = false;
  let bubble = null;          // assistant bubble being streamed into
  let text = '';              // accumulated reply text
  let moodTimer = null;
  let toastTimer = null;
  let pinned = true;          // auto-scroll while the user is at the bottom

  // Streaming smoothing: network chunks land in `pending` and get typed out
  // a few characters per frame in `pace()`. The slice size scales with the
  // backlog, so slow replies stay natural and fast bursts catch up quickly
  // without text ever appearing all-at-once.
  let received = '';          // full text as delivered by the network
  let pending = '';           // text queued for display
  let drainTimer = null;      // requestAnimationFrame handle of the pacing loop
  let finishing = false;      // network done — drain the queue, then finalize

  // Per-reply directions from the model ('chat:meta'): which face to wear
  // and how fast to read the text. Defaults keep the keyword fallback alive
  // for models that ignore the JSON reply protocol.
  let liveMood = 'neutral';
  let liveSpeed = 1;
  let liveHold = null;       // model said whether this mood should stick
  let holdFace = false;      // true while a held mood is on her face

  // Warm the image cache so emote swaps never flicker.
  for (const emotion of EMOTES) {
    for (const speak of ['', '-speak']) {
      new Image().src = `../../assets/emotes/${emotion}${speak}.png`;
    }
  }

  // --- emote --------------------------------------------------------------

  function setEmote(emotion, speaking) {
    const src = `../../assets/emotes/${emotion}${speaking ? '-speak' : ''}.png`;
    if (sprite.getAttribute('src') !== src) sprite.src = src;
    sprite.classList.toggle('speaking', !!speaking);
  }

  // While the model is thinking there are no words yet — stay idle; the
  // speaking variant kicks in only once real tokens start arriving.
  function setThinking() {
    clearTimeout(moodTimer);
    // A held mood carries into the next turn — she's still on that emotion
    // while thinking, until the new reply says otherwise.
    if (!holdFace) setEmote('neutral', false);
  }

  function moodFlash(emotion, hold) {
    holdFace = !!hold;
    setEmote(emotion, false);
    clearTimeout(moodTimer);
    if (hold) return; // stays until the next turn moves her
    moodTimer = setTimeout(() => setEmote('neutral', false), 6000);
  }

  function pickEmotion(reply) {
    for (const rule of MOOD_RULES) {
      if (rule.re.test(reply)) return rule.emotion;
    }
    return 'neutral';
  }

  // --- markdown in bubbles ---------------------------------------------------
  // Replies render as lightweight markdown: **bold**, *italic*, `inline code`.
  // Fenced code blocks are deliberately NOT written into the bubble — the
  // model is treated as writing them into a (future) editor, so the bubble
  // shows a chip with a live line count instead (see TODO.md). Model output is
  // never parsed as HTML: everything goes in as text nodes.

  function renderMarkdownInto(el, md) {
    el.replaceChildren(buildMarkdown(md));
  }

  // Splits text into prose and fenced-block parts. A fence that is still
  // streaming (no closing ```) is surfaced with closed:false so the chip can
  // show a "writing…" state.
  function splitCode(md) {
    const parts = [];
    const re = /```([^\n`]*)\n?([\s\S]*?)(?:(```)|$)/g;
    let last = 0, m;
    while ((m = re.exec(md))) {
      if (m.index > last) parts.push({ fenced: false, text: md.slice(last, m.index) });
      if ((m[2] || '').trim()) {
        parts.push({ fenced: true, lang: m[1].trim(), code: m[2], closed: !!m[3] });
      }
      last = re.lastIndex;
    }
    if (last < md.length) parts.push({ fenced: false, text: md.slice(last) });
    return parts;
  }

  function buildMarkdown(md) {
    const frag = document.createDocumentFragment();
    for (const part of splitCode(md)) {
      if (part.fenced) frag.append(buildCodeChip(part));
      else frag.append(buildInline(part.text));
    }
    return frag;
  }

  function buildCodeChip(part) {
    const lines = part.code.replace(/\n+$/, '').split('\n').length;
    const chip = document.createElement('span');
    chip.className = 'code-chip';
    chip.textContent = part.closed
      ? `⌘ ${part.lang ? part.lang + ' · ' : ''}${lines} lines — written to editor`
      : `⌘ ${part.lang ? part.lang + ' · ' : ''}${lines} lines — writing…`;
    chip.title = 'Code stays out of the chat — she keeps it for your editor (coming soon, see TODO.md)';
    return chip;
  }

  // Inline pass: swaps **bold**, *italic* and `code` for elements; everything
  // else (including newlines and lists) stays plain text and relies on the
  // bubble's pre-wrap.
  function buildInline(text) {
    const frag = document.createDocumentFragment();
    const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) {
        const b = document.createElement('strong');
        b.textContent = tok.slice(2, -2);
        frag.append(b);
      } else if (tok.endsWith('`')) {
        const c = document.createElement('code');
        c.textContent = tok.slice(1, -1);
        frag.append(c);
      } else {
        const e = document.createElement('em');
        e.textContent = tok.slice(1, -1);
        frag.append(e);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  // --- configuration state --------------------------------------------------

  function isConfigured(s) {
    if (!s) return false;
    if (s.provider === 'custom') return !!s.custom?.model && !!s.custom?.baseUrl;
    return !!s[s.provider]?.apiKey;
  }

  async function refreshSettings() {
    settings = await window.kanna.getSettings();
    const ok = isConfigured(settings);
    statusEl.classList.toggle('ok', ok);
    statusEl.classList.toggle('warn', !ok);
    statusEl.title = ok
      ? `Ready — provider: ${settings.provider}`
      : 'Not configured — add an API key in Settings';

    const welcome = document.getElementById('welcome');
    if (welcome && welcome.isConnected) updateWelcome(welcome);
  }

  // First message flavor: fresh install → intro/setup nudge; memory → personal
  // welcome back (by name when she knows it); plain config → generic welcome.
  // The token guard keeps overlapping refreshes from stomping each other.
  let welcomeToken = 0;
  async function updateWelcome(el) {
    const token = ++welcomeToken;

    if (!isConfigured(settings)) {
      el.textContent = 'Hi! I\'m Kanna 🦊 — a fox who lives on your desktop. Open ⚙ → Brain, add an API key, and I\'m yours.';
      return;
    }

    let entries = [];
    try {
      const data = await window.kanna.getMemory();
      entries = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
    } catch {
      // memory read failed — fall through to the generic welcome
    }

    if (token !== welcomeToken) return; // a newer refresh already took over

    const named = entries.find((e) => e.key === 'user.name' || e.key.endsWith('.name'));
    if (named?.value) {
      el.textContent = `Konkonn, ${named.value} — the desk's been quiet without you 🦊`;
      return;
    }
    if (entries.length) {
      el.textContent = `Welcome back! My little notebook holds ${entries.length} thing${entries.length === 1 ? '' : 's'} about you 🦊`;
      return;
    }
    el.textContent = 'Welcome back 🦊 What are we getting into today?';
  }

  // --- chat ----------------------------------------------------------------

  function addMsg(className, textContent) {
    const el = document.createElement('div');
    el.className = className;
    if (textContent !== undefined) el.textContent = textContent;
    messagesEl.append(el);
    scrollToBottom(true);
    return el;
  }

  function scrollToBottom(force) {
    if (force || pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  messagesEl.addEventListener('scroll', () => {
    pinned = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
  });

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 96)}px`;
  }

  async function send() {
    const content = inputEl.value.trim();
    if (!content || busy) return;

    if (!isConfigured(settings)) {
      toast('Set up a provider in Settings first');
      window.dispatchEvent(new CustomEvent('kanna:open-settings'));
      return;
    }

    inputEl.value = '';
    autoGrow();
    history.push({ role: 'user', content });
    addMsg('msg user', content);

    // Typing bubble that chunks stream into.
    bubble = addMsg('msg assistant typing');
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
    bubble.append(dots);

    busy = true;
    text = '';
    received = '';
    pending = '';
    finishing = false;
    liveMood = 'neutral';
    liveSpeed = 1;
    liveHold = null;
    sendBtn.innerHTML = STOP_ICON;
    sendBtn.classList.add('stop');
    sendBtn.title = 'Stop';
    setThinking();

    try {
      const result = await window.kanna.sendChat(history.slice(-24));
      if (received) {
        history.push({ role: 'assistant', content: received });
        // Still typing out the backlog — finalize once the queue drains.
        finishing = true;
        if (!drainTimer) drainTimer = requestAnimationFrame(pace);
      } else if (result.stopped) {
        bubble.classList.remove('typing');
        bubble.textContent = '…';
        finalize();
      } else {
        bubble.remove(); // no content and not stopped — drop the empty bubble
        finalize();
      }
    } catch (err) {
      pending = '';
      bubble.classList.remove('typing');
      bubble.textContent = `⚠ ${pickErrorMessage(err)}`;
      bubble.classList.add('error');
      // Something went wrong — she reacts to the glitch, not to whatever
      // mood the half-typed reply happened to carry.
      finalize('dizzy');
    }
  }

  function pickErrorMessage(err) {
    return (err?.message || 'Something went wrong. Try again.').replace(/^Error: /, '');
  }

  // — Typing feel. Tune ONLY these two numbers: —
  const TYPE_CPS = 5;        // characters per second at a comfortable pace
  const CATCHUP_MAX = 20;    // cps cap when a huge backlog arrives (fast models)
  // The effective speed is TYPE_CPS until the backlog grows, then it rises
  // (one backlog char ≈ one cps) so the queue never lags more than ~1–2s.

  let lastFrame = 0;          // timestamp of the previous paced frame

  window.kanna.onChunk((chunk) => {
    if (!busy || !bubble) return;
    received += chunk;
    pending += chunk;
    if (!drainTimer) drainTimer = requestAnimationFrame(pace);
  });

  // The model's directions for this reply. Mood is the first key of the JSON
  // reply, so it lands before any words: she sets her face while still
  // thinking, then speaks in that emotion. A mid-reply mood swap goes live.
  window.kanna.onMeta((meta) => {
    if (!busy || !bubble) return;
    if (meta.mood) {
      liveMood = MOOD_ALIASES[meta.mood] || (EMOTES.includes(meta.mood) ? meta.mood : 'neutral');
      if (bubble.classList.contains('typing')) setEmote(liveMood, false); // pre-speech face
      else if (text) setEmote(liveMood, true);                            // mid-speech swap
    }
    if (meta.speed) {
      const v = Number(meta.speed);
      if (Number.isFinite(v) && v > 0) liveSpeed = Math.min(2.2, Math.max(0.6, v));
    }
    if (meta.hold !== undefined) liveHold = !!meta.hold;
  });

  function pace(ts) {
    drainTimer = null;
    if (!busy) { lastFrame = 0; return; }

    if (pending.length) {
      const dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 0.05) : 1 / 60;
      lastFrame = ts;

      // The model's `speed` direction scales the base typing pace — her own
      // tune knob (TYPE_CPS / CATCHUP_MAX) stays in charge of the feel.
      const cps = Math.min(CATCHUP_MAX, Math.max(TYPE_CPS * liveSpeed, pending.length));
      const take = Math.max(1, Math.round(dt * cps));
      const slice = pending.slice(0, take);
      pending = pending.slice(take);

      if (bubble.classList.contains('typing')) {
        bubble.classList.remove('typing');
        bubble.textContent = '';
        setEmote(liveMood, true); // now she speaks, in the mood she picked
      }
      text += slice;
      renderMarkdownInto(bubble, text);
      scrollToBottom();
      drainTimer = requestAnimationFrame(pace);
      return;
    }

    lastFrame = 0;
    if (finishing) finalize();
  }

  function finalize(moodOverride) {
    if (!busy) return;
    busy = false;
    drainTimer = null;
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.classList.remove('stop');
    sendBtn.title = 'Send (Enter)';
    bubble = null;
    if (moodOverride) moodFlash(moodOverride, false);
    else if (text) moodFlash(liveMood !== 'neutral' ? liveMood : pickEmotion(text), liveHold);
    else setEmote('neutral', false);
    scrollToBottom();
  }

  // --- small bits ----------------------------------------------------------

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  // --- wire up ---------------------------------------------------------------

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { window.kanna.stopChat(); return; }
    send();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  inputEl.addEventListener('input', autoGrow);

  // Borderless window buttons.
  $('#win-min').addEventListener('click', () => window.kanna.minimize());
  $('#win-close').addEventListener('click', () => window.kanna.close());

  window.addEventListener('kanna:settings-changed', refreshSettings);
  window.addEventListener('kanna:toast', (e) => toast(e.detail || ''));

  refreshSettings().then(() => {
    const welcome = addMsg('msg assistant');
    welcome.id = 'welcome';
    updateWelcome(welcome);
    inputEl.focus();
  });
})();
