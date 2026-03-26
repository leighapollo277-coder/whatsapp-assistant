const express = require('express');
const bodyParser = require('body-parser');
const { parse } = require('querystring');
const Redis = require('ioredis');
const { processRequest, processDeepDive } = require('./api/lib/processor');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

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
  res.status(200).json({ status: 'ok', uptime: process.uptime(), redis: !!redis });
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
    await processRequest(body, messagingClient, null, config, redis);
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

    await processRequest(payload, messagingClient, null, config, redis);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Telegram Error]', err.message);
    res.status(200).json({ ok: true });
  }
});

/**
 * 4. Dashboard API
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

// Start Server
app.listen(port, () => {
  console.log(`🚀 Assistant Server running at http://localhost:${port}`);
  console.log(`📡 WhatsApp Hook: /api/webhook`);
  console.log(`📡 Telegram Hook: /api/telegram`);
});
