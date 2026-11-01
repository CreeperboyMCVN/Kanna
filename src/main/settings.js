'use strict';

// Settings store. API keys are encrypted AT REST with the OS credentials
// (Electron safeStorage → DPAPI on Windows): on disk each key is stored as
// `enc:v1:<base64>`, while the in-memory cache stays plaintext so the
// settings drawer and provider adapters need no changes. A value that can't
// be encrypted (OS without DPAPI, rare) falls back to plaintext on disk.

const { app, safeStorage } = require('electron');
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

// Where API keys live in the settings shape.
const KEY_FIELDS = ['openai', 'anthropic', 'gemini', 'custom'];

const MARKER = 'enc:v1:';
let cache = null;
let warnedEncrypt = false;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(MARKER);
}

// Returns the encrypted form, or null when the OS can't do it — the caller
// then keeps plaintext (current behavior) and we mention it once.
function encrypt(plain) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return MARKER + safeStorage.encryptString(plain).toString('base64');
  } catch (err) {
    if (!warnedEncrypt) {
      warnedEncrypt = true;
      console.log('[settings]', 'key encryption unavailable — staying plaintext:', err?.message || err);
    }
    return null;
  }
}

function decrypt(blob) {
  try {
    return safeStorage.decryptString(Buffer.from(blob.slice(MARKER.length), 'base64'));
  } catch {
    // Encrypted by another OS account / unrecoverable — treat as unset.
    console.log('[settings]', 'an API key could not be decrypted — re-enter it in Settings.');
    return '';
  }
}

function getSettings() {
  if (!cache) {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    } catch {
      // fresh store
    }
    cache = merge(DEFAULT_SETTINGS, raw);

    // Migrate: decrypt blobs into memory; any plaintext keys the app
    // upgraded with get re-encrypted on disk once, right now.
    let plainOnDisk = false;
    for (const group of KEY_FIELDS) {
      const v = cache[group]?.apiKey;
      if (typeof v !== 'string' || !v) continue;
      if (isEncrypted(v)) {
        cache[group].apiKey = decrypt(v);
      } else {
        plainOnDisk = true;
      }
    }
    if (plainOnDisk) {
      const n = persist();
      if (n) console.log('[settings]', `encrypted ${n} API key(s) with your OS credentials`);
    }
  }
  return cache;
}

function save(patch) {
  const next = merge(getSettings(), patch || {});
  next.provider = PROVIDERS.includes(next.provider) ? next.provider : 'openai';
  cache = next;
  persist();
  return next;
}

// Writes the current (plaintext) cache to disk with every API key encrypted
// when the OS supports it.
function persist() {
  const disk = structuredClone(cache);
  let encrypted = 0;
  for (const group of KEY_FIELDS) {
    const v = disk[group]?.apiKey;
    if (typeof v === 'string' && v && !isEncrypted(v)) {
      const blob = encrypt(v);
      if (blob) {
        disk[group].apiKey = blob;
        encrypted++;
      }
    }
  }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(disk, null, 2), 'utf8');
  return encrypted;
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

