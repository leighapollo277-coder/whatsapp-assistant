const express = require('express');
const bodyParser = require('body-parser');
const { parse } = require('querystring');
const Redis = require('ioredis');
const cookieParser = require('cookie-parser');
const { 
  generateRegistrationOptions, 
  verifyRegistrationResponse, 
  generateAuthenticationOptions, 
  verifyAuthenticationResponse 
} = require('@simplewebauthn/server');
const { processRequest, processDeepDive } = require('./api/lib/processor');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// WebAuthn Configuration
const RP_NAME = 'AI Assistant Dashboard';
const RP_ID = process.env.NODE_ENV === 'production' ? 'whatsapp-assistant-ex7w.onrender.com' : 'localhost';
const ORIGIN = process.env.NODE_ENV === 'production' ? `https://${RP_ID}` : `http://localhost:${port}`;

// Initialize Redis 
const redis = process.env.KV_REDIS_URL ? new Redis(process.env.KV_REDIS_URL, {
  connectTimeout: 10000,
  maxRetriesPerRequest: 0,
}) : null;

if (redis) {
  redis.on('error', (err) => console.error('[Redis Core Error]', err.message));
}

// Middleware
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

const twilio = require('twilio');
const { TwilioMessagingClient, TelegramMessagingClient } = require('./api/lib/messaging');

/**
 * Common Config Loader
 */
function getConfig() {
  return {
    geminiKey: process.env.GEMINI_API_KEY || "",
    twilioSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioAuth: process.env.TWILIO_AUTH_TOKEN || "",
    twilioNumber: process.env.TWILIO_NUMBER || "",
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || ""
  };
}

/**
 * 1. Health Check
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok_v4_auth', uptime: process.uptime(), redis: !!redis });
});

/**
 * 2. WhatsApp Webhook (Twilio)
 */
app.post('/api/webhook', async (req, res) => {
  console.log('--- WhatsApp Webhook Triggered ---');
  const body = req.body;
  const config = getConfig();
  
  const twilioClient = twilio(config.twilioSid, config.twilioAuth);
  // Twilio uses From (user) and To (bot number)
  const messagingClient = new TwilioMessagingClient(twilioClient, body.To, body.From);

  try {
    const procResult = await processRequest(body, messagingClient, null, config, redis, true, false);
    
    if (procResult.linkUrl) {
      const sid = body.SmsSid || body.MessageSid || `link_${Date.now()}`;
      const linkCode = `v_${sid}`;
      if (redis) {
        await redis.set(`retry:task:${linkCode}`, JSON.stringify({
          taskType: 'web-link', platform: 'whatsapp',
          linkUrl: procResult.linkUrl, From: body.From, To: body.To,
          queuedAt: Date.now(), nextRun: Date.now() + 2000 
        }), 'EX', 3600);
        await redis.sadd('retry:pending', linkCode);
      }
    } else if (procResult.handled && !procResult.result) {
      const isVoice = body.MediaContentType0 && (body.MediaContentType0.includes('audio') || body.MediaContentType0.includes('video'));
      if (isVoice && redis) {
        const sid = body.SmsSid || body.MessageSid || `v_${Date.now()}`;
        const voiceCode = `v_${sid}`;
        await redis.set(`retry:task:${voiceCode}`, JSON.stringify({
          ...body, taskType: 'voice-fact-check', platform: 'whatsapp',
          queuedAt: Date.now(), nextRun: Date.now() + 5000 
        }), 'EX', 3600);
        await redis.sadd('retry:pending', voiceCode);
      }
    }
    
    res.status(200).send('<Response></Response>');
  } catch (err) {
    console.error('[WhatsApp Error]', err.message);
    res.status(200).send('<Response></Response>');
  }
});

/**
 * 3. Telegram Webhook
 */
app.post('/api/telegram', async (req, res) => {
  console.log('--- Telegram Webhook Triggered ---');
  const body = req.body;
  const config = getConfig();

  // Telegram payload structure check
  const chatId = body.message?.chat?.id || body.callback_query?.message?.chat?.id;
  if (!chatId) {
    return res.status(200).json({ ok: true, msg: 'No chatId' });
  }

  const messagingClient = new TelegramMessagingClient(config.telegramToken, chatId);

  try {
    // Wrap Telegram body into a consistent payload for processor
    const payload = {
      Body: body.message?.text || body.message?.caption || body.callback_query?.data || "",
      From: chatId.toString(),
      MediaUrl0: null, // Processor handles Telegram media internally if needed
      platform: 'telegram'
    };
    
    // Handle Telegram Voice/Photo if present
    if (body.message?.voice) payload.MediaUrl0 = body.message.voice.file_id;
    if (body.message?.photo) payload.MediaUrl0 = body.message.photo[body.message.photo.length - 1].file_id;
    if (body.message?.voice) payload.MediaContentType0 = 'audio/ogg';
    if (body.message?.photo) payload.MediaContentType0 = 'image/jpeg';

    const procResult = await processRequest(payload, messagingClient, null, config, redis, true, false);
    
    if (procResult.linkUrl) {
      const linkCode = `v_tg_${chatId}_${Date.now()}`;
      if (redis) {
        await redis.set(`retry:task:${linkCode}`, JSON.stringify({
          taskType: 'web-link', platform: 'telegram',
          linkUrl: procResult.linkUrl, From: payload.From, To: 'telegram',
          queuedAt: Date.now(), nextRun: Date.now() + 2000 
        }), 'EX', 3600);
        await redis.sadd('retry:pending', linkCode);
      }
    } else if (procResult.handled && !procResult.result) {
      if (body.message?.voice && redis) {
        const voiceCode = `v_tg_${chatId}_${Date.now()}`;
        await redis.set(`retry:task:${voiceCode}`, JSON.stringify({
          ...payload, taskType: 'voice-fact-check', platform: 'telegram',
          queuedAt: Date.now(), nextRun: Date.now() + 5000 
        }), 'EX', 3600);
        await redis.sadd('retry:pending', voiceCode);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Telegram Error]', err.message);
    res.status(200).json({ ok: true });
  }
});

/**
 * 4. Dashboard API & WebAuthn
 */
app.get('/api/dashboard/stats', async (req, res) => {
  if (!redis) return res.status(500).json({ error: 'No Redis' });
  try {
    const keys = await redis.keys('learning_state:*');
    res.json({ sessions: keys.length, status: 'active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/registration-options', async (req, res) => {
  try {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from('admin'),
      userName: 'Admin User',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });
    await redis.set('webauthn:challenge:admin', options.challenge, 'EX', 300);
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dashboard/verify-registration', async (req, res) => {
  try {
    const expectedChallenge = await redis.get('webauthn:challenge:admin');
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (verification.verified) {
      const { registrationInfo } = verification;
      const serializableInfo = {
        credentialID: Buffer.from(registrationInfo.credentialID).toString('base64'),
        credentialPublicKey: Buffer.from(registrationInfo.credentialPublicKey).toString('base64'),
        counter: registrationInfo.counter,
        credentialDeviceType: registrationInfo.credentialDeviceType,
        credentialBackedUp: registrationInfo.credentialBackedUp,
      };
      await redis.set('webauthn:credential:admin', JSON.stringify(serializableInfo), 'EX', 3600 * 24 * 365);
      res.json({ verified: true });
    } else {
      res.status(400).json({ error: 'Registration failed' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/authentication-options', async (req, res) => {
  try {
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
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dashboard/verify-authentication', async (req, res) => {
  try {
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
      res.cookie('session_id', sessionId, { path: '/', httpOnly: true, sameSite: 'strict', maxAge: 3600000 });
      res.json({ verified: true });
    } else {
      res.status(400).json({ error: 'Authentication failed' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/data', async (req, res) => {
  try {
    const sessionId = req.cookies.session_id || req.headers.authorization?.split(' ')[1];
    if (!sessionId || !(await redis.get(`session:${sessionId}`))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch learning notes from Redis
    const notesRaw = await redis.lrange('notes:all', 0, 100);
    const data = notesRaw.map(n => JSON.parse(n));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`🚀 Assistant Server running at http://localhost:${port}`);
  console.log(`📡 WhatsApp Hook: /api/webhook`);
  console.log(`📡 Telegram Hook: /api/telegram`);
});
