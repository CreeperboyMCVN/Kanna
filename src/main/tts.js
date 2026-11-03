'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Third-party TTS providers for Kanna. All API calls happen in the main
// process so keys (encrypted at rest in settings.json) never leave it.
// Each speak() returns { audioDataUrl, durationMs } — a data: URL the
// renderer can feed to <audio>, and an estimated duration for pacing.

const AZURE_TOKEN_HOST = (region) => `https://${region}.api.cognitive.microsoft.com`;

function charsPerSec(rate) {
  // Rough human speech: ~13 chars/sec at normal pace, scaled by rate.
  return Math.max(1, 13 * rate);
}
function estimateDurationMs(text, rate) {
  return Math.max(600, Math.ceil((text.length / charsPerSec(rate)) * 1000));
}

// --- ElevenLabs --------------------------------------------------------------

async function ttsElevenLabs({ text, voice, rate, keys = {} }) {
  const key = keys.elevenlabsKey;
  if (!key) throw new Error('ElevenLabs API key not set');
  const voiceId = voice || '21m00Tcm4TlvDq8ikWAM'; // Rachel
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs (${res.status}): ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    audioDataUrl: `data:audio/mpeg;base64,${buf.toString('base64')}`,
    durationMs: estimateDurationMs(text, rate),
  };
}

// --- OpenAI TTS --------------------------------------------------------------

async function ttsOpenAI({ text, voice, rate, keys = {} }) {
  const key = keys.openaiKey;
  if (!key) throw new Error('OpenAI API key not set');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: voice || 'alloy',
      // OpenAI TTS doesn't support rate/pitch directly; 1.0 is the only speed.
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI TTS (${res.status}): ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    audioDataUrl: `data:audio/mpeg;base64,${buf.toString('base64')}`,
    durationMs: estimateDurationMs(text, rate),
  };
}

// --- Azure Speech ------------------------------------------------------------

async function ttsAzure({ text, voice, rate, pitch, keys = {} }) {
  const key = keys.azureKey;
  const region = keys.azureRegion;
  if (!key) throw new Error('Azure Speech key not set');
  if (!region) throw new Error('Azure region not set');

  // 1. Issue an auth token.
  const tokenRes = await fetch(`${AZURE_TOKEN_HOST(region)}/sts/v1.0/issueToken`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key },
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`Azure token (${tokenRes.status}): ${body}`);
  }
  const token = await tokenRes.text();

  // 2. Synthesize with SSML. rate/pitch as relative change (e.g. "+10%").
  const ratePct = Math.round((rate - 1) * 100);
  const pitchPct = Math.round((pitch - 1) * 100);
  const ssml = `
<speak version='1.0' xml:lang='en-US'>
  <voice name='${voice || 'en-US-AvaMultilingualNeural'}'>
    <prosody rate='${ratePct >= 0 ? '+' : ''}${ratePct}%' pitch='${pitchPct >= 0 ? '+' : ''}${pitchPct}%'>
      ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}
    </prosody>
  </voice>
</speak>
`.trim();

  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
    },
    body: ssml,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Azure TTS (${res.status}): ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    audioDataUrl: `data:audio/mpeg;base64,${buf.toString('base64')}`,
    durationMs: estimateDurationMs(text, rate),
  };
}

// --- Google Cloud TTS --------------------------------------------------------

async function ttsGoogle({ text, voice, rate, pitch, keys = {} }) {
  const key = keys.googleKey;
  if (!key) throw new Error('Google Cloud TTS key not set');
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'en-US', name: voice || 'en-US-Neural2-F' },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: rate,
        pitch,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google TTS (${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.audioContent) throw new Error('Google TTS: no audio content returned');
  return {
    audioDataUrl: `data:audio/mp3;base64,${data.audioContent}`,
    durationMs: estimateDurationMs(text, rate),
  };
}

// --- Piper (local, offline) --------------------------------------------------

function getElectronAppPath() {
  try {
    return require('electron')?.app?.getAppPath?.() || '';
  } catch {
    return '';
  }
}

async function resolveBundledPiperModel() {
  const candidates = [
    path.join(__dirname, '..', '..', 'resources', 'piper', 'en_US.onnx'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'resources', 'piper', 'en_US.onnx'),
    path.join(process.resourcesPath || '', 'piper', 'en_US.onnx'),
    path.join(process.resourcesPath || '', 'piper', 'model.onnx'),
    path.join(getElectronAppPath() || '', 'resources', 'piper', 'en_US.onnx'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || '';
}

async function ttsPiper({ text, voice = '', rate = 1, keys = {} }) {
  const command = keys.piperCommand || 'py';
  let model = (keys.piperModel || '').trim();
  if (!model) model = await resolveBundledPiperModel();
  const dataDir = keys.piperDataDir || '';

  if (!model) throw new Error('Piper model not set or bundled (expected resources/piper/en_US.onnx)');

  // Piper multi-speaker models select a speaker with --speaker.
  const speaker = String(voice || '').trim();

  // Prefer the long-lived Piper server (model loaded once); fall back to
  // spawning Piper per utterance if the server cannot start.
  try {
    const serverResult = await speakWithPiperServer(text, voice, keys);
    if (serverResult?.audioDataUrl) {
      serverResult.durationMs = estimateDurationMs(text, rate);
      return serverResult;
    }
  } catch (err) {
    console.warn('[tts piper] server unavailable, falling back to CLI spawn:', err?.message || err);
  }

  const tmpDir = os.tmpdir();
  const outFile = path.join(tmpDir, `kanna-piper-${Date.now()}.wav`);

  // Prefer a Python/Piper environment bundled alongside the installed app when
  // present (see TODO packaging notes); otherwise honor the configured command.
  let resolvedCommand = String(command || '').trim();
  const bundledPython = path.join(process.resourcesPath || '', 'piper', 'python.exe');
  if ((!resolvedCommand || resolvedCommand.toLowerCase() === 'python') && fs.existsSync(bundledPython)) {
    resolvedCommand = bundledPython;
  }

  // Support both a bare/configured command (`python`, `py`, a full path, or
  // `python -m piper`) and a piper binary. Extra tokens in piperCommand
  // (e.g. "python -m piper") are prepended to Piper's own arguments.
  const cmdParts = resolvedCommand.split(/\\s+/).filter(Boolean);
  const cmd = cmdParts[0] || 'python';
  const implicitArgs = cmdParts.slice(1);

  const base = path.basename(cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
  const isPython = ['python', 'python3', 'py'].includes(base);

  const args = [...implicitArgs];
  if (implicitArgs.length === 0 && isPython) {
    args.push('-m', 'piper');
  }
  args.push('-m', model);
  if (speaker) args.push('--speaker', speaker);
  if (dataDir) args.push('--data-dir', dataDir);
  args.push('-f', outFile);
  args.push('--', text);

  await new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`Piper spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Piper exited ${code}: ${stderr.trim()}`));
      } else {
        resolve();
      }
    });
  });

  if (!fs.existsSync(outFile)) {
    throw new Error('Piper did not produce output file');
  }
  const buf = fs.readFileSync(outFile);
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }

  return {
    audioDataUrl: `data:audio/wav;base64,${buf.toString('base64')}`,
    durationMs: estimateDurationMs(text, rate),
  };
}

// --- dispatch ----------------------------------------------------------------

const PROVIDERS = {
  piper: ttsPiper,
  elevenlabs: ttsElevenLabs,
  openai: ttsOpenAI,
  azure: ttsAzure,
  google: ttsGoogle,
};

async function speak({ text, provider, voice = '', rate = 1, pitch = 1, keys = {} }) {
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`TTS provider not implemented: ${provider}`);
  return await fn({ text, voice, rate, pitch, keys });
}

// --- Piper HTTP server --------------------------------------------------------
// A long-lived Python process keeps the heavy ONNX model loaded between
// utterances. Kanna talks to it over localhost instead of spawning Piper
// from scratch for every bubble.

let piperServer = { proc: null, url: null, starting: null };

// PyInstaller --onefile builds (kanna-piper-server.exe) run as a parent
// bootloader process plus a child that actually serves. Killing only the
// direct PID orphans the child, and killing the root with hard kill wins
// the race against taskkill's own tree walk. Order matters: try the
// graceful /shutdown first (the child exits itself, then the parent
// bootloader follows), then tree-kill, and hard-kill as a last resort.
function killPiperProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* fall through to plain kill */ }
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function killReplicaIfStillAlive(pid) {
  if (!pid) return;
  setTimeout(() => {
    try {
      process.kill(pid, 0);      // throws ESRCH when gone
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }, 2500);
}

function resolvePythonExecutable(command) {
  const first = String(command || 'python').trim().split(/\\s+/)[0];
  const base = path.basename(first).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
  if (['python', 'python3', 'py'].includes(base)) return first;
  return 'python';
}

function resolveBundledPiperServerExe() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'resources', 'piper', 'kanna-piper-server.exe'),
    path.join(__dirname, '..', '..', 'resources', 'piper', 'kanna-piper-server.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || '';
}

function piperServerScriptPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'resources', 'stt', 'stt_server.py'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'resources', 'piper', 'piper_server.py'),
    path.join(__dirname, '..', '..', 'resources', 'piper', 'piper_server.py'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || '';
}

async function ensurePiperServer(keys = {}) {
  if (piperServer.url) {
    try {
      const health = await fetch(piperServer.url + '/health');
      if (health.ok) return piperServer.url;
    } catch {
      // stale/terminated; restart below
    }
    stopPiperServer();
  }
  if (piperServer.starting) return await piperServer.starting;

  const startPromise = (async () => {
    const script = piperServerScriptPath();
    if (!script) throw new Error('Piper server script is missing');

    let model = String(keys.piperModel || '').trim();
    if (!model) model = await resolveBundledPiperModel();
    if (!model) throw new Error('Piper model not set or bundled');

    const exe = resolveBundledPiperServerExe();
    const python = resolvePythonExecutable(keys.piperCommand);
    const child = exe
      ? spawn(exe, ['--model', model], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(python, [script, '--model', model], { stdio: ['ignore', 'pipe', 'pipe'] });

    piperServer.proc = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Piper server did not become ready in time'));
      }, 180000);
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/READY\s+(http:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        if (!piperServer.url) {
          clearTimeout(timer);
          reject(new Error(`Piper server exited (${code}): ${stderr.trim()}`));
        }
      });
    });

    piperServer.url = url;
    child.on('exit', () => {
      piperServer.proc = null;
      piperServer.url = null;
      piperServer.starting = null;
    });
    return url;
  })();

  piperServer.starting = startPromise;
  try {
    return await startPromise;
  } finally {
    if (piperServer.starting === startPromise) piperServer.starting = null;
  }
}

function stopPiperServer() {
  const server = piperServer;
  piperServer = { proc: null, url: null, starting: null };
  if (!server.proc && !server.url && !server.starting) return;

  // 1. Graceful suicide of the serving child (and its onefile parent).
  if (server.url) {
    try { fetch(server.url + '/shutdown', { method: 'POST' }).catch(() => { /* ignore */ }); } catch { /* ignore */ }
  }
  // 2. Tree kill while the bootloader parent is certainly alive.
  // 3. Hard-kill fallback if anything survived both.
  const pid = server.proc?.pid;
  if (pid) killPiperProcessTree(pid);
  killReplicaIfStillAlive(pid);
}

async function speakWithPiperServer(text, voice, keys) {
  const url = await ensurePiperServer(keys);
  const speaker = String(voice || '').trim();
  const response = await fetch(url + '/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      speaker: speaker && /^\\d+$/.test(speaker) ? Number(speaker) : 0,
    }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).error || ''; } catch { /* ignore */ }
    throw new Error(`Piper server failed (HTTP ${response.status})${detail ? ': ' + detail : ''}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  return {
    audioDataUrl: `data:audio/wav;base64,${audio.toString('base64')}`,
    durationMs: null,
  };
}

module.exports = { speak, estimateDurationMs, ensurePiperServer, startPiperServer: ensurePiperServer, stopPiperServer };