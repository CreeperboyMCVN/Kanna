'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const sprite = $('#sprite');
  const turnEl = $('#turn');
  const priorEl = $('#turn-prior');
  const mainEl = $('#turn-main');
  const tapEl = $('#turn-tap');
  const composerEl = $('#composer');
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
  let text = '';              // accumulated reply text / her latest reply
  let lastUserMsg = '';       // your latest message (feeds the small top line)
  let composerOpen = true;    // composer row visible at the bottom of the box
  let moodTimer = null;
  let toastTimer = null;
  let pinned = true;          // auto-scroll while the reader is at the bottom

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

  // TTS (built-in speechSynthesis for now; provider selectable in settings).
  let tts = { provider: 'builtin', voice: '', rate: 1, pitch: 1, muted: false };
  let shouldSpeak = false;   // set per turn; finalize() speaks only if true
  let spokenIndex = 0;       // how much of `text` has already been queued for speech

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

  // --- TTS (built-in speechSynthesis) ---------------------------------------

  function cancelSpeech() {
    try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch { /* ignore */ }
  }

  function updateMuteButton() {
    const btn = document.getElementById('btn-mute');
    if (!btn) return;
    const muted = !!tts?.muted;
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = muted ? 'Unmute TTS' : 'Mute TTS';
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  function speakChunk(text) {
    if (!text || tts?.muted) return;
    if (!tts || tts.provider !== 'builtin') return; // other providers: TODO
    if (typeof speechSynthesis === 'undefined') return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const chosen = voices.find((v) => v.name === tts.voice);
    if (chosen) u.voice = chosen;
    const rate = Number(tts.rate);
    const pitch = Number(tts.pitch);
    u.rate = Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;
    u.pitch = Number.isFinite(pitch) ? Math.min(2, Math.max(0.5, pitch)) : 1;
    // mood-based pitch nudge
    const moodPitch = { happy: 1.1, sad: 0.85, angry: 0.95, surprise: 1.05, shy: 0.9, strained: 0.9 };
    if (moodPitch[liveMood]) u.pitch = Math.min(2, Math.max(0.5, u.pitch * moodPitch[liveMood]));
    try { speechSynthesis.speak(u); } catch { /* ignore */ }
  }

  function textForSpeech(md) {
    let s = String(md || '').replace(/```[\s\S]*?```/g, ' code block. ');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/`([^`]+)`/g, '$1');
    return s.trim();
  }

  function maybeSpeak() {
    if (!shouldSpeak || tts?.muted || tts?.provider !== 'builtin') return;
    if (typeof speechSynthesis === 'undefined') return;
    const full = textForSpeech(text);
    if (full.length <= spokenIndex) return;
    const rest = full.slice(spokenIndex);
    const m = rest.match(/[\s\S]*[.!?](?:\s|$)/);
    let chunk = '';
    if (m) {
      chunk = m[0];
    } else if (rest.length > 90) {
      const sp = rest.lastIndexOf(' ');
      chunk = sp > 40 ? rest.slice(0, sp + 1) : '';
    }
    if (!chunk) return;
    spokenIndex += chunk.length;
    const u = new SpeechSynthesisUtterance(chunk.trim());
    const voices = speechSynthesis.getVoices();
    const chosen = voices.find((v) => v.name === tts.voice);
    if (chosen) u.voice = chosen;
    const rate = Number(tts.rate);
    const pitch = Number(tts.pitch);
    u.rate = Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;
    u.pitch = Number.isFinite(pitch) ? Math.min(2, Math.max(0.5, pitch)) : 1;
    const moodPitch = { happy: 1.1, sad: 0.85, angry: 0.95, surprise: 1.05, shy: 0.9, strained: 0.9 };
    if (moodPitch[liveMood]) u.pitch = Math.min(2, Math.max(0.5, u.pitch * moodPitch[liveMood]));
    try { speechSynthesis.speak(u); } catch { /* ignore */ }
  }

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

    tts = (settings && settings.tts) ? settings.tts : tts;
    updateMuteButton();

    updateWelcome(mainEl); // guarded inside: only lands while the box is fresh
  }
  // First message flavor: fresh install → intro/setup nudge; memory → personal
  // welcome back (by name when she knows it); plain config → generic welcome.
  // The token guard keeps overlapping refreshes from stomping each other.
  let welcomeToken = 0;
  async function updateWelcome(el) {
    if (history.length || text) return; // the box belongs to the conversation now
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

    if (token !== welcomeToken || history.length) return; // a newer refresh / the conversation already took over

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

  function makeDots() {
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
    return dots;
  }

  function scrollToBottom(force) {
    if (force || pinned) mainEl.scrollTop = mainEl.scrollHeight;
  }

  mainEl.addEventListener('scroll', () => {
    pinned = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 48;
  });

  // The composer lives inside the turn box, and the very bottom of the box is
  // a hit strip: clicking it opens the composer — or interrupts her while
  // she's replying.
  tapEl.addEventListener('click', () => {
    if (busy) { cancelSpeech(); shouldSpeak = false; window.kanna.stopChat(); return; }
    if (composerOpen) return;
    openCompose();
    inputEl.focus();
  });

  // Composing view: her last reply pushes into the small top line (what
  // you're answering to) and your last message takes the big spot back.
  function openCompose() {
    if (text.trim()) {
      renderMarkdownInto(priorEl, text);
      renderMarkdownInto(mainEl, lastUserMsg);
      scrollToBottom();
    }
    composerOpen = true;
    composerEl.classList.add('open');
    turnEl.classList.add('composing');
  }

  // Escape out of composing: restore the reading view — her reply big, your
  // message small on top.
  function closeCompose() {
    composerOpen = false;
    composerEl.classList.remove('open');
    turnEl.classList.remove('composing');
    if (text.trim()) {
      renderMarkdownInto(mainEl, text);
      renderMarkdownInto(priorEl, lastUserMsg);
      scrollToBottom();
    }
  }

  // Fresh session: start with the composer open so the first word needs no
  // tap hunt (once she replies, it closes and the tap strip takes over).
  composerOpen = true;
  composerEl.classList.add('open');
  turnEl.classList.add('composing');

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

    cancelSpeech();
    shouldSpeak = false;
    spokenIndex = 0;

    // Sending always closes the composer — the box becomes the stage for her
    // reply, your words shrink to the small top line.
    composerOpen = false;
    composerEl.classList.remove('open');
    turnEl.classList.remove('composing');

    lastUserMsg = content;
    history.push({ role: 'user', content });
    renderMarkdownInto(priorEl, content);

    // Typing dots at the big spot until the first tokens arrive.
    text = '';
    mainEl.classList.remove('error');
    mainEl.classList.add('typing');
    mainEl.replaceChildren(makeDots());
    scrollToBottom(true);

    busy = true;

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
        shouldSpeak = true;
        // Still typing out the backlog — finalize once the queue drains.
        finishing = true;
        if (!drainTimer) drainTimer = requestAnimationFrame(pace);
      } else if (result.stopped) {
        mainEl.classList.remove('typing');
        mainEl.textContent = '…';
        finalize();
      } else {
        mainEl.classList.remove('typing');
        mainEl.replaceChildren(); // no content and not stopped — leave it empty
        finalize();
      }
    } catch (err) {
      pending = '';
      mainEl.classList.remove('typing');
      mainEl.textContent = `⚠ ${pickErrorMessage(err)}`;
      mainEl.classList.add('error');
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
    if (!busy) return;
    received += chunk;
    pending += chunk;
    if (!drainTimer) drainTimer = requestAnimationFrame(pace);
  });

  // The model's directions for this reply. Mood is the first key of the JSON
  // reply, so it lands before any words: she sets her face while still
  // thinking, then speaks in that emotion. A mid-reply mood swap goes live.
  window.kanna.onMeta((meta) => {
    if (!busy) return;
    if (meta.mood) {
      liveMood = MOOD_ALIASES[meta.mood] || (EMOTES.includes(meta.mood) ? meta.mood : 'neutral');
      if (mainEl.classList.contains('typing')) setEmote(liveMood, false); // pre-speech face
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
      let cps;
      const ttsActive = shouldSpeak && !tts?.muted && tts?.provider === 'builtin';
      if (ttsActive) {
        // Pace the text to the speech rate (~14 chars/sec at rate 1) so the
        // typewriter doesn't outrun the voice on fast models.
        const speechCps = Math.round(14 * (Number(tts.rate) || 1));
        cps = Math.min(20, Math.max(4, speechCps));
        // If typed text is running ahead of what's been spoken, slow down
        // so speech can catch up.
        const backlog = text.length - spokenIndex;
        if (backlog > 40) cps = Math.min(cps, 3);
        if (backlog > 80) cps = Math.min(cps, 2);
      } else {
        cps = Math.min(CATCHUP_MAX, Math.max(TYPE_CPS * liveSpeed, pending.length));
      }
      const take = Math.max(1, Math.round(dt * cps));
      const slice = pending.slice(0, take);
      pending = pending.slice(take);

      if (mainEl.classList.contains('typing')) {
        mainEl.classList.remove('typing');
        mainEl.replaceChildren();
        setEmote(liveMood, true); // now she speaks, in the mood she picked
      }
      text += slice;
      renderMarkdownInto(mainEl, text);
      scrollToBottom();
      maybeSpeak();
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
    if (moodOverride) moodFlash(moodOverride, false);
    else if (text) moodFlash(liveMood !== 'neutral' ? liveMood : pickEmotion(text), liveHold);
    else setEmote('neutral', false);
    scrollToBottom();
    if (shouldSpeak && text && !tts?.muted && tts?.provider === 'builtin') {
      maybeSpeak();
      const full = textForSpeech(text);
      const rest = full.slice(spokenIndex).trim();
      if (rest) {
        spokenIndex = full.length;
        speakChunk(rest);
      }
    }
    shouldSpeak = false;
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

  // Mute TTS toggle (header) — persists via settings.
  const muteBtn = document.getElementById('btn-mute');
  if (muteBtn) {
    muteBtn.addEventListener('click', async () => {
      const next = !(tts?.muted);
      tts = { ...tts, muted: next };
      updateMuteButton();
      try {
        const saved = await window.kanna.saveSettings({ tts: { ...tts, muted: next } });
        if (saved?.tts) tts = saved.tts;
        settings = await window.kanna.getSettings();
        updateMuteButton();
        window.dispatchEvent(new CustomEvent('kanna:settings-changed'));
      } catch { /* ignore */ }
      if (next) cancelSpeech();
    });
  }

  // --- history tab ---------------------------------------------------------------

  const historyDrawer = $('#history-drawer');
  const historyList = $('#history-list');

  function openHistory() {
    historyList.textContent = '';
    if (!history.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = 'Nothing yet — turns you exchange stack up here (for this session).';
      historyList.append(empty);
    } else {
      for (const m of history) {
        const line = document.createElement('div');
        line.className = `history-turn ${m.role}`;

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = m.role === 'user' ? 'You' : 'Kanna';

        const body = document.createElement('div');
        body.className = 'what';
        renderMarkdownInto(body, m.content || '');

        line.append(who, body);
        historyList.append(line);
      }
      historyList.scrollTop = historyList.scrollHeight;
    }
    historyDrawer.classList.add('open');
    $('#scrim').classList.remove('hidden');
  }

  function closeHistory() {
    historyDrawer.classList.remove('open');
    // Shared scrim: only dim it out when the settings drawer isn't the one open.
    if (!$('#drawer').classList.contains('open')) $('#scrim').classList.add('hidden');
  }

  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-history-close').addEventListener('click', closeHistory);
  $('#scrim').addEventListener('click', () => {
    if (historyDrawer.classList.contains('open')) closeHistory();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (historyDrawer.classList.contains('open')) closeHistory();
      else if (composerOpen) closeCompose();
    }
  });

  window.addEventListener('kanna:settings-changed', refreshSettings);
  window.addEventListener('kanna:toast', (e) => toast(e.detail || ''));

  refreshSettings();
})();
