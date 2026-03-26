const Redis = require('ioredis');
const { google } = require('googleapis');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const redis = new Redis(process.env.KV_REDIS_URL);

// --- Configuration ---
// Note: WebAuthn requires a consistent RP_ID. We'll prioritize the production domain.
const PUBLIC_DOMAIN = 'whatsapp-assistant-mu.vercel.app';
const RP_ID = process.env.NODE_ENV === 'production' ? PUBLIC_DOMAIN : 'localhost';
const RP_NAME = 'AI Assistant Dashboard';
const ORIGIN = process.env.NODE_ENV === 'production' ? `https://${PUBLIC_DOMAIN}` : 'http://localhost:3000';

// Helper: Parse cookies manually (Vercel Node.js doesn't provide req.cookies)
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.split('=');
    cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

module.exports = async (req, res) => {
  const { action } = req.query;
  const cookies = parseCookies(req.headers.cookie);

  try {
    if (action === 'generate-registration-options') {
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userID: 'admin',
        userName: 'Admin User',
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'preferred',
        },
      });
      await redis.set('webauthn:challenge:admin', options.challenge, 'EX', 300);
      return res.status(200).json(options);
    }

    if (action === 'verify-registration') {
      const expectedChallenge = await redis.get('webauthn:challenge:admin');
      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });

      if (verification.verified) {
        const { registrationInfo } = verification;
        // Convert to base64 for storage
        const serializableInfo = {
          credentialID: Buffer.from(registrationInfo.credentialID).toString('base64'),
          credentialPublicKey: Buffer.from(registrationInfo.credentialPublicKey).toString('base64'),
          counter: registrationInfo.counter,
          credentialDeviceType: registrationInfo.credentialDeviceType,
          credentialBackedUp: registrationInfo.credentialBackedUp,
        };
        await redis.set('webauthn:credential:admin', JSON.stringify(serializableInfo), 'EX', 3600 * 24 * 365);
        return res.status(200).json({ verified: true });
      }
      return res.status(400).json({ error: 'Registration failed' });
    }

    if (action === 'generate-authentication-options') {
      const credentialData = await redis.get('webauthn:credential:admin');
      if (!credentialData) return res.status(400).json({ error: 'No user registered' });
      
      const credential = JSON.parse(credentialData);
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: [{
          id: credential.credentialID,
          type: 'public-key',
        }],
        userVerification: 'preferred',
      });
      await redis.set('webauthn:challenge:admin', options.challenge, 'EX', 300);
      return res.status(200).json(options);
    }

    if (action === 'verify-authentication') {
      const expectedChallenge = await redis.get('webauthn:challenge:admin');
      const credentialData = await redis.get('webauthn:credential:admin');
      if (!credentialData) throw new Error('No credential stored');
      
      const credential = JSON.parse(credentialData);

      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        authenticator: {
          credentialID: Buffer.from(credential.credentialID, 'base64'),
          credentialPublicKey: Buffer.from(credential.credentialPublicKey, 'base64'),
          counter: credential.counter,
        },
      });

      if (verification.verified) {
        const sessionId = Math.random().toString(36).substring(2);
        await redis.set(`session:${sessionId}`, 'admin', 'EX', 3600);
        res.setHeader('Set-Cookie', `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
        return res.status(200).json({ verified: true });
      }
      return res.status(400).json({ error: 'Authentication failed' });
    }

      if (action === 'get-data') {
        const sessionId = cookies.session_id || req.headers.authorization?.split(' ')[1];
        if (!sessionId || !(await redis.get(`session:${sessionId}`))) {
          return res.status(401).json({ error: 'Unauthorized' });
        }

        // Fetch from Redis
        const notesRaw = await redis.lrange('notes:all', 0, 100);
        const data = notesRaw.map(n => JSON.parse(n));

        return res.status(200).json({ success: true, data });
      }

    return res.status(404).send('Not Found');
  } catch (err) {
    console.error(`Dashboard API Error [${action}]:`, err.message);
    return res.status(500).json({ error: err.message, action });
  }
};
