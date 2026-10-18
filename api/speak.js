import crypto from 'crypto';
import WebSocket from 'ws';

// DATEX AI — server voice (Microsoft Edge neural TTS over WebSocket, free, no API key).
//
// Oct 2026 FIX: Microsoft ne purana endpoint (speech.platform.bing.com) v1 tokens ke saath
// bahut se regions/severs pe 403 karna shuru kar diya (naya "v2 DRM" rollout). Live testing
// se confirmed: naya host + v1 token + version "1-143.0.3650.75" kaam karta hai:
//   wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1
//
// Voices (har device pe BILKUL same awaaz, kyunki audio server banata hai):
//   male   -> hi-IN-MadhurNeural (Hindi) / en-IN-PrabhatNeural (English)  [gehra mard]
//   female -> hi-IN-SwaraNeural  (Hindi) / en-IN-NeerjaNeural  (English)  [sweet girl]
//
// Warm serverless instance par WebSocket connection reuse hota hai (handshake time bachta hai),
// fail hone par ek fresh retry, phir bhi fail ho to client apne aap device voice pe chala jata
// hai (dekho index.html -> startSmartSpeak). Kuch bhi ho, request kabhi hang nahi hoti.

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'; // tested working (Oct 2026)
const WS_URL_BASE = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const WIN_EPOCH = 11644473600;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const MAX_TEXT = 1200;
const IDLE_CLOSE_MS = 25000;
const MIN_AUDIO_BYTES = 400;

const VOICE_MAP = {
  male: { hi: 'hi-IN-MadhurNeural', en: 'en-IN-PrabhatNeural' },
  female: { hi: 'hi-IN-SwaraNeural', en: 'en-IN-NeerjaNeural' },
};

const PATH_AUDIO_MARK = 'Path:audio';

function secMsGecToken() {
  // edge-tts (rany2) drm.py jaisa algorithm: Windows ticks (100ns units, 5-min pe round) + token ka SHA256.
  let ticks = Date.now() / 1000 + WIN_EPOCH;
  ticks -= ticks % 300;
  const str = String(Math.floor(ticks * 1e7)) + TRUSTED_CLIENT_TOKEN;
  return crypto.createHash('sha256').update(str).digest('hex').toUpperCase();
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label || 'timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

let warmConn = null;

function clearIdle(conn) {
  if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = null; }
}

function scheduleIdle(conn) {
  clearIdle(conn);
  conn.idleTimer = setTimeout(() => {
    conn.idleTimer = null;
    if (conn.busy) return;
    if (warmConn === conn) warmConn = null;
    try { conn.ws.close(); } catch (e) {}
  }, IDLE_CLOSE_MS);
  if (conn.idleTimer.unref) conn.idleTimer.unref();
}

function sendConfig(conn) {
  try {
    const ts = new Date().toISOString();
    conn.ws.send(
      'X-Timestamp:' + ts + '\r\n' +
      'Content-Type:application/json; charset=utf-8\r\n' +
      'Path:speech.config\r\n\r\n' +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"' + OUTPUT_FORMAT + '"}}}}'
    );
  } catch (e) {}
}

function connectEdge() {
  const url =
    WS_URL_BASE +
    '?Ocp-Apim-Subscription-Key=' + TRUSTED_CLIENT_TOKEN +
    '&Sec-MS-GEC=' + secMsGecToken() +
    '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION +
    '&ConnectionId=' + crypto.randomUUID().replace(/-/g, '');

  const ws = new WebSocket(url, {
    headers: {
      'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
    },
  });

  const conn = { ws, busy: false, closed: false, everOpen: false, request: null, idleTimer: null };

  const failRequest = (err) => {
    const req = conn.request;
    conn.request = null;
    conn.busy = false;
    if (req && !req.done) { req.done = true; clearTimeout(req.timer); req.reject(err); }
  };

  conn.ready = new Promise((resolve, reject) => {
    ws.on('open', () => {
      conn.everOpen = true;
      sendConfig(conn);
      resolve();
    });
    ws.on('unexpected-response', (_req, res) => {
      conn.closed = true;
      if (warmConn === conn) warmConn = null;
      reject(new Error('HTTP ' + res.statusCode));
    });
    ws.on('error', (e) => {
      conn.closed = true;
      if (warmConn === conn) warmConn = null;
      clearIdle(conn);
      failRequest(e instanceof Error ? e : new Error(String(e)));
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    ws.on('close', () => {
      conn.closed = true;
      if (warmConn === conn) warmConn = null;
      clearIdle(conn);
      failRequest(new Error('connection closed'));
    });
    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
  });
  conn.ready.catch(() => {});

  return conn;
}

function onMessage(conn, data, isBinary) {
  const req = conn.request;
  if (!req || req.done) return;
  try {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let audio = buf;
      // Protocol (naya endpoint): frame = [2-byte header-length BE][headers][audio payload].
      // Headers mein 'Path:audio' hota hai; payload turant headers ke baad shuru (koi blank line nahi).
      if (buf.length > 4) {
        const headerLen = buf.readUInt16BE(0);
        if (headerLen > 0 && headerLen <= 2048 && buf.length >= 2 + headerLen) {
          const headerEnd = 2 + headerLen;
          if (buf.slice(2, headerEnd).toString('latin1').indexOf(PATH_AUDIO_MARK) !== -1) {
            audio = buf.slice(headerEnd);
          }
        }
      }
      if (audio && audio.length) { req.parts.push(audio); req.bytes += audio.length; }
      return;
    }
    const text = data.toString();
    if (text.indexOf('Path:turn.end') !== -1) {
      req.done = true;
      clearTimeout(req.timer);
      if (conn.request === req) conn.request = null;
      conn.busy = false;
      scheduleIdle(conn);
      req.resolve(Buffer.concat(req.parts));
    }
  } catch (e) {
    if (!req.done) {
      req.done = true;
      clearTimeout(req.timer);
      if (conn.request === req) conn.request = null;
      conn.busy = false;
      req.reject(e);
    }
  }
}

function synthOnConn(conn, text, voiceName, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (conn.closed) return reject(new Error('connection closed'));
    if (!conn.everOpen) return reject(new Error('connection not open'));
    if (conn.busy || conn.request) return reject(new Error('connection busy'));

    conn.busy = true;
    clearIdle(conn);

    const req = { parts: [], bytes: 0, resolve, reject, timer: null, done: false };
    conn.request = req;

    req.timer = setTimeout(() => {
      try { conn.ws.terminate ? conn.ws.terminate() : conn.ws.close(); } catch (e) {}
      const r = conn.request;
      conn.request = null;
      conn.busy = false;
      if (r && !r.done) { r.done = true; r.reject(new Error('synth timeout')); }
    }, timeoutMs);
    if (req.timer.unref) req.timer.unref();

    const ts = new Date().toISOString();
    const lang = voiceName.indexOf('hi-IN') === 0 ? 'hi-IN' : 'en-IN';
    const ssml =
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + lang + "'>" +
      "<voice name='" + voiceName + "'>" +
      "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" + escapeXml(text) + '</prosody>' +
      '</voice></speak>';

    try {
      conn.ws.send(
        'X-RequestId:' + crypto.randomUUID().replace(/-/g, '') + '\r\n' +
        'Content-Type:application/ssml+xml\r\n' +
        'X-Timestamp:' + ts + '\r\n' +
        'Path:ssml\r\n\r\n' + ssml
      );
    } catch (e) {
      const r = conn.request;
      conn.request = null;
      conn.busy = false;
      if (r && !r.done) { r.done = true; clearTimeout(r.timer); r.reject(e); }
    }
  });
}

function acquireConn() {
  if (warmConn && warmConn.everOpen && !warmConn.closed && !warmConn.busy && !warmConn.request) {
    return { conn: warmConn, temp: false };
  }
  const c = connectEdge();
  if (!warmConn || warmConn.closed) {
    warmConn = c;
    return { conn: c, temp: false };
  }
  return { conn: c, temp: true };
}

async function synthOnce(text, voiceName, openMs, turnMs) {
  const { conn, temp } = acquireConn();
  try {
    if (!conn.everOpen) await withTimeout(conn.ready, openMs, 'ws open timeout');
    const buf = await synthOnConn(conn, text, voiceName, turnMs);
    if (!buf || buf.length < MIN_AUDIO_BYTES) throw new Error('empty audio');
    return buf;
  } finally {
    if (temp) { try { conn.ws.close(); } catch (e) {} }
  }
}

async function synthEdge(text, voiceName) {
  const start = Date.now();
  const TOTAL_BUDGET = 9000; // Vercel function time limit (~10s) ke andar rehne ke liye

  try {
    // Attempt 1: open 2.6s / turn 3.4s — flaky network pe jaldi pata chale taaki retry ka waqt bache.
    const b = await synthOnce(text, voiceName, 2600, 3400);
    if (b) return b;
  } catch (e) {
    console.error('speak attempt 1 failed:', (e && e.message) || e);
  }

  try {
    if (warmConn) {
      const c = warmConn;
      warmConn = null;
      c.closed = true;
      try { c.ws.terminate(); } catch (e) {}
    }
  } catch (e) {}

  const remain = TOTAL_BUDGET - (Date.now() - start);
  if (remain < 2600) return null; // retry ke liye kaafi waqt nahi bacha

  await sleep(900);

  const remain2 = Math.max(2600, TOTAL_BUDGET - (Date.now() - start));
  const open2 = Math.max(1400, Math.min(3000, remain2 - 2300));
  const turn2 = Math.max(1400, Math.min(3200, remain2 - open2 - 300));
  try {
    const b = await synthOnce(text, voiceName, open2, turn2);
    if (b) return b;
  } catch (e) {
    console.error('speak attempt 2 failed:', (e && e.message) || e);
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const clean = String(body.text == null ? '' : body.text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (clean.length < 1) {
      return res.status(400).json({ error: 'Text required' });
    }

    const voiceKey = body.voice === 'male' ? 'male' : 'female';
    const isHindi = /[\u0900-\u097F]/.test(clean);
    const voiceName = VOICE_MAP[voiceKey][isHindi ? 'hi' : 'en'];

    const buf = await synthEdge(clean, voiceName);

    if (!buf || buf.length < MIN_AUDIO_BYTES) {
      return res.status(502).json({ error: 'TTS failed, use device voice' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (error) {
    console.error('Speak API Error:', (error && error.message) || error);
    return res.status(502).json({ error: 'TTS failed, use device voice' });
  }
}
