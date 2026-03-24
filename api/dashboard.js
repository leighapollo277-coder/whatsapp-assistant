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
const RP_ID = process.env.VERCEL_URL ? new URL('https://' + process.env.VERCEL_URL).hostname : 'localhost';
const RP_NAME = 'AI Assistant Dashboard';
const ORIGIN = process.env.VERCEL_URL ? `https://whatsapp-assistant-mu.vercel.app` : 'http://localhost:3000';

module.exports = async (req, res) => {
  const { action } = req.query;

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
        await redis.set('webauthn:credential:admin', JSON.stringify(registrationInfo), 'EX', 3600 * 24 * 365);
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
          transports: credential.authenticatorSelection?.transports,
        }],
        userVerification: 'preferred',
      });
      await redis.set('webauthn:challenge:admin', options.challenge, 'EX', 300);
      return res.status(200).json(options);
    }

    if (action === 'verify-authentication') {
      const expectedChallenge = await redis.get('webauthn:challenge:admin');
      const credentialData = await redis.get('webauthn:credential:admin');
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
        // Simple session management
        const sessionId = Math.random().toString(36).substring(2);
        await redis.set(`session:${sessionId}`, 'admin', 'EX', 3600);
        res.setHeader('Set-Cookie', `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
        return res.status(200).json({ verified: true });
      }
      return res.status(400).json({ error: 'Authentication failed' });
    }

    if (action === 'get-data') {
      const sessionId = req.cookies?.session_id || req.headers.authorization?.split(' ')[1];
      if (!sessionId || !(await redis.get(`session:${sessionId}`))) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Fetch from Google Sheets
      const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        ['https://www.googleapis.com/auth/spreadsheets.readonly']
      );
      const sheets = google.sheets({ version: 'v4', auth });
      const spreadsheetId = await redis.get('system:google_sheet_id');
      
      if (!spreadsheetId) return res.status(200).json({ data: [] });

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1!A2:G100', // Fetch latest 100 rows
      });

      const rows = response.data.values || [];
      const data = rows.map(r => ({
        timestamp: r[0],
        original: r[1],
        refined: r[2],
        category: r[3],
        tasks: r[4],
        calLink: r[5],
        status: r[6]
      })).reverse(); // Newest first

      return res.status(200).json({ data });
    }

    return res.status(404).send('Not Found');
  } catch (err) {
    console.error('Dashboard API Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
