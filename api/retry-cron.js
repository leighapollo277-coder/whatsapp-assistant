const Redis = require('ioredis');
const twilio = require('twilio');
const { google } = require('googleapis');
const { processRequest, processDeepDive, processLink } = require('./lib/processor');

// Initialize Redis client once outside the handler
const redis = process.env.KV_REDIS_URL ? new Redis(process.env.KV_REDIS_URL, {
  connectTimeout: 10000,
  maxRetriesPerRequest: 0,
  retryStrategy: (times) => Math.min(times * 50, 2000)
}) : null;

if (redis) {
  redis.on('error', (err) => console.error('[Redis Cron Error]', err.message));
}

module.exports = async (req, res) => {
  console.log('--- Infinite Retry Cron Started ---');
  
  const config = {
    TWILIO_ACCOUNT_SID: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
    TWILIO_AUTH_TOKEN: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
    GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
    GOOGLE_SERVICE_ACCOUNT_EMAIL: (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
    GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').trim(),
    GOOGLE_TASK_LIST_ID: (process.env.GOOGLE_TASK_LIST_ID || '@default').trim()
  };

  if (!redis) {
    console.error('CRITICAL: Missing KV_REDIS_URL in Cron');
    return res.status(500).json({ error: 'Missing Redis URL' });
  }

  const twilioClient = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const { TwilioMessagingClient, TelegramMessagingClient } = require('./lib/messaging');
  
  // Auth setup
  let formattedKey = config.GOOGLE_PRIVATE_KEY.includes('\\n') ? config.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : config.GOOGLE_PRIVATE_KEY;
  if (!formattedKey.includes('-----BEGIN PRIVATE KEY-----')) {
    formattedKey = `-----BEGIN PRIVATE KEY-----\n${formattedKey}\n-----END PRIVATE KEY-----`;
  }
  const auth = new google.auth.JWT({ 
    email: config.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: formattedKey, 
    scopes: ['https://www.googleapis.com/auth/tasks'] 
  });
  const tasksApi = google.tasks({ version: 'v1', auth });
  const procConfig = { 
    GEMINI_API_KEY: config.GEMINI_API_KEY.replace(/^"|"$/g, ''), 
    GOOGLE_TASK_LIST_ID: config.GOOGLE_TASK_LIST_ID, 
    TWILIO_ACCOUNT_SID: config.TWILIO_ACCOUNT_SID, 
    TWILIO_AUTH_TOKEN: config.TWILIO_AUTH_TOKEN 
  };

  // 1. Get all pending codes
  const pendingCodes = await redis.smembers('retry:pending');
  let processed = 0;
  
  // 2. Fetch and filter due tasks
  const now = Date.now();
  const dueTasks = [];
  
  for (const code of pendingCodes) {
    const rawPayload = await redis.get(`retry:task:${code}`);
    if (!rawPayload) {
      console.warn(`No payload for code ${code}. Cleaning up.`);
      await redis.srem('retry:pending', code);
      continue;
    }
    
    const taskData = JSON.parse(rawPayload);
    if (!taskData.nextRun || now >= taskData.nextRun) {
      dueTasks.push({ code, task: taskData });
    }
  }

  console.log(`Found ${pendingCodes.length} pending tasks, ${dueTasks.length} are due.`);

  if (dueTasks.length === 0) {
    return res.status(200).json({ status: 'done', processed: 0, message: 'No tasks due' });
  }

  // 3. Sort by queuedAt (oldest first)
  dueTasks.sort((a, b) => (a.task.queuedAt || 0) - (b.task.queuedAt || 0));
  
  let code = null;
  let task = null;

  // 4. Find the first task that we can LOCK to prevent parallel processing
  for (const dt of dueTasks) {
    const lockKey = `lock:task:${dt.code}`;
    const locked = await redis.set(lockKey, '1', 'NX', 'EX', 120); // 2 min lock
    if (locked) {
      code = dt.code;
      task = dt.task;
      console.log(`Locked task ${code} for processing.`);
      break;
    } else {
      console.log(`Task ${dt.code} is already being processed by another worker. Skipping.`);
    }
  }

  if (!code) {
    return res.status(200).json({ status: 'done', processed: 0, message: 'All due tasks are locked by others' });
  }

  const taskKey = `retry:task:${code}`;

  // 5. Instantiate correct messaging client
  const messagingClient = (task.platform === 'telegram')
    ? new TelegramMessagingClient(TELEGRAM_BOT_TOKEN, task.From)
    : new TwilioMessagingClient(twilioClient, task.To, task.From);

  // 6. Process the locked task
  console.log(`Attempting single retry #${task.attempts || 1} for code ${code} (Platform: ${task.platform || 'whatsapp'})...`);
  
  // Notification: Retry Startup (skip for background voice tasks)
  if (!task.taskType?.startsWith('voice-')) {
    try {
      await messagingClient.sendText(`🤖 [系統提示] 任務編號：${code} 正重新嘗試查核... ⏳`);
    } catch (notifyErr) {
      console.error('Retry Start Notification Failed:', notifyErr.message);
    }
  }

  try {
    if (task.taskType === 'voice-fact-check') {
      console.log(`Processing background voice for fact-check ${code}`);
      await processRequest(task, messagingClient, tasksApi, procConfig, redis, false, true, task.cachedResult); // skipVoice: false, skipText: true, cachedResult
      await redis.del(taskKey);
      await redis.srem('retry:pending', code);
      processed++;
    } else if (task.taskType === 'web-link') {
      console.log(`Processing background web-link for ${code}`);
      await processLink(task.linkUrl, task.From, messagingClient, procConfig, redis, task.cachedResult);
      await redis.del(taskKey);
      await redis.srem('retry:pending', code);
      processed++;
    } else if (task.taskType === 'voice-deep-dive') {
      console.log(`Processing background voice for deep-dive ${code}`);
      const { keyword, context } = task;
      await processDeepDive(keyword, context, task.From, messagingClient, procConfig, redis, false, true, task.cachedResult); // skipVoice: false, skipText: true, cachedResult
      await redis.del(taskKey);
      await redis.srem('retry:pending', code);
      processed++;
    } else {
      const result = await processRequest(task, messagingClient, tasksApi, procConfig, redis);
      if (result && result.handled) {
        console.log(`Successfully processed code ${code}.`);
        await redis.del(taskKey);
        await redis.srem('retry:pending', code);
        processed++;
      }
    }
  } catch (err) {
    if (err.response?.status === 429 || err.message.includes('429')) {
      // --- QUOTA 429: Exponential Backoff (Infinite, Capped at 24h) ---
      const attempts = (task.attempts || 1) + 1;
      const delayMin = Math.min(Math.pow(2, attempts), 1440); // 2, 4, 8, 16... capped at 1440m (24h)
      const nextRun = Date.now() + (delayMin * 60 * 1000);
      
      const nextState = { ...task, attempts, nextRun };
      await redis.set(taskKey, JSON.stringify(nextState), 'EX', 3600 * 48); // Store for 48h
      console.log(`Quota still hit for ${code}. Retrying in ${delayMin}m (Attempt #${attempts}).`);

      // Notification: Rescheduling
      try {
        await messagingClient.sendText(`⚠️ [系統提示] 任務編號：${code} 額度仍忙碌中，將在 ${delayMin} 分鐘後再次嘗試。`);
      } catch (notifyErr) {
        console.error('Rescheduling Notification Failed:', notifyErr.message);
      }
    } else {
      // --- FATAL ERROR: Non-429 ---
      console.error(`FATAL error for code ${code}:`, err.message);
      await redis.del(taskKey);
      await redis.srem('retry:pending', code);
      
      try {
        await messagingClient.sendText(`❌ 任務編號：${code} 發生不可修復的錯誤，已停止重新嘗試。\n錯誤訊息：${err.message}`);
      } catch (notifyErr) {}
    }
  }

  return res.status(200).json({ status: 'done', processed, processedCode: code });
};
