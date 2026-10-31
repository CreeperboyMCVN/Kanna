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

  let settings = null;
  let history = [];           // { role: 'user' | 'assistant', content }
  let busy = false;
  let bubble = null;          // assistant bubble being streamed into
  let text = '';              // accumulated reply text
  let moodTimer = null;
  let toastTimer = null;
  let pinned = true;          // auto-scroll while the user is at the bottom

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
    setEmote('neutral', false);
  }

  function moodFlash(emotion) {
    setEmote(emotion, false);
    clearTimeout(moodTimer);
    moodTimer = setTimeout(() => setEmote('neutral', false), 6000);
  }

  function pickEmotion(reply) {
    for (const rule of MOOD_RULES) {
      if (rule.re.test(reply)) return rule.emotion;
    }
    return 'neutral';
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

  function updateWelcome(el) {
    el.textContent = isConfigured(settings)
      ? 'Konkonn! I\'m Kanna 🦊 Ask me anything — or open ⚙ Settings to change how I think.'
      : 'Hi! I\'m Kanna 🦊 Add an API key in ⚙ Settings and I\'m yours.';
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
    sendBtn.innerHTML = STOP_ICON;
    sendBtn.classList.add('stop');
    sendBtn.title = 'Stop';
    setThinking();

    try {
      const result = await window.kanna.sendChat(history.slice(-24));
      if (text) history.push({ role: 'assistant', content: text });
      else if (result.stopped) {
        bubble.classList.remove('typing');
        bubble.textContent = '…';
      } else bubble.remove(); // no content and not stopped — drop the empty bubble
    } catch (err) {
      bubble.classList.remove('typing');
      bubble.textContent = `⚠ ${pickErrorMessage(err)}`;
      bubble.classList.add('error');
    } finally {
      busy = false;
      sendBtn.innerHTML = SEND_ICON;
      sendBtn.classList.remove('stop');
      sendBtn.title = 'Send (Enter)';
      bubble = null;
      if (text) moodFlash(pickEmotion(text));
      else setEmote('neutral', false);
      scrollToBottom();
    }
  }

  function pickErrorMessage(err) {
    return (err?.message || 'Something went wrong. Try again.').replace(/^Error: /, '');
  }

  window.kanna.onChunk((chunk) => {
    if (!busy || !bubble) return;
    if (bubble.classList.contains('typing')) {
      bubble.classList.remove('typing');
      bubble.textContent = '';
      setEmote('neutral', true); // first real token — now she speaks
    }
    text += chunk;
    bubble.textContent = text;
    scrollToBottom();
  });

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
  $('#win-max').addEventListener('click', () => window.kanna.toggleMaximize());
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
