'use strict';

// Tiny file logger for Kanna. The packaged app has no visible console, so
// main-process diagnostics are written to %APPDATA%\Kanna\logs\kanna.log and
// rotated at ~1 MB (old file kept as kanna.log.1). Lines are mirrored to the
// real console so `npm start` stays as verbose as before.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROTATE_BYTES = 900 * 1024;

// Same location settings.js uses, derived without depending on Electron state:
// %APPDATA%\Kanna\logs on Windows, ~/.config/Kanna/logs elsewhere.
function logDir() {
  const base = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(base, 'Kanna', 'logs');
}

function logFilePath() {
  return path.join(logDir(), 'kanna.log');
}

function rotateIfNeeded(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < ROTATE_BYTES) return;
    try { fs.unlinkSync(file + '.1'); } catch { /* no old rotation yet */ }
    fs.renameSync(file, file + '.1');
  } catch { /* file not present yet */ }
}

function formatErr(arg) {
  if (arg instanceof Error) {
    const extra = arg.cause ? `\n  cause: ${formatErr(arg.cause)}` : '';
    return `${arg.message}\n${arg.stack || ''}${extra}`;
  }
  if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function emit(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args.map(formatErr).join(' ')}\n`;
  // Console first: on dev runs this equals the old behaviour.
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(line.trimEnd());
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = logFilePath();
    rotateIfNeeded(file);
    fs.appendFileSync(file, line);
  } catch { /* logging must never crash the app */ }
}

module.exports = {
  info: (...args) => emit('INFO', args),
  warn: (...args) => emit('WARN', args),
  error: (...args) => emit('ERROR', args),
  logFilePath,
};
