import { EdgeTTS } from 'edge-tts-universal';

// 100% free, no API key. Hindi neural pair:
// female -> Swara, male -> Madhur.
const VOICES = {
  female: 'hi-IN-SwaraNeural',
  male: 'hi-IN-MadhurNeural'
};

function extractAudio(result) {
  if (!result) return null;
  const candidates = [
    result.audioData,
    result.audio,
    result.data,
    result.buffer,
    result.audioBuffer
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(c)) return c;
    if (c instanceof Uint8Array) return Buffer.from(c);
    if (c instanceof ArrayBuffer) return Buffer.from(new Uint8Array(c));
    if (typeof c === 'string' && c.length > 100) {
      try { return Buffer.from(c, 'base64'); } catch (e) {}
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, voice } = req.body || {};

    const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (clean.length < 1) {
      return res.status(400).json({ error: 'Text required' });
    }

    const voiceName = VOICES[voice] || VOICES.female;

    const tts = new EdgeTTS(clean, voiceName);
    const result = await tts.synthesize();
    const buf = extractAudio(result);

    if (!buf || buf.length < 100) {
      return res.status(502).json({ error: 'TTS failed, use device voice' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (error) {
    console.error('Speak API Error:', error);
    return res.status(502).json({ error: 'TTS failed, use device voice' });
  }
}
