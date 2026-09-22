import crypto from 'crypto';

function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email } = req.body || {};
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(String(email).trim())) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    const cleanEmail = String(email).trim().toLowerCase();
    if (cleanEmail.length > 254) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    // Basic abuse protection: max 1 OTP per email per 30 seconds.
    // NOTE: serverless memory is per-instance, so also set Brevo/Tavily
    // quotas + Firebase App Check for strong protection.
    globalThis.__datexOtpCooldown = globalThis.__datexOtpCooldown || new Map();
    const lastSent = globalThis.__datexOtpCooldown.get(cleanEmail) || 0;
    if (Date.now() - lastSent < 30 * 1000) {
      return res.status(429).json({ error: 'OTP already sent. Please wait 30 seconds.' });
    }

    const secret = process.env.OTP_SECRET;
    const brevoKey = process.env.BREVO_API_KEY;
    if (!secret) {
      return res.status(500).json({ error: 'OTP not configured (OTP_SECRET missing)' });
    }
    if (!brevoKey) {
      return res.status(500).json({ error: 'OTP email not configured (BREVO_API_KEY missing)' });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const iat = Date.now();
    const exp = iat + 10 * 60 * 1000;
    const hash = crypto.createHash('sha256').update(code + ':' + cleanEmail + ':' + secret).digest('hex');
    const payload = b64urlEncode({ e: cleanEmail, h: hash, iat, exp });
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const token = payload + '.' + sig;

    const senderEmail = process.env.BREVO_SENDER_EMAIL || 'datexaisujalkumar@gmail.com';
    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': brevoKey
      },
      body: JSON.stringify({
        sender: { name: 'DATEX AI', email: senderEmail },
        to: [{ email: cleanEmail }],
        subject: 'DATEX AI login code',
        htmlContent: '<p>Your DATEX AI verification code is: <b>' + code + '</b></p><p>Valid for 10 minutes. Do not share it with anyone.</p>',
        textContent: 'Your DATEX AI verification code is: ' + code + '. Valid for 10 minutes. Do not share it with anyone.'
      })
    });

    if (!brevoRes.ok) {
      let detail = '';
      try {
        const errData = await brevoRes.json();
        detail = errData.message || JSON.stringify(errData);
      } catch (e) {
        detail = await brevoRes.text().catch(() => '');
      }
      return res.status(502).json({ error: 'Email failed: ' + detail });
    }

    globalThis.__datexOtpCooldown.set(cleanEmail, Date.now());

    return res.status(200).json({ token, expiresIn: 600 });
  } catch (error) {
    console.error('Send OTP Error:', error);
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
}
