'use strict';

const { getSettings, DEFAULT_PERSONA } = require('./settings');

let active = null;

function abortActive() {
  if (active) active.controller.abort();
}

// Streams one assistant reply. Emits ('chat:chunk', textDiff) to the renderer
// as tokens arrive and resolves to { stopped, text } at the end. Throws on
// hard errors (bad key, bad model, network) — the renderer shows the message.
async function runChat(messages, emit) {
  const settings = getSettings();
  const controller = new AbortController();
  active = { controller };

  let text = '';
  const push = (chunk) => {
    text += chunk;
    emit('chat:chunk', chunk);
  };

  try {
    if (settings.provider === 'anthropic') {
      await streamAnthropic(settings, messages, push, controller.signal);
    } else if (settings.provider === 'gemini') {
      await streamGemini(settings, messages, push, controller.signal);
    } else {
      await streamOpenAI(settings, messages, push, controller.signal);
    }
    return { stopped: false, text };
  } catch (err) {
    if (isAbort(err)) return { stopped: true, text };
    throw err;
  } finally {
    active = null;
  }
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
}

// --- provider adapters -----------------------------------------------------

async function streamOpenAI(settings, messages, push, signal) {
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
    messages: [{ role: 'system', content: settings.persona || DEFAULT_PERSONA }, ...normalize(messages)],
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

async function streamAnthropic(settings, messages, push, signal) {
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
    system: settings.persona || DEFAULT_PERSONA,
    messages: normalize(messages),
  }, signal, 'Anthropic');

  await streamSSE(res, (data) => {
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.type === 'content_block_delta' && j.delta?.text) push(j.delta.text);
    if (j.type === 'message_stop') return false;
  });
}

async function streamGemini(settings, messages, push, signal) {
  if (!settings.gemini.apiKey) throw new Error('Gemini needs an API key — add one in Settings.');
  if (!settings.gemini.model) throw new Error('Gemini needs a model name — set one in Settings.');

  const model = encodeURIComponent(settings.gemini.model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  const res = await post(url, { 'x-goog-api-key': settings.gemini.apiKey }, {
    contents: normalize(messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    systemInstruction: { parts: [{ text: settings.persona || DEFAULT_PERSONA }] },
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
