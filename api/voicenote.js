const axios = require('axios');
const { google } = require('googleapis');
const Redis = require('ioredis');
const { processRequest } = require('./lib/processor');
const { TelegramMessagingClient } = require('./lib/messaging');

// Initialize Redis client
const redis = process.env.KV_REDIS_URL ? new Redis(process.env.KV_REDIS_URL, {
  connectTimeout: 10000,
  maxRetriesPerRequest: 0,
  retryStrategy: (times) => Math.min(times * 50, 2000)
}) : null;

if (redis) {
  redis.on('error', (err) => console.error('[Redis Voicenote Error]', err.message));
}

/**
 * Dedicated Endpoint for @voicenote_hell_bot
 * Focus: Voice-to-Notes and Voice-to-Tasks strictly via Redis.
 */
module.exports = async (req, res) => {
  console.log('--- Voicenote Bot Webhook Triggered ---');

  try {
    // Use VOICENOTE_BOT_TOKEN for this dedicated bot
    const BOT_TOKEN = (process.env.VOICENOTE_BOT_TOKEN || '').trim();
    const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
    
    // Auth for optional Google Tasks (if eventually requested)
    const GOOGLE_SERVICE_ACCOUNT_EMAIL = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
    const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').trim();

    if (!BOT_TOKEN || !GEMINI_API_KEY) {
      console.error('Missing configuration keys for Voicenote Bot');
      return res.status(200).send('Configuration error');
    }

    if (!redis) {
      console.error('CRITICAL: Missing KV_REDIS_URL');
      return res.status(200).send('Redis error');
    }

    const body = req.body;
    if (!body || (!body.message && !body.channel_post)) {
      return res.status(200).send('No message found');
    }

    const message = body.message || body.channel_post;
    const chatId = message.chat.id.toString();
    const messagingClient = new TelegramMessagingClient(BOT_TOKEN, chatId);

    // Normalize payload for processor
    const payload = {
      Body: message.text || message.caption || "",
      From: chatId,
      To: "voicenote_bot",
      MediaUrl0: null,
      MediaContentType0: null,
      platform: 'telegram',
      isMock: body.isMock === true // Allow test script to bypass media download
    };

    // Handle Voice
    if (message.voice) {
      payload.MediaUrl0 = message.voice.file_id;
      payload.MediaContentType0 = 'audio/ogg';
    } else if (message.audio) {
      payload.MediaUrl0 = message.audio.file_id;
      payload.MediaContentType0 = message.audio.mime_type || 'audio/mpeg';
    }

    const BodyText = payload.Body;
    const cleanBody = BodyText.trim().toLowerCase();

    // 1. Handle Commands
    if (cleanBody === '/start') {
      await messagingClient.sendText("🎙️ 歡迎使用語音筆記助手 (@voicenote_hell_bot)！\n\n直接傳送語音訊息，我會為你記錄成筆記，並自動提取當中的任務。所有內容將安全儲存在 Redis。\n\n輸入 /queue 查看正在處理的任務，輸入 /list 查看最近筆記。");
      return res.status(200).send('OK');
    }

    if (cleanBody === '/list' || cleanBody === '查下有咩筆記') {
      const redisListKey = `notes:${chatId}`;
      const recentNotes = await redis.lrange(redisListKey, 0, 9);
      if (recentNotes.length === 0) {
        await messagingClient.sendText("📋 目前沒有筆記內容。");
        return res.status(200).send('OK');
      }
      const listStr = recentNotes.map((n, i) => {
        const item = JSON.parse(n);
        const taskTag = (item.tasks && item.tasks.length > 0) ? ` (🔨 ${item.tasks.length} 個任務)` : "";
        return `${i + 1}. [${item.category}] ${item.refined}${taskTag}`;
      }).join('\n\n');
      await messagingClient.sendText(`📋 最近的 10 條筆記：\n\n${listStr}`);
      return res.status(200).send('OK');
    }

    if (cleanBody === '/queue') {
      const pendingCodes = await redis.smembers('retry:pending');
      const nowHK = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
      
      const userTasks = [];
      for (const code of pendingCodes) {
        const rawData = await redis.get(`retry:task:${code}`);
        if (!rawData) continue;
        const task = JSON.parse(rawData);
        if (task.platform === 'telegram' && task.From === chatId) userTasks.push({ code, task });
      }

      if (userTasks.length === 0) {
        await messagingClient.sendText(`📋 你目前沒有正在處理的任務。\n(現在時間：${nowHK})`);
        return res.status(200).send('OK');
      }
      
      let msg = `📋 你目前共有 ${userTasks.length} 個重試任務：\n(現在時間：${nowHK})\n`;
      userTasks.forEach(({ code, task }, i) => {
        const nextRunTime = task.nextRun ? new Date(task.nextRun).toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false }) : '未知';
        msg += `\n${i + 1}. 編號：${code} (待播：${nextRunTime})`;
      });
      msg += `\n\n💡 輸入 "CANCEL [編號]" 取消任務。`;
      await messagingClient.sendText(msg);
      return res.status(200).send('OK');
    }

    // 2. Process Request via Shared Processor
    // We pass a dummy tasksApi for now as Google Tasks sync is "no need"
    const procConfig = { 
      GEMINI_API_KEY,
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY
    };

    try {
      const procResult = await processRequest(payload, messagingClient, null, procConfig, redis, true, false);
      
      if (procResult.handled && !procResult.result) {
        const isVoice = payload.MediaContentType0 && (payload.MediaContentType0.includes('audio') || payload.MediaContentType0.includes('video'));
        if (isVoice) {
          const voiceCode = `v_vn_${Date.now()}`;
          await redis.set(`retry:task:${voiceCode}`, JSON.stringify({
            ...payload,
            taskType: 'voice-note-extract', // Specific task type
            platform: 'telegram',
            queuedAt: Date.now(),
            nextRun: Date.now() + 2000
          }), 'EX', 3600);
          await redis.sadd('retry:pending', voiceCode);
        }
      }
    } catch (err) {
      console.error('Voicenote Bot Processing Error:', err.message);
      await messagingClient.sendText(`❌ 處理失敗: ${err.message}`);
    }

    return res.status(200).send('OK');

  } catch (globalError) {
    console.error('VOICENOTE BOT GLOBAL ERROR:', globalError.message);
    return res.status(200).send('Internal Error');
  }
};
