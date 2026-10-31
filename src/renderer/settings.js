'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const drawer = $('#drawer');
  const scrim = $('#scrim');

  const els = {
    provider: $('#provider'),
    hint: $('#provider-hint'),
    keyField: $('#field-key'),
    key: $('#apikey'),
    eye: $('#btn-eye'),
    baseUrlField: $('#field-baseurl'),
    baseUrl: $('#baseurl'),
    model: $('#model'),
    persona: $('#persona'),
  };

  const PROVIDER_META = {
    openai: {
      hint: 'Get a key at platform.openai.com. Models like “gpt-4o-mini”.',
      keyPlaceholder: 'sk-…',
      modelPlaceholder: 'gpt-4o-mini',
    },
    anthropic: {
      hint: 'Get a key at console.anthropic.com. Models like “claude-sonnet-4-5”.',
      keyPlaceholder: 'sk-ant-…',
      modelPlaceholder: 'claude-sonnet-4-5',
    },
    gemini: {
      hint: 'Get a key at aistudio.google.com (has a free tier). Models like “gemini-2.5-flash”.',
      keyPlaceholder: 'AI…',
      modelPlaceholder: 'gemini-2.5-flash',
    },
    custom: {
      hint: 'Any OpenAI-compatible endpoint: OpenRouter (https://openrouter.ai/api/v1), LM Studio (http://localhost:1234/v1), Ollama (http://localhost:11434/v1). API key is optional for local servers.',
      keyPlaceholder: 'optional',
      modelPlaceholder: 'model name, e.g. llama3.2:3b',
    },
  };

  let draft = null;

  function open() {
    window.kanna.getSettings().then((saved) => {
      draft = structuredClone(saved);
      render();
      drawer.classList.add('open');
      scrim.classList.remove('hidden');
      els.key.focus();
    });
  }

  function close() {
    drawer.classList.remove('open');
    scrim.classList.add('hidden');
  }

  function isOpen() {
    return drawer.classList.contains('open');
  }

  function render() {
    const p = draft.provider;
    const meta = PROVIDER_META[p];
    const perProvider = draft[p] || (draft[p] = {});

    els.provider.value = p;
    els.hint.textContent = meta.hint;
    els.key.placeholder = meta.keyPlaceholder;
    els.model.placeholder = meta.modelPlaceholder;
    els.key.value = perProvider.apiKey || '';
    els.model.value = perProvider.model || '';
    els.baseUrlField.hidden = p !== 'custom';
    if (p === 'custom') els.baseUrl.value = perProvider.baseUrl || '';
    els.persona.value = draft.persona || '';
    els.key.type = 'password';
    els.eye.textContent = '👁';
  }

  async function save(e) {
    e.preventDefault();
    const p = draft.provider;

    draft[p].apiKey = els.key.value.trim();
    draft[p].model = els.model.value.trim();
    if (p === 'custom') draft[p].baseUrl = els.baseUrl.value.trim();
    draft.persona = els.persona.value.trim();

    const saved = await window.kanna.saveSettings({
      provider: p,
      persona: draft.persona,
      openai: { apiKey: draft.openai.apiKey, model: draft.openai.model },
      anthropic: { apiKey: draft.anthropic.apiKey, model: draft.anthropic.model },
      gemini: { apiKey: draft.gemini.apiKey, model: draft.gemini.model },
      custom: { apiKey: draft.custom.apiKey, model: draft.custom.model, baseUrl: draft.custom.baseUrl },
    });

    draft = structuredClone(saved);
    close();
    window.dispatchEvent(new CustomEvent('kanna:settings-changed'));
    window.dispatchEvent(new CustomEvent('kanna:toast', { detail: 'Saved ✓' }));
  }

  $('#settings-form').addEventListener('submit', save);
  $('#btn-settings').addEventListener('click', open);
  window.addEventListener('kanna:open-settings', open);
  $('#btn-close').addEventListener('click', close);
  scrim.addEventListener('click', close);

  els.provider.addEventListener('change', () => {
    draft.provider = els.provider.value;
    render();
  });

  els.key.addEventListener('input', () => {
    draft[draft.provider].apiKey = els.key.value;
  });

  els.model.addEventListener('input', () => {
    draft[draft.provider].model = els.model.value;
  });

  els.baseUrl.addEventListener('input', () => {
    draft.custom.baseUrl = els.baseUrl.value;
  });

  els.persona.addEventListener('input', () => {
    draft.persona = els.persona.value;
  });

  els.eye.addEventListener('click', () => {
    const hidden = els.key.type === 'password';
    els.key.type = hidden ? 'text' : 'password';
    els.eye.textContent = hidden ? '🙈' : '👁';
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });
})();
