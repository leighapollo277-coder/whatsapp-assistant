const axios = require('axios');
const { google } = require('googleapis');
const Redis = require('ioredis');
const { processRequest, processDeepDive } = require('./lib/processor');
const { TelegramMessagingClient } = require('./lib/messaging');

// Initialize Redis client
const redis = process.env.KV_REDIS_URL ? new Redis(process.env.KV_REDIS_URL, {
  connectTimeout: 10000,
  maxRetriesPerRequest: 0,
  retryStrategy: (times) => Math.min(times * 50, 2000)
}) : null;

if (redis) {
  redis.on('error', (err) => console.error('[Redis Telegram Error]', err.message));
}

module.exports = async (req, res) => {
  console.log('--- Telegram Webhook Triggered ---');

  try {
    const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
    const GOOGLE_SERVICE_ACCOUNT_EMAIL = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
    const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').trim();
    const GOOGLE_TASK_LIST_ID = (process.env.GOOGLE_TASK_LIST_ID || '@default').trim();

    if (!TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
      console.error('Missing configuration keys for Telegram');
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
    const messagingClient = new TelegramMessagingClient(TELEGRAM_BOT_TOKEN, chatId);

    // Normalize payload
    const payload = {
      Body: message.text || message.caption || "",
      From: chatId,
      To: "telegram_bot",
      MediaUrl0: null,
      MediaContentType0: null,
      platform: 'telegram'
    };

    if (message.photo && message.photo.length > 0) {
      payload.MediaUrl0 = message.photo[message.photo.length - 1].file_id;
      payload.MediaContentType0 = 'image/jpeg';
    } else if (message.voice) {
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
      await messagingClient.sendText("👋 歡迎使用事實查核與教育助手！\n\n你可以傳送：\n🖼️ 圖片進行事實查核\n🎙️ 語音訊息提取任務或導讀\n🔗 連結進行網頁導讀\n\n輸入 /queue 查看正在處理的任務。");
      return res.status(200).send('OK');
    }

    if (cleanBody === '/queue') {
      const pendingCodes = await redis.smembers('retry:pending');
      const nowHK = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
      
      if (pendingCodes.length === 0) {
        await messagingClient.sendText(`📋 目前隊列是空的。\n(現在時間：${nowHK})`);
        return res.status(200).send('OK');
      }
      
      let msg = `📋 目前共有 ${pendingCodes.length} 個重試任務：\n(現在時間：${nowHK})\n`;
      let count = 0;
      for (let i = 0; i < pendingCodes.length; i++) {
        const code = pendingCodes[i];
        const rawData = await redis.get(`retry:task:${code}`);
        if (!rawData) continue;
        const task = JSON.parse(rawData);
        if (task.platform !== 'telegram' || task.From !== chatId) continue;
        
        count++;
        const nextRunTime = task.nextRun ? new Date(task.nextRun).toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false }) : '未知';
        msg += `\n${count}. 編號：${code} (待播：${nextRunTime})`;
      }

      if (count === 0) {
        await messagingClient.sendText(`📋 你目前沒有正在處理的任務。\n(現在時間：${nowHK})`);
      } else {
        msg += `\n\n💡 輸入 "CANCEL [編號]" 取消任務。`;
        await messagingClient.sendText(msg);
      }
      return res.status(200).send('OK');
    }

    if (cleanBody.startsWith('cancel ')) {
      const query = BodyText.trim().toUpperCase().replace('CANCEL ', '').trim();
      if (query === 'ALL') {
        const pendingCodes = await redis.smembers('retry:pending');
        let count = 0;
        for (const code of pendingCodes) {
          const rawData = await redis.get(`retry:task:${code}`);
          if (!rawData) continue;
          const task = JSON.parse(rawData);
          if (task.platform === 'telegram' && task.From === chatId) {
            await redis.del(`retry:task:${code}`);
            await redis.srem('retry:pending', code);
            count++;
          }
        }
        await messagingClient.sendText(`✅ 已取消你的所有重試任務（共 ${count} 個）。`);
      } else {
        const taskKey = `retry:task:${query}`;
        const taskData = await redis.get(taskKey);
        if (taskData) {
          const task = JSON.parse(taskData);
          if (task.From === chatId) {
            await redis.del(taskKey);
            await redis.srem('retry:pending', query);
            await messagingClient.sendText(`✅ 已取消任務編號：${query}`);
          } else {
            await messagingClient.sendText(`❌ 你沒有權限取消此任務。`);
          }
        } else {
          await messagingClient.sendText(`❌ 找不到任務編號：${query}`);
        }
      }
      return res.status(200).send('OK');
    }

    // 2. Handle Interactive Learning (Numbers 1-9)
    if (/^[1-9]$/.test(cleanBody)) {
      const stateStr = await redis.get(`learning_state:${chatId}`);
      if (stateStr) {
        const state = JSON.parse(stateStr);
        const choiceIdx = parseInt(cleanBody, 10) - 1;
        if (state.keywords && choiceIdx >= 0 && choiceIdx < state.keywords.length) {
          const keyword = state.keywords[choiceIdx];
          const context = state.context || "";
          await redis.del(`learning_state:${chatId}`);
          await messagingClient.sendText(`📚 正在為您深入解析「${keyword}」... 請稍候 ⏳`);
          
          const procConfig = { GEMINI_API_KEY };
          const { handled, result: diveResult } = await processDeepDive(keyword, context, chatId, messagingClient, procConfig, redis, true, false);
          
          const voiceCode = `v_tg_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          await redis.set(`retry:task:${voiceCode}`, JSON.stringify({
            taskType: 'voice-deep-dive',
            platform: 'telegram',
            keyword, context, From: chatId,
            cachedResult: diveResult,
            queuedAt: Date.now(),
            nextRun: Date.now() + 2000
          }), 'EX', 3600);
          await redis.sadd('retry:pending', voiceCode);
          return res.status(200).send('OK');
        }
      }
    }

    // 3. Process Request
    let formattedKey = GOOGLE_PRIVATE_KEY.includes('\\n') ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : GOOGLE_PRIVATE_KEY;
    if (!formattedKey.includes('-----BEGIN PRIVATE KEY-----')) {
      formattedKey = `-----BEGIN PRIVATE KEY-----\n${formattedKey}\n-----END PRIVATE KEY-----`;
    }
    const auth = new google.auth.JWT({ 
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL, key: formattedKey, 
      scopes: ['https://www.googleapis.com/auth/tasks'] 
    });
    const tasksApi = google.tasks({ version: 'v1', auth });
    const procConfig = { 
      GEMINI_API_KEY, 
      GOOGLE_TASK_LIST_ID,
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY,
      GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID || 'primary'
    };

    if (payload.MediaContentType0 && payload.MediaContentType0.includes('image')) {
      await messagingClient.sendText("正在利用 Google Search 進行事實查核... 請稍候 ⏳");
    }

    try {
      const procResult = await processRequest(payload, messagingClient, tasksApi, procConfig, redis, true, false);
      
      if (procResult.linkUrl) {
        const linkCode = `l_tg_${Date.now()}`;
        await redis.set(`retry:task:${linkCode}`, JSON.stringify({
          taskType: 'web-link',
          platform: 'telegram',
          linkUrl: procResult.linkUrl, From: chatId,
          queuedAt: Date.now(),
          nextRun: Date.now() + 1000
        }), 'EX', 3600);
        await redis.sadd('retry:pending', linkCode);
      } else if (procResult.handled) {
        const voiceCode = `v_tg_${Date.now()}`;
        await redis.set(`retry:task:${voiceCode}`, JSON.stringify({
          ...payload,
          taskType: 'voice-fact-check',
          platform: 'telegram',
          cachedResult: procResult.result,
          queuedAt: Date.now(),
          nextRun: Date.now() + 3000
        }), 'EX', 3600);
        await redis.sadd('retry:pending', voiceCode);
      } else if (BodyText) {
        await messagingClient.sendText("請傳送廣東話語音訊息、網頁連結或圖片進行事實查核！");
      }
    } catch (err) {
      if (err.message.includes('429')) {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        const taskKey = `retry:task:${code}`;
        const firstRetryTime = Date.now() + (2 * 60 * 1000);
        await redis.set(taskKey, JSON.stringify({ ...payload, platform: 'telegram', attempts: 1, nextRun: firstRetryTime, queuedAt: Date.now() }), 'EX', 3600 * 48);
        await redis.sadd('retry:pending', code);
        const hhmm = new Date(firstRetryTime).toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
        await messagingClient.sendText(`⚠️ AI 額度暫時用盡。任務編號 ${code} 已排入隊列，將於 ${hhmm} 重試。回覆 CANCEL ${code} 可取消。`);
      } else {
        console.error('Telegram Processing Error:', err.message);
        await messagingClient.sendText(`❌ 處理失敗: ${err.message}`);
      }
    }

    return res.status(200).send('OK');

  } catch (globalError) {
    console.error('TELEGRAM GLOBAL ERROR:', globalError.message);
    return res.status(200).send('Internal Error');
  }
};
