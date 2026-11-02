'use strict';

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

// --- dispatch ----------------------------------------------------------------

const PROVIDERS = {
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

module.exports = { speak, estimateDurationMs };