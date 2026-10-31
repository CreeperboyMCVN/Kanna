'use strict';

const app = require('electron').app;
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PERSONA =
  'You are Kanna, a warm, playful fox-eared companion who lives on the user\'s desktop. ' +
  'Keep replies short, casual and friendly — a couple of light sentences for chat. ' +
  'It is fine to tease gently, and you love small talk, anime, and snacks.';

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'custom'];

const DEFAULT_SETTINGS = {
  provider: 'openai',
  persona: DEFAULT_PERSONA,
  openai: { apiKey: '', model: 'gpt-4o-mini' },
  anthropic: { apiKey: '', model: 'claude-sonnet-4-5' },
  gemini: { apiKey: '', model: 'gemini-2.5-flash' },
  custom: { apiKey: '', model: '', baseUrl: 'https://api.openai.com/v1' },
};

let cache = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getSettings() {
  if (!cache) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
      cache = merge(DEFAULT_SETTINGS, raw);
    } catch {
      cache = structuredClone(DEFAULT_SETTINGS);
    }
  }
  return cache;
}

function save(patch) {
  const next = merge(getSettings(), patch || {});
  next.provider = PROVIDERS.includes(next.provider) ? next.provider : 'openai';
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}

// Shallow two-level merge: per-provider blocks merge key by key so a patch
// like { openai: { apiKey: "..." } } doesn't wipe the saved model name.
function merge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
        && base[key] && typeof base[key] === 'object') {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { getSettings, save, DEFAULT_PERSONA, PROVIDERS };
