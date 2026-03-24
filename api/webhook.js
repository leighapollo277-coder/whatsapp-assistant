const twilio = require('twilio');
const axios = require('axios');
const { google } = require('googleapis');
const { parse } = require('querystring');
const Redis = require('ioredis');
const { processRequest, processDeepDive } = require('./lib/processor');

// Initialize Redis client once outside the handler
const redis = process.env.KV_REDIS_URL ? new Redis(process.env.KV_REDIS_URL, {
  connectTimeout: 10000, // 10s
  maxRetriesPerRequest: 0,
  retryStrategy: (times) => Math.min(times * 50, 2000)
}) : null;

if (redis) {
  redis.on('error', (err) => console.error('[Redis Core Error]', err.message));
}

module.exports = async (req, res) => {
  console.log('--- Webhook Triggered ---');

  // Passive Trigger for Retry Queue (Lazy Background Task)
  if (redis) {
    (async () => {
      try {
        const lastTrigger = await redis.get('retry:last_passive_trigger');
        const now = Date.now();
        if (!lastTrigger || (now - parseInt(lastTrigger, 10)) > 55000) {
          await redis.set('retry:last_passive_trigger', now.toString());
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const host = req.headers['host'];
          // Fire and forget - trigger the self-cron via internal request
          axios.get(`${protocol}://${host}/api/retry-cron`).catch(() => {});
        }
      } catch (e) {}
    })();
  }
  
  try {
    // 1. Initial configuration check
    const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
    const GOOGLE_SERVICE_ACCOUNT_EMAIL = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
    const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').trim();
    const GOOGLE_TASK_LIST_ID = (process.env.GOOGLE_TASK_LIST_ID || '@default').trim();

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !GEMINI_API_KEY || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
      return res.status(200).send('<Response><Message>⚠️ Configuration error: Missing API keys.</Message></Response>');
    }

    if (!redis) {
      console.error('CRITICAL: Missing KV_REDIS_URL');
      return res.status(200).send('<Response><Message>⚠️ Configuration error: Missing Redis URL.</Message></Response>');
    }

    // 2. Parse body
    let body = req.body;
    if (typeof body === 'string') body = parse(body);
    else if (Buffer.isBuffer(body)) body = parse(body.toString());
    
    // Ensure we have all fields for logging/processing
    const { Body, From, To, MediaUrl0, MediaContentType0 } = body;
    const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // 3. Handle Commands (CANCEL, /queue, /photo)
    if (Body) {
      const cleanBody = Body.trim().toLowerCase();
      
      // Handle /queue
      if (cleanBody === '/queue') {
        const pendingCodes = await redis.smembers('retry:pending');
        const nowHK = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
        
        if (pendingCodes.length === 0) {
          return res.status(200).send(`<Response><Message>📋 目前隊列是空的。\n(現在時間：${nowHK})</Message></Response>`);
        }
        
        let msg = `📋 目前共有 ${pendingCodes.length} 個重試任務：\n(現在時間：${nowHK})\n`;
        for (let i = 0; i < pendingCodes.length; i++) {
          const code = pendingCodes[i];
          const rawData = await redis.get(`retry:task:${code}`);
          if (!rawData) continue;
          const task = JSON.parse(rawData);
          const nextRunTime = task.nextRun ? new Date(task.nextRun).toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false }) : '未知';
          msg += `\n${i + 1}. 編號：${code} (待播：${nextRunTime})`;
        }
        msg += `\n\n💡 輸入 "CANCEL [編號]" 或 "/photo [編號]"。`;
        return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
      }

      // Handle /photo [CODE]
      if (cleanBody.startsWith('/photo ')) {
        const code = Body.trim().split(' ')[1];
        const rawData = await redis.get(`retry:task:${code}`);
        if (!rawData) return res.status(200).send(`<Response><Message>❌ 找不到任務編號：${code}</Message></Response>`);
        
        const task = JSON.parse(rawData);
        if (task.MediaUrl0) {
          await twilioClient.messages.create({
            from: To, to: From,
            body: `📸 任務編號 ${code} 的相片：\n如無法顯示，請按連結：${task.MediaUrl0}`,
            mediaUrl: [task.MediaUrl0]
          });
          return res.status(200).send('<Response></Response>');
        } else {
          return res.status(200).send(`<Response><Message>⚠️ 編號 ${code} 不包含圖片附件。</Message></Response>`);
        }
      }

      // Handle CANCEL
      if (cleanBody.startsWith('cancel ')) {
        const query = Body.trim().toUpperCase().replace('CANCEL ', '').trim();
        
        if (query === 'ALL') {
          const pendingCodes = await redis.smembers('retry:pending');
          if (pendingCodes.length === 0) {
            return res.status(200).send(`<Response><Message>📋 目前沒有需要取消的任務。</Message></Response>`);
          }
          for (const code of pendingCodes) {
            await redis.del(`retry:task:${code}`);
          }
          await redis.del('retry:pending');
          return res.status(200).send(`<Response><Message>✅ 已清除所有重試任務（共 ${pendingCodes.length} 個）。</Message></Response>`);
        } else {
          const code = query;
          const taskKey = `retry:task:${code}`;
          const taskData = await redis.get(taskKey);
          
          if (taskData) {
            await redis.del(taskKey);
            await redis.srem('retry:pending', code);
            return res.status(200).send(`<Response><Message>✅ 已取消任務編號：${code}</Message></Response>`);
          } else {
            return res.status(200).send(`<Response><Message>❌ 找不到任務編號：${code}</Message></Response>`);
          }
        }
      }
    }

    // 3.5 Handle Interactive Learning / Deep Dive
    const cleanNumBody = Body.trim();
    if (/^[1-9]$/.test(cleanNumBody)) {
      try {
        const stateStr = await redis.get(`learning_state:${From}`);
        if (stateStr) {
          const state = JSON.parse(stateStr);
          const choiceIdx = parseInt(cleanNumBody, 10) - 1;
          
          if (state.keywords && choiceIdx >= 0 && choiceIdx < state.keywords.length) {
            const keyword = state.keywords[choiceIdx];
            const context = state.context || "";
            
            await redis.del(`learning_state:${From}`);
            
            await twilioClient.messages.create({ from: To, to: From, body: `📚 正在為您深入解析「${keyword}」... 請稍候 ⏳` });
            
            const config = { GEMINI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN };
            const { handled, result: diveResult } = await processDeepDive(keyword, context, From, To, twilioClient, config, redis, true, false); // skipVoice: true, skipText: false
            
            // Queue for background audio (Idempotent: use SmsSid)
            const sid = body.SmsSid || body.MessageSid || `rand_${Math.floor(1000 + Math.random() * 9000)}`;
            const voiceCode = `v_${sid}`;
            await redis.set(`retry:task:${voiceCode}`, JSON.stringify({
              taskType: 'voice-deep-dive',
              keyword, context, From, To,
              cachedResult: diveResult,
              queuedAt: Date.now(),
              nextRun: Date.now() + 5000 // Run almost immediately in next cron
            }), 'EX', 3600);
            await redis.sadd('retry:pending', voiceCode);

            return res.status(200).send('<Response></Response>');
          }
        }
      } catch (err) {
        console.error('Deep Dive Interceptor Error:', err.message);
      }
    }

    // 4. Auth & Processor Config
    let formattedKey = GOOGLE_PRIVATE_KEY.includes('\\n') ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : GOOGLE_PRIVATE_KEY;
    if (!formattedKey.includes('-----BEGIN PRIVATE KEY-----')) {
      formattedKey = `-----BEGIN PRIVATE KEY-----\n${formattedKey}\n-----END PRIVATE KEY-----`;
    }
    const auth = new google.auth.JWT({ 
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL, key: formattedKey, 
      scopes: ['https://www.googleapis.com/auth/tasks'] 
    });
    const tasksApi = google.tasks({ version: 'v1', auth });
    const config = { GEMINI_API_KEY, GOOGLE_TASK_LIST_ID, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN };

    // 5. [DELETED] Passive Retry (Removed to rely on external heartbeat)

    // 6. Run Processor with In-Request Active Retry
    const isImage = body.MediaUrl0 && body.MediaContentType0 && body.MediaContentType0.includes('image');
    if (isImage) {
      await twilioClient.messages.create({ from: To, to: From, body: "正在利用 Google Search 進行深度事實分析... 請稍候 ⏳" });
    }

    let handled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 1;
    let nextDelay = 15000; 

    while (attempts < MAX_ATTEMPTS) {
      try {
        const procResult = await processRequest(body, twilioClient, tasksApi, config, redis, true, false); // skipVoice: true, skipText: false
        
        if (procResult.linkUrl) {
          // Queue for web-link (Bilingual translation)
          const sid = body.SmsSid || body.MessageSid || `link_${Date.now()}`;
          const linkCode = `v_${sid}`;
          await redis.set(`retry:task:${linkCode}`, JSON.stringify({
            taskType: 'web-link',
            linkUrl: procResult.linkUrl, From, To,
            queuedAt: Date.now(),
            nextRun: Date.now() + 2000 
          }), 'EX', 3600);
          await redis.sadd('retry:pending', linkCode);
          handled = true;
        } else if (procResult.handled) {
          // Queue for background audio (Idempotent: use SmsSid)
          const sid = body.SmsSid || body.MessageSid || `rand_${Math.floor(1000 + Math.random() * 9000)}`;
          const voiceCode = `v_${sid}`;
          await redis.set(`retry:task:${voiceCode}`, JSON.stringify({
            ...body,
            taskType: 'voice-fact-check',
            cachedResult: procResult.result,
            queuedAt: Date.now(),
            nextRun: Date.now() + 5000 
          }), 'EX', 3600);
          await redis.sadd('retry:pending', voiceCode);
          handled = true;
        }
        break;
      } catch (err) {
        if (err.response?.status === 429 || err.message.includes('429')) {
          attempts++;
          const errorMsg = err.response?.data?.error?.message || err.message || "";
          console.warn(`[Active Retry] 429 Hit: "${errorMsg}". Attempt ${attempts}/${MAX_ATTEMPTS}`);
          
          const retryMatch = errorMsg.match(/after\s*(\d+)\s*s/i) || errorMsg.match(/after\s*(\d+)\s*seconds/i);
          if (retryMatch) {
            nextDelay = parseInt(retryMatch[1], 10) * 1000 + 1000;
          } else {
            nextDelay = 15000 * attempts;
          }
          
          if (attempts < MAX_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, nextDelay));
          } else {
            // --- FALLBACK TO INFINITE EXPONENTIAL QUEUE ---
            // Add a small delay to ensure fallback notifications from processor.js arrive FIRST
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            const taskKey = `retry:task:${code}`;
            const firstRetryTime = Date.now() + (2 * 60 * 1000); // 2 minutes later
            
            const taskState = {
              ...body,
              attempts: 1,
              nextRun: firstRetryTime,
              queuedAt: Date.now()
            };

            await redis.set(taskKey, JSON.stringify(taskState), 'EX', 3600 * 48); // Store for 48h
            await redis.sadd('retry:pending', code);

            const queueCount = await redis.scard('retry:pending');
            const hhmm = new Date(firstRetryTime).toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });

            await twilioClient.messages.create({
              from: To, to: From,
              body: `⚠️ AI 額度暫時用盡。
任務編號：${code}
排程日期：2 分鐘後 (${hhmm})
隊列狀態：還有 ${queueCount} 個任務在等候。
如需取消請回覆：CANCEL ${code}`
            });
            return res.status(200).send('<Response></Response>');
          }
        } else {
          console.error('Processing Error:', err.message);
          return res.status(200).send(`<Response><Message>❌ 處理失敗: ${err.message}</Message></Response>`);
        }
      }
    }

    if (!handled && Body) {
      return res.status(200).send(`<Response><Message>請傳送廣東話語音訊息、網頁連結或圖片進行事實查核！</Message></Response>`);
    }

    return res.status(200).send('<Response></Response>');

  } catch (globalError) {
    console.error('GLOBAL ERROR:', globalError.message);
    return res.status(200).send(`<Response><Message>❌ 系統全域錯誤: ${globalError.message}</Message></Response>`);
  }
};
