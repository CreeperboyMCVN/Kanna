'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let sttServer = { proc: null, url: null, starting: null };
let currentSession = null;

function resolvePythonExecutable(command) {
  const first = String(command || 'python').trim().split(/\s+/)[0];
  const base = path.basename(first).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
  if (['python', 'python3', 'py'].includes(base)) return first;
  return 'python';
}

function sttServerScriptPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'resources', 'stt', 'stt_server.py'),
    path.join(process.resourcesPath || '', 'stt', 'stt_server.py'),
    path.join(__dirname, '..', '..', 'resources', 'stt', 'stt_server.py'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || '';
}

function resolveSttModel(modelPath) {
  if (!modelPath) return '';
  return fs.existsSync(modelPath) ? modelPath : '';
}

async function ensureSttServer(keys = {}) {
  if (sttServer.url) {
    try {
      const health = await fetch(sttServer.url + '/health');
      if (health.ok) return sttServer.url;
    } catch {
      // stale; restart
    }
    if (sttServer.proc) try { sttServer.proc.kill(); } catch { /* ignore */ }
    sttServer = { proc: null, url: null, starting: null };
  }
  if (sttServer.starting) return await sttServer.starting;

  const startPromise = (async () => {
    const script = sttServerScriptPath();
    if (!script) throw new Error('STT server script is missing');

    const python = resolvePythonExecutable(keys.command || keys.sttCommand || 'python');
    const args = [script];
    const model = resolveSttModel(keys.model || keys.sttModel || '');
    if (model) args.push('--model', model);
    else args.push('--lang', keys.lang || keys.sttLang || 'en-us');
    const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    sttServer.proc = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('STT server did not become ready in time')), 180000);
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/READY\s+(http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
  console.log('[stt server] exited', code, stderr.trim().slice(0, 500));
        if (!sttServer.url) {
          clearTimeout(timer);
          reject(new Error(`STT server exited (${code}): ${stderr.trim()}`));
        }
      });
    });

    sttServer.url = url;
    child.on('exit', () => {
      sttServer.proc = null;
      sttServer.url = null;
      sttServer.starting = null;
    });
    return url;
  })();

  sttServer.starting = startPromise;
  try { return await startPromise; }
  finally { if (sttServer.starting === startPromise) sttServer.starting = null; }
}

async function sttStart(keys = {}) {
  const url = await ensureSttServer(keys);
  const response = await fetch(url + '/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sampleRate: 16000 }),
  });
  if (!response.ok) throw new Error(`STT start failed (HTTP ${response.status})`);
  const data = await response.json();
  currentSession = data.sessionId || null;
  return { ok: !!currentSession };
}

async function sttAudio(pcmBuffer) {
  if (!currentSession || !sttServer.url) return { partial: '' };
  const body = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
  try {
    const response = await fetch(`${sttServer.url}/audio?session=${encodeURIComponent(currentSession)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (!response.ok) return { partial: '' };
    const data = await response.json();
    return { partial: data.partial || '' };
  } catch (err) {
    console.log('[stt audio] failed:', err?.message || err);
    return { partial: '' };
  }
}

async function sttFinish() {
  const id = currentSession;
  currentSession = null;
  if (!id || !sttServer.url) return { text: '' };
  const response = await fetch(`${sttServer.url}/finish?session=${encodeURIComponent(id)}`, { method: 'POST' });
  if (!response.ok) return { text: '' };
  const data = await response.json();
  return { text: data.text || '' };
}

async function sttCancel() {
  const id = currentSession;
  currentSession = null;
  if (!id || !sttServer.url) return;
  try {
    await fetch(`${sttServer.url}/cancel?session=${encodeURIComponent(id)}`, { method: 'POST' });
  } catch {
    // ignore
  }
}

function stopSttServer() {
  if (sttServer.proc) try { sttServer.proc.kill(); } catch { /* ignore */ }
  sttServer = { proc: null, url: null, starting: null };
  currentSession = null;
}

module.exports = { sttStart, sttAudio, sttFinish, sttCancel, stopSttServer };