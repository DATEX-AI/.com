import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, otp, token } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanOtp = String(otp || '').trim();

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    if (!/^[0-9]{6}$/.test(cleanOtp)) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }
    if (token.length > 2000) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }

    const secret = process.env.OTP_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'OTP not configured (OTP_SECRET missing)' });
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }
    const [payload, sig] = parts;

    const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest();
    const gotSig = Buffer.from(sig, 'hex');
    if (gotSig.length !== expectedSig.length || !crypto.timingSafeEqual(gotSig, expectedSig)) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }

    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (e) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }

    if (!data || data.e !== cleanEmail) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }
    if (!data.exp || Date.now() > data.exp) {
      return res.status(401).json({ error: 'OTP expired. Resend karo.' });
    }

    const hash = crypto.createHash('sha256').update(cleanOtp + ':' + cleanEmail + ':' + secret).digest();
    const want = Buffer.from(data.h, 'hex');
    if (want.length !== hash.length || !crypto.timingSafeEqual(want, hash)) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Verify OTP Error:', error);
    return res.status(500).json({ error: 'Failed to verify OTP' });
  }
}
