'use strict';

const { getSettings, DEFAULT_PERSONA } = require('./settings');

let active = null;

function abortActive() {
  if (active) active.controller.abort();
}

// Streams one assistant reply. Emits ('chat:chunk', textDiff) to the renderer
// as tokens arrive and resolves to { stopped, text } at the end. Throws on
// hard errors (bad key, bad model, network) — the renderer shows the message.
async function runChat(messages, emit, system, opts = {}) {
  const { registerInActive = true, plain = false } = opts;
  const settings = getSettings();
  const controller = new AbortController();
  if (registerInActive) active = { controller };

  let text = '';
  const reader = plain ? null : createReplyReader();
  const push = (chunk) => {
    if (!reader) {
      text += chunk;
      emit('chat:chunk', chunk);
      return;
    }
    const meta = reader.feed(chunk); // announces mood/speed as soon as they arrive
    if (meta) emit('chat:meta', meta);
    const t = reader.takeText();
    if (t) {
      text += t;
      emit('chat:chunk', t);
    }
  };
  // Runs on success and on abort: hand over any decoded text left in the
  // reader buffer and a meta that was still pending.
  const flush = () => {
    if (!reader) return;
    const meta = reader.finish();
    if (meta) emit('chat:meta', meta);
    const t = reader.takeText();
    if (t) {
      text += t;
      emit('chat:chunk', t);
    }
  };

  try {
    // Explicit system string wins (memory extraction uses this); otherwise
    // compose the persona with the long-term memory block.
    const systemPrompt = system !== undefined
      ? system
      : composeChatSystem(settings);

    if (settings.provider === 'anthropic') {
      await streamAnthropic(settings, messages, push, controller.signal, systemPrompt);
    } else if (settings.provider === 'gemini') {
      await streamGemini(settings, messages, push, controller.signal, systemPrompt);
    } else {
      await streamOpenAI(settings, messages, push, controller.signal, systemPrompt);
    }
    flush();
    return { stopped: false, text };
  } catch (err) {
    flush();
    if (isAbort(err)) return { stopped: true, text };
    throw err;
  } finally {
    if (registerInActive) active = null;
  }
}

// --- reply protocol ---------------------------------------------------------
// Chat replies are one JSON object: {"mood":"…","speed":…,"text":"…"} — keys
// in this fixed order so mood and speed are known before any words stream.
// createReplyReader() feeds raw chunks through an incremental decoder and
// yields progressively the decoded `text` value, so the bubble still types
// out live. Mood/speed surface via 'chat:meta'. A reply that doesn't start
// as JSON (model ignored the protocol) degrades to raw passthrough, and a
// broken JSON object falls back to the raw output so the bubble is never
// empty. Memory extraction opts out entirely via plain:true.

function createReplyReader() {
  const r = {
    raw: '',
    mode: null,        // 'json' | 'plain' — decided on the first real char
    textFrom: -1,      // raw index where the "text" value starts
    textDone: false,   // closing quote reached
    pos: 0,            // decode cursor within the text value
    mood: '',          // as the model wrote it (lowercased)
    speed: 0,
    hold: false,
    moodEmit: undefined,
    speedEmit: undefined,
    holdEmit: undefined,
    moodSent: false,
    speedSent: false,
    holdSent: false,
    out: '',           // decoded text not yet handed to the caller
  };

  const escMap = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

  function scanMeta() {
    if (!r.moodSent) {
      const m = /"mood"\s*:\s*"([^"]*)"/.exec(r.raw);
      if (m) {
        r.mood = m[1].trim().toLowerCase();
        r.moodSent = true;
      }
    }
    if (!r.speedSent) {
      const m = /"speed"\s*:\s*([0-9]*\.?[0-9]+)/.exec(r.raw);
      if (m) {
        r.speed = Number(m[1]);
        r.speedSent = true;
      }
    }
    if (!r.holdSent) {
      const m = /"hold"\s*:\s*(true|false)/.exec(r.raw);
      if (m) {
        r.hold = m[1] === 'true';
        r.holdSent = true;
      }
    }
  }

  // Decodes as much of the "text" string value as has streamed in.
  function decode() {
    while (r.textFrom >= 0 && !r.textDone && r.pos < r.raw.length) {
      const ch = r.raw[r.pos];
      if (ch === '"') {
        r.textDone = true;
        break;
      }
      if (ch === '\\') {
        if (r.pos + 1 >= r.raw.length) break;        // escape split across chunks
        if (r.raw[r.pos + 1] === 'u') {
          if (r.pos + 6 > r.raw.length) break;       // \uXXXX split across chunks
          const code = parseInt(r.raw.slice(r.pos + 2, r.pos + 6), 16);
          if (!Number.isFinite(code)) break;          // not hex — skip rather than guess
          r.out += String.fromCharCode(code);
          r.pos += 6;
          continue;
        }
        const esc = escMap[r.raw[r.pos + 1]];
        r.out += esc !== undefined ? esc : r.raw[r.pos + 1];
        r.pos += 2;
        continue;
      }
      r.out += ch;
      r.pos++;
    }
  }

  function takeText() {
    const out = r.out;
    r.out = '';
    return out;
  }

  function takeMeta() {
    let meta = null;
    if (r.moodSent && r.mood !== r.moodEmit) {
      (meta ??= {}).mood = r.mood;
      r.moodEmit = r.mood;
    }
    if (r.speedSent && r.speed !== r.speedEmit) {
      (meta ??= {}).speed = r.speed;
      r.speedEmit = r.speed;
    }
    if (r.holdSent && r.hold !== r.holdEmit) {
      (meta ??= {}).hold = r.hold;
      r.holdEmit = r.hold;
    }
    return meta;
  }

  function feed(chunk) {
    r.raw += chunk;
    if (!r.mode) {
      // Tolerate a ```json fence before the object when deciding.
      const t = r.raw.replace(/^\s+/, '').replace(/^```(?:json)?\s*/i, '');
      if (!t) return null;
      r.mode = t[0] === '{' ? 'json' : 'plain';
    }
    if (r.mode === 'plain') {
      r.out += chunk;
      return null;
    }
    scanMeta();
    if (r.textFrom < 0) {
      const m = /"text"\s*:\s*"/.exec(r.raw);
      if (m) {
        r.textFrom = m.index + m[0].length;
        r.pos = r.textFrom; // start decoding at the value, not at the object
      }
    }
    decode();
    return takeMeta();
  }

  function finish() {
    if (r.mode === 'json') decode();
    // Protocol fell apart before any visible text: show the raw output
    // rather than an empty bubble.
    if (r.mode === 'json' && r.out === '' && !r.textDone) r.out = r.raw.trim();
    return takeMeta();
  }

  return { feed, finish, takeText };
}

// Persona + current memory, injected into every chat request.
const REPLY_FORMAT = [
  'Reply protocol — answer with a single JSON object and nothing else (no markdown fences, no words before or after it), with the keys in exactly this order:',
  '{"mood":"…","speed":…,"hold":…,"text":"…"}',
  '- mood: the emotion this reply carries: neutral, happy, sad, angry, shy, surprise, dizzy, or strained.',
  '- speed: how the text should feel spoken: 0.7 hushed/soothing, 1 normal, 1.8 excited.',
  '- hold: whether the emotion stays on your face after the reply. true keeps it until your next reply changes it; false (or omit) eases back to neutral after a few seconds. Lasting feelings (sad, angry, shy, dizzy) tend to hold; fleeting ones (happy, surprise) usually don\'t.',
  '- text: your reply as the user should see it. It is inside JSON, so write newlines as \\n and escape double quotes as \\".',
].join('\n');

function composeChatSystem(settings) {
  const persona = settings.persona || DEFAULT_PERSONA;
  // Lazy require — memory.js pulls ai.js in (see note there).
  const memory = require('./memory');
  const block = memory.renderForPrompt();
  const parts = [persona];
  if (block) parts.push(`Long-term memory about the user:\n${block}`);
  parts.push(REPLY_FORMAT);
  return parts.join('\n\n');
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
}

// --- provider adapters -----------------------------------------------------

async function streamOpenAI(settings, messages, push, signal, systemPrompt) {
  const custom = settings.provider === 'custom';
  const conf = custom ? settings.custom : settings.openai;
  const label = custom ? 'Custom provider' : 'OpenAI';

  if (!conf.model) throw new Error(`${label} needs a model name — set one in Settings.`);
  if (!custom && !conf.apiKey) throw new Error(`${label} needs an API key — add one in Settings.`);

  const baseUrl = (custom ? conf.baseUrl : 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Custom provider needs a base URL — set one in Settings.');

  const headers = {};
  if (!custom || conf.apiKey) headers.authorization = `Bearer ${conf.apiKey}`;

  const res = await post(`${baseUrl}/chat/completions`, headers, {
    stream: true,
    model: conf.model,
    // No max_tokens/temperature here: newer OpenAI models and many
    // OpenAI-compatible servers reject the legacy parameters.
    messages: [{ role: 'system', content: systemPrompt }, ...normalize(messages)],
  }, signal, label);

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    // Some OpenAI-compatible local servers ignore stream:true — fall back to JSON.
    const j = await res.json();
    const t = j.choices?.[0]?.message?.content;
    if (t) push(t);
    return;
  }

  await streamSSE(res, (data) => {
    if (data === '[DONE]') return false;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    const t = j.choices?.[0]?.delta?.content;
    if (t) push(t);
  });
}

async function streamAnthropic(settings, messages, push, signal, systemPrompt) {
  if (!settings.anthropic.apiKey) throw new Error('Anthropic needs an API key — add one in Settings.');
  if (!settings.anthropic.model) throw new Error('Anthropic needs a model name — set one in Settings.');

  const res = await post('https://api.anthropic.com/v1/messages', {
    'x-api-key': settings.anthropic.apiKey,
    'anthropic-version': '2023-06-01',
  }, {
    stream: true,
    max_tokens: 1024,
    temperature: 0.8,
    model: settings.anthropic.model,
    system: systemPrompt,
    messages: normalize(messages),
  }, signal, 'Anthropic');

  await streamSSE(res, (data) => {
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.type === 'content_block_delta' && j.delta?.text) push(j.delta.text);
    if (j.type === 'message_stop') return false;
  });
}

async function streamGemini(settings, messages, push, signal, systemPrompt) {
  if (!settings.gemini.apiKey) throw new Error('Gemini needs an API key — add one in Settings.');
  if (!settings.gemini.model) throw new Error('Gemini needs a model name — set one in Settings.');

  const model = encodeURIComponent(settings.gemini.model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  const res = await post(url, { 'x-goog-api-key': settings.gemini.apiKey }, {
    contents: normalize(messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
  }, signal, 'Gemini');

  await streamSSE(res, (data) => {
    let j;
    try { j = JSON.parse(data); } catch { return; }
    for (const part of j.candidates?.[0]?.content?.parts || []) {
      if (part.text) push(part.text);
    }
  });
}

// --- plumbing --------------------------------------------------------------

async function post(url, headers, body, signal, label) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new Error(friendlyNetworkError(err, url));
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(humanHttpError(label, res.status, text));
  }
  return res;
}

// Fetch-level failures (connection refused, TLS mismatches, DNS) surface as
// raw "fetch failed" — translate the common ones into actionable messages.
function friendlyNetworkError(err, url) {
  const cause = err?.cause || {};
  const code = cause.code || cause.opensslErrorStack || '';
  const detail = `${cause.reason || cause.message || err.message || ''} ${code}`;
  let host = url;
  try { host = new URL(url).host; } catch { /* keep url */ }

  if (detail.includes('WRONG_VERSION_NUMBER')) {
    return `${host} answers in plain HTTP but the Base URL is https:// — local servers speak http:// (LM Studio: http://localhost:1234/v1, Ollama: http://localhost:11434/v1). Fix it in Settings.`;
  }
  if (code === 'ECONNREFUSED') {
    return `Can't connect to ${host} — the server isn't running, or the port in Settings is wrong.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Can't resolve ${host} — check the Base URL in Settings.`;
  }
  if (code === 'CERT_HAS_EXPIRED' || detail.includes('certificate')) {
    return `TLS certificate problem with ${host}: ${detail.trim()}`;
  }
  return `Network error talking to ${host}: ${detail.trim() || 'unknown'}`;
}

function humanHttpError(label, status, bodyText) {
  let msg = '';
  try { msg = JSON.parse(bodyText)?.error?.message || ''; } catch { /* keep '' */ }
  if (!msg) msg = (bodyText || '').trim().slice(0, 240);
  const base = `${label} request failed (HTTP ${status}): ${msg}`;
  if (status === 401 || status === 403) return `${base} — check the API key in Settings.`;
  if (status === 404) return `${base} — check the model name in Settings.`;
  if (status === 429) return `${base} (rate limited, try again soon)`;
  return base;
}

// Reads an SSE body, splitting events on blank lines and handing each
// `data:` line to onData. onData returning false stops the stream early.
async function streamSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const events = buf.split('\n\n');
    buf = events.pop() || '';

    let stop = false;
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data && onData(data) === false) { stop = true; break; }
      }
      if (stop) break;
    }
    if (stop) break;
  }
}

// Kept simple: strings only, merged so roles alternate.
function normalize(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m?.content ?? '').trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content;
    else out.push({ role, content });
  }
  return out;
}

module.exports = { runChat, abortActive };
