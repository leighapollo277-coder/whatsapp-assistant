const axios = require('axios');
const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs');
const FormData = require('form-data');
const cheerio = require('cheerio');
const googleTTS = require('google-tts-api'); // Use existing dependency

let GEMINI_API_KEY = ""; // Module-level key initialized in processRequest
const DEPLOY_TIME = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });

// Helper: Global (Model, Key) Priority Ordering
// Deprecated: Logic moved inside callGeminiApi rotation

// Helper: Shorten URL using is.gd
async function shortenUrl(longUrl) {
  try {
    const response = await axios.get(`https://is.gd/create.php?format=json&url=${encodeURIComponent(longUrl)}`, { timeout: 5000 });
    return response.data.shorturl || longUrl;
  } catch (err) {
    console.error('URL Shortening Failed:', err.message);
    return longUrl;
  }
}

// Helper: Generate and send voice message (Male Cantonese - Hobby Plan Optimized)
async function generateAndSendVoice(text, messagingClient, statusPrefix = "🎙️ 正在準備廣東話語音總結...", isLink = false, partLabel = "") {
  try {
    if (!text) return false;

    // Handle status message skipping if statusPrefix is null
    if (statusPrefix) {
      const fullStatus = partLabel ? `${statusPrefix} (${partLabel})` : statusPrefix;
      await messagingClient.sendText(fullStatus);
    }

    const cleanText = String(text)
      .replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '')
      .replace(/[\[\]#*]/g, '')
      .trim();

    console.log(`[generateAndSendVoice] Text: ${cleanText.substring(0, 100)}...`);

    // Strict limit for individual segments to avoid 10s timeout
    const charLimit = isLink ? 1000 : 700;
    const finalCleanText = cleanText.substring(0, charLimit);

    if (finalCleanText.length < 5) return false;

    const tmpAudioPath = `/tmp/v_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`;
    const playbackRate = isLink ? '+40%' : '+20%';
    const synthTimeout = isLink ? 60000 : 30000;

    const tts = new EdgeTTS({
      voice: 'zh-HK-WanLungNeural', // Male Cantonese
      lang: 'zh-HK',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      rate: playbackRate,
      pitch: '-5%',
      timeout: synthTimeout,
      saveSubtitles: false
    });

    try {
      await Promise.race([
        tts.ttsPromise(finalCleanText, tmpAudioPath),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), synthTimeout))
      ]);
    } catch (ttsErr) {
      console.warn(`TTS Failed (${isLink ? 'Link' : 'Cmd'}):`, ttsErr.message);
      // Last resort fallback
      return false;
    }

    if (fs.existsSync(tmpAudioPath) && fs.statSync(tmpAudioPath).size > 500) {
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      const catboxFileName = `v_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`;
      form.append('fileToUpload', fs.createReadStream(tmpAudioPath), { filename: catboxFileName });

      const uploadResp = await axios.post('https://catbox.moe/user/api.php', form, {
        headers: form.getHeaders(), timeout: 15000
      });
      const mediaUrl = String(uploadResp.data).trim();
      if (mediaUrl.startsWith('http')) {
        const now = new Date().toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
        const caption = partLabel ? `🎙️ ${partLabel} [${now}]` : `🎙️ [${now}]`;
        await messagingClient.sendVoice(mediaUrl, caption);
        try { fs.unlinkSync(tmpAudioPath); } catch (e) { }
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('generateAndSendVoice Error:', err.message);
    return false;
  }
}

// Helper: Split text into chunks for TTS
function chunkText(text, length = 800) {
  if (!text) return [];
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= length) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('。', length);
    if (splitIdx === -1) splitIdx = remaining.lastIndexOf('\n', length);
    if (splitIdx === -1) splitIdx = length;
    chunks.push(remaining.substring(0, splitIdx + 1).trim());
    remaining = remaining.substring(splitIdx + 1).trim();
  }
  return chunks;
}

// Helper: Upload to Catbox for permanent photo backup

// Helper: Upload to Catbox for permanent photo backup
async function uploadToCatbox(buffer, mimeType, filename) {
  const FormData = require('form-data');
  const axios = require('axios');
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', buffer, { filename: filename, contentType: mimeType });
    const response = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 15000
    });
    console.log(`Successfully uploaded photo to Catbox: ${response.data}`);
    return response.data;
  } catch (err) {
    console.error('Catbox Upload Failed:', err.message);
    return null;
  }
}

// Helper: Centralized Gemini API Call with v1/v1beta fallback
async function callGeminiApi(models, prompt, keysString, mediaData = null, tools = null, onRetry = null, redis = null) {
  // 1. Deduplicate and clean keys
  const apiKeys = [...new Set(keysString.split(',')
    .map(k => k.trim().replace(/^"|"$/g, ''))
    .filter(k => k.length > 5))];

  const modelList = Array.isArray(models) ? models : [models];
  const totalAttempts = modelList.length * apiKeys.length;
  const auditTrail = [];
  const startTime = Date.now();

  console.log(`[callGeminiApi] Starting rotation: ${modelList.length} models, ${apiKeys.length} unique keys.`);

  // 2. Initial Round-Robin offset
  let keyOffset = Math.floor(Math.random() * apiKeys.length);

  for (let mIdx = 0; mIdx < modelList.length; mIdx++) {
    const model = modelList[mIdx];

    for (let kIdx = 0; kIdx < apiKeys.length; kIdx++) {
      // Apply offset for round-robin
      const actualKIdx = (kIdx + keyOffset) % apiKeys.length;
      const key = apiKeys[actualKIdx];
      const keyShort = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;

      // 3. Check Cumulative Timeout (45s)
      if (Date.now() - startTime > 45000) {
        throw new Error(`[callGeminiApi] Global timeout reached after ${auditTrail.length} attempts.`);
      }

      // 4. Check Redis Health Status
      if (redis) {
        const status = await redis.get(`key_status:${model}:${key}`);
        if (status && status.startsWith('FAILED')) {
          const [, timestamp] = status.split(':');
          const elapsed = Date.now() - parseInt(timestamp);
          if (elapsed < 1800000) { // 30 min cooldown
            console.log(`[callGeminiApi] Skipping ${model} with Key ${actualKIdx + 1} (In Cooldown)`);
            continue;
          }
        }
      }

      if (onRetry && (mIdx > 0 || kIdx > 0)) {
        await onRetry(`正在嘗試 ${model} (金鑰 #${actualKIdx + 1})...`);
      }

      let geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

      // 5. Build Generic Payload
      const payloadContents = { text: prompt };
      const parts = [payloadContents];

      if (mediaData) {
        // mediaData can be a Google-format object or a base64 string/buffer
        if (typeof mediaData === 'string' || Buffer.isBuffer(mediaData)) {
          // Assume it's voice if it's a buffer/string and we are in voice context? 
          // Better to let caller pass the exact structure but here we handle common cases.
          parts.push({ inline_data: { mime_type: 'audio/mp3', data: mediaData.toString('base64') } });
        } else {
          parts.push(mediaData);
        }
      }

      const payload = { contents: [{ parts }] };
      if (tools) payload.tools = tools;

      console.log(`[callGeminiApi] Attempt ${auditTrail.length + 1}: ${model} | Key #${actualKIdx + 1}`);

      try {
        const response = await axios.post(geminiUrl, payload, {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' }
        });

        const data = response.data;

        // 6. Safety Filter Detection (200 OK but blocked)
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason === 'SAFETY') {
          console.warn(`[callGeminiApi] BLOCKED by safety filters on ${model}`);
          throw { response: { status: 403, data: { error: { message: "Content blocked by safety filters" } } } };
        }

        if (!candidate?.content) {
          throw new Error("Empty response content from Gemini.");
        }

        console.log(`[callGeminiApi] SUCCESS with ${model} (Key #${actualKIdx + 1})`);
        if (redis) await redis.set(`key_status:${model}:${key}`, `WORKING:${Date.now()}`, 'EX', 3600);

        return data;

      } catch (err) {
        const status = err.response?.status;
        const errMsg = err.response?.data?.error?.message || err.message;
        console.warn(`[callGeminiApi] FAILED: ${model} | Key #${actualKIdx + 1} | HTTP ${status || 'ERR'} | ${errMsg}`);

        auditTrail.push({ model, keyIndex: actualKIdx + 1, status, error: errMsg });

        // Update Redis Health on failure
        if (redis && (status === 429 || (status >= 500 && status < 600))) {
          await redis.set(`key_status:${model}:${key}`, `FAILED:${Date.now()}`, 'EX', 1800);
        }

        // Region/Model Not Found Fallback (or Tool Discrepancy)
        if (status === 404 || status === 400) {
          console.warn(`⚠️ [callGeminiApi] ${model} ${status} on v1beta, trying v1 fallback...`);
          let v1Url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`;

          // CRITICAL: Many v1 endpoints do not support 'tools' (Google Search)
          const v1Payload = { contents: payload.contents };

          try {
            const v1Res = await axios.post(v1Url, v1Payload, { timeout: 15000 });
            if (v1Res.data.candidates?.[0]?.content) {
              console.log(`[callGeminiApi] SUCCESS with ${model} (v1 fallback, Key #${actualKIdx + 1})`);
              if (redis) {
                await redis.set(`key_status:${model}:${key}`, `WORKING:${Date.now()}`, 'EX', 3600);
              }
              return v1Res.data;
            } else {
              throw new Error("Empty response content from Gemini (v1 fallback).");
            }
          } catch (v1Err) {
            const v1Status = v1Err.response?.status;
            const v1Msg = v1Err.response?.data?.error?.message || v1Err.message || "";
            console.error(`[callGeminiApi] v1 Fallback FAILED: ${model} | HTTP ${v1Status || 'ERR'} | ${v1Msg}`);
          }
        }

        // If it's a 400 (Bad Request) or 403 (Safety), don't keep trying this specific prompt with other keys
        if (status === 400 || status === 403) {
          throw new Error(`Gemini Error: ${errMsg}`);
        }

        // Continue to next key for 429 or 5xx
        continue;
      }
    }
  }

  throw new Error(`All attempts exhausted. Tried ${auditTrail.length} combinations. Last error: ${auditTrail[auditTrail.length - 1]?.error || 'Unknown'}`);
}

/**
 * Core Processing Logic
 */
async function processRequest(payload, messagingClient, tasksApi, config, redis, skipVoice = false, skipText = false, cachedResult = null) {
  // Initialize module-level GEMINI_API_KEY for all helpers
  GEMINI_API_KEY = config?.geminiKey || process.env.GEMINI_API_KEY || "";

  const { Body, From, MediaUrl0, MediaContentType0, platform } = payload;
  const GOOGLE_TASK_LIST_ID = (config.GOOGLE_TASK_LIST_ID || "").trim();
  const GOOGLE_SERVICE_ACCOUNT_EMAIL = (config.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  const GOOGLE_PRIVATE_KEY = (config.GOOGLE_PRIVATE_KEY || "").trim();
  const GOOGLE_SHEET_ID = (config.GOOGLE_SHEET_ID || "").trim();

  // Google Auth for Sheets is no longer needed; focusing on Redis as Primary Database.

  // 1. Handle Image (Fact-Check)
  // 1. Handle Image (Fact-Check)
  if (MediaUrl0 && MediaContentType0 && MediaContentType0.includes('image')) {
    // 1. Send immediate processing feedback
    console.log(`Processing image from ${From}`);
    await messagingClient.sendText(`🖼️ 收到圖片！正在進行事實查核... ⏳\n\n(💤 提示：初次使用如需喚醒系統，可能會有 60 秒延遲。)\n📦 版本：${DEPLOY_TIME}`);
    
    // Instead of processing in-line, return for background queue
    // We already send a 1s delay and feedback above.
    return { handled: true, imageUrl: MediaUrl0, imageMime: MediaContentType0 };
  }

  // 2. Handle Text (Commands, URL, or Confirmation)
  if (Body) {
    // 2.0 Check for /clear_cache command
    if (Body.trim().toLowerCase() === '/clear_cache') {
      if (redis) {
        const keys = await redis.keys('*');
        const prefixes = ['retry:', `learning_state:${From}:`, `latest_learning_state_id:${From}`, `voice_session:${From}`, 'key_status:'];
        let deleted = 0;
        for (const key of keys) {
          if (prefixes.some(p => key.startsWith(p))) {
            await redis.del(key);
            deleted++;
          }
        }
        await messagingClient.sendText(`✅ 系統緩存已清除 (共 ${deleted} 個項目)。您可以開始新的測試。`);
        return { handled: true };
      }
    }
    // A. Detect Global Intent for Text Commands (e.g. "Check my tasks", "Delete last")
    // Skip command detection if it's very likely just a URL-only link share to save AI rps
    const isLikelyPlainUrl = Body.trim().match(/^https?:\/\/[^\s]+$/);
    let intentData = { intent: 'NEW_NOTE' };

    if (!isLikelyPlainUrl) {
      const intentPrompt = `分析以下文字內容並判斷用戶意圖。
內容：${Body}

意圖定義：
- LIST_NOTES: 用戶想查看、查詢或閱讀之前的筆記/任務。（例如：「查下有咩筆記」、「Show my tasks」）
- MODIFY_NOTE: 用戶想刪除、更改或更新之前的筆記。（例如：「刪除最後一條」、「CANCEL 1234」）
- NEW_NOTE: 其他（包含網頁連結分享或新筆記寫作）

JSON Output: { "intent": "INTENT_NAME", "action": "動作（如 DELETE）" }`;

      try {
        const intentResp = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY.split(',')[0].trim()}`, {
          contents: [{ parts: [{ text: intentPrompt }] }]
        }, { timeout: 8000 });
        const intentText = intentResp.data.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
        intentData = JSON.parse(intentText);
      } catch (e) { /* ignore and treat as new note */ }
    }

    if (intentData.intent === 'LIST_NOTES') {
      const redisListKey = `notes:${From}`;
      const recentNotes = redis ? await redis.lrange(redisListKey, 0, 9) : [];
      if (recentNotes.length === 0) {
        await messagingClient.sendText("📋 目前沒有筆記內容。");
        return { handled: true };
      }
      const listStr = recentNotes.map((n, i) => {
        const item = JSON.parse(n);
        return `${i + 1}. [${item.category}] ${item.refined}`;
      }).join('\n\n');
      await messagingClient.sendText(`📋 最近的筆記：\n\n${listStr}`);
      return { handled: true };
    }

    if (intentData.intent === 'MODIFY_NOTE' && intentData.action === 'DELETE') {
      const redisListKey = `notes:${From}`;
      const globalKey = 'notes:all';
      const lastNote = redis ? await redis.lindex(redisListKey, 0) : null;
      if (lastNote) {
        await redis.lpop(redisListKey);
        await redis.lrem(globalKey, 1, lastNote);
        await messagingClient.sendText("🗑️ 已成功刪除最近的一條筆記。");
        return { handled: true };
      }
    }

    // B. Link check (Always check if media is NOT a voice message)
    const isVoice = MediaContentType0 && (MediaContentType0.includes('audio') || MediaContentType0.includes('video'));
    if (!isVoice) {
      const urlMatch = Body.match(/(https?:\/\/[^\s]+)/);
      if (urlMatch) {
        const targetUrl = urlMatch[0];
        await messagingClient.sendText(`📖 正在為您讀取網頁內容並準備導讀... 請稍候 ⏳\n📦 版本：${DEPLOY_TIME}`);
        return { handled: true, linkUrl: targetUrl };
      }
    }

    // C. Handle Learning Deep-Dive (Regex for 1-9 or "ID [1-9]")
    const deepDiveMatch = Body.trim().match(/^(\d{4}\s+)?([1-9])$/);
    if (redis && deepDiveMatch) {
      let menuId = deepDiveMatch[1] ? deepDiveMatch[1].trim() : null;
      const selection = parseInt(deepDiveMatch[2], 10);

      if (!menuId) {
        menuId = await redis.get(`latest_learning_state_id:${From}`);
      }

      if (menuId) {
        const stateData = await redis.get(`learning_state:${From}:${menuId}`);
        if (stateData) {
          const state = JSON.parse(stateData);
          if (state.keywords && state.keywords[selection - 1]) {
            const keyword = state.keywords[selection - 1];
            await messagingClient.sendText(`📌 正在深入解析「${keyword}」... ⏳`);
            await processDeepDive(keyword, state.context, From, messagingClient, config, redis, skipVoice, skipText);
            return { handled: true };
          }
        }
      }
    }
  }

  // 3. Handle Voice / Drafting Session
  const sessionKey = `voice_session:${From}`;
  const sessionData = redis ? await redis.get(sessionKey) : null;
  const session = sessionData ? JSON.parse(sessionData) : null;

  // A. Handle Confirmation (User says "OK", "確定", "可以", etc.)
  if (session && Body && /^(ok|okay|可以|確定|确认|好|得|冇問題|無問題)$/i.test(Body.trim())) {
    await messagingClient.sendText("✅ 收到！正在為您整理並儲存至管理後台... ⏳");

    // Extract Metadata (Category, Tasks)
    const nowHK = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });
    const extractionPrompt = `分析以下內容並提取元數據。TRADITIONAL CHINESE only. 
內容：${session.currentDraft}
JSON Output: {
  "refined": "對內容進行潤飾（廣東話口語化）",
  "category": "分類（例如：工作、生活、財務、學習）",
  "tasks": ["任務1", "任務2"]
}
Current Time: ${nowHK}`;

    const models = ['gemini-flash-lite-latest', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash-latest'];
    let extractionResult = null;

    try {
      const extractionResponse = await callGeminiApi(models, extractionPrompt, GEMINI_API_KEY, null, null, null, redis);
      extractionResult = extractionResponse.candidates?.[0]?.content?.parts?.[0]?.text;
    } catch (e) {
      console.error(`Extraction error:`, e.message);
    }

    if (extractionResult) {
      const jsonMatch = extractionResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const metadata = JSON.parse(jsonMatch[0]);
        const noteData = {
          id: `note_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          timestamp: nowHK,
          original: session.originalTranscription,
          refined: metadata.refined,
          category: metadata.category,
          tasks: metadata.tasks || [],
          status: 'New'
        };

        if (redis) {
          await redis.lpush(`notes:${From}`, JSON.stringify(noteData));
          await redis.lpush('notes:all', JSON.stringify({ ...noteData, from: From }));
          await redis.ltrim('notes:all', 0, 999);
        }

        await messagingClient.sendText(`🎉 已成功儲存！\n\n📌 分類：${metadata.category}\n📝 潤飾：${metadata.refined}`);
        await redis.del(sessionKey);
      }
    }
    return { handled: true };
  }

  // B. Handle New Voice or Voice Edit
  if (MediaUrl0 && MediaContentType0 && (MediaContentType0.includes('audio') || MediaContentType0.includes('video'))) {
    console.log(`Processing voice message from ${From}`);
    await messagingClient.sendText("🎙️ 收到語音！正在轉換為文字並分析... ⏳\n\n(💤 提示：初次使用如需喚醒系統，可能會有 60 秒延遲。)");

    const buffer = await messagingClient.downloadMedia(MediaUrl0);

    // Transcribe or Refine
    let transcriptionPrompt = "";
    if (!session) {
      transcriptionPrompt = `請將這段語音轉錄為繁體中文文本。如果是廣東話，請保留口語表達。`;
    } else {
      transcriptionPrompt = `參考之前的草稿：『${session.currentDraft}』。
現在用戶提供了新的語音指令，請根據新指令「修改」或「補充」現有草稿。
返回最新的完整內容版本（繁體中文）。`;
    }

    const models = ['gemini-flash-lite-latest', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash-latest'];
    let transcription = null;

    try {
      console.log(`🎙️ Attempting transcription with centralized rotation...`);
      const mediaData = { inline_data: { mime_type: MediaContentType0, data: buffer.toString("base64") } };
      const transcriptionResp = await callGeminiApi(models, transcriptionPrompt, GEMINI_API_KEY, mediaData, null, null, redis);

      const transcriptionText = transcriptionResp.candidates[0].content.parts[0].text.trim();
      if (!transcriptionText) throw new Error("未能識別語音內容。");

      // Detect Intent (NEW_NOTE, LIST_NOTES, MODIFY_NOTE)
      const intentPrompt = `分析以下語音轉錄內容並判斷用戶意圖。
內容：${transcriptionText}

可能的意圖：
- LIST_NOTES: 用戶想查看、查詢或閱讀之前的筆記/任務。（例如：「幫我查下琴日寫咗咩」、「有咩未做」、「讀返最近嗰幾條俾我聽」）
- MODIFY_NOTE: 用戶想刪除、更改或更新之前的筆記。（例如：「刪除最後嗰條」、「頭先嗰個改返做聽日」、「頭先講錯咗，唔好要」）
- NEW_NOTE: 用戶正在記錄新的想法、任務或筆記。（所有不屬於上述兩者的內容）

JSON Output: { "intent": "INTENT_NAME", "query": "關鍵字（如果是查詢）", "action": "動作（如果是修改，如 DELETE, UPDATE）" }`;

      let intentData = { intent: 'NEW_NOTE' };
      try {
        const intentResp = await callGeminiApi(['gemini-2.0-flash'], intentPrompt, GEMINI_API_KEY, null, null, null, redis);
        const intentText = intentResp.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
        intentData = JSON.parse(intentText);
      } catch (e) {
        console.error('Intent Detection Error:', e.message);
      }

      // --- CASE 1: LIST_NOTES ---
      if (intentData.intent === 'LIST_NOTES') {
        const redisListKey = `notes:${From}`;
        const recentNotes = redis ? await redis.lrange(redisListKey, 0, 9) : [];
        if (recentNotes.length === 0) {
          await messagingClient.sendText("📋 目前沒有筆記內容。");
          return { handled: true };
        }
        const listStr = recentNotes.map((n, i) => {
          const item = JSON.parse(n);
          return `${i + 1}. [${item.category}] ${item.refined}`;
        }).join('\n\n');

        const summaryPrompt = `這是我最近的筆記內容。請用廣東話口語簡短地為我總結這 ${recentNotes.length} 條記錄，像是在跟我對話一樣。
內容：
${listStr}`;
        const summaryResp = await callGeminiApi(['gemini-2.0-flash'], summaryPrompt, GEMINI_API_KEY, null, null, null, redis);
        const audioSummary = summaryResp.candidates[0].content.parts[0].text.trim();

        await messagingClient.sendText(`📋 最近的筆記：\n\n${listStr}`);
        await generateAndSendVoice(audioSummary, messagingClient, "🎙️ 正在為您朗讀筆記總結...");
        return { handled: true };
      }

      // --- CASE 2: MODIFY_NOTE ---
      if (intentData.intent === 'MODIFY_NOTE' && intentData.action === 'DELETE') {
        const redisListKey = `notes:${From}`;
        const globalKey = 'notes:all';
        const lastNote = redis ? await redis.lindex(redisListKey, 0) : null;
        if (lastNote) {
          await redis.lpop(redisListKey);
          await redis.lrem(globalKey, 1, lastNote);
          await messagingClient.sendText("🗑️ 已成功刪除最近的一條筆記。");
          return { handled: true };
        }
      }

      // --- CASE 3: NEW_NOTE ---
      await messagingClient.sendText(`📝 識別內容：\n"${transcriptionText}"`);
      transcription = transcriptionText;
    } catch (e) {
      console.error('Transcription/Processing Error:', e.message);
      throw new Error("語音轉錄失敗，請稍後再試。");
    }

    if (!transcription) throw new Error("語音轉錄失敗，請稍後再試。");

    if (!session) {
      // Create new session
      const newSession = {
        status: 'awaiting_confirmation',
        originalTranscription: transcription,
        currentDraft: transcription,
        lastUpdated: Date.now()
      };
      await redis.set(sessionKey, JSON.stringify(newSession), 'EX', 1800); // 30 min expiry
      await messagingClient.sendText(`我聽到的是：\n\n「${transcription}」\n\n✅ 如果正確，請回覆「OK」或「可以」。\n🎙️ 如果需要修改，請直接發送新的語音指令。\n❌ 如果要取消，請回覆「CANCEL」。`);
    } else {
      // Update session
      session.currentDraft = transcription;
      session.lastUpdated = Date.now();
      await redis.set(sessionKey, JSON.stringify(session), 'EX', 1800);
      await messagingClient.sendText(`已根據您的要求修改為：\n\n「${transcription}」\n\n✅ 確認請回覆「OK」，或繼續發送語音修改。`);
    }
    return { handled: true };
  }

  // C. Handle Cancel
  if (session && Body && /^(cancel|取消|唔要|唔使|刪除|刪除草稿)$/i.test(Body.trim())) {
    await redis.del(sessionKey);
    await messagingClient.sendText("🗑️ 已取消目前的草稿。");
    return { handled: true };
  }

  return { handled: false };
}

// Helper: Process Link Summary (Fact-Check Style)
async function processLink(targetUrl, From, messagingClient, config, redis, cachedResult = null) {
  try {
    await messagingClient.sendText(`🌐 收到網頁！正在讀取並分析全文... ⏳\n\n(💤 提示：初次使用如需喚醒系統，可能會有 60 秒延遲。)\n📦 版本：${DEPLOY_TIME}`);
    // Initialize module-level GEMINI_API_KEY if not already set or if config provides a new one
    if (config?.GEMINI_API_KEY) {
      GEMINI_API_KEY = config.GEMINI_API_KEY;
    } else if (config?.geminiKey) {
      GEMINI_API_KEY = config.geminiKey;
    }

    if (!GEMINI_API_KEY) {
      GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    }

    const models = ['gemini-flash-lite-latest', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-002', 'gemini-1.5-pro-latest'];
    const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));
    let finalContent = null;
    let successModel = null;

    if (cachedResult) {
      console.log('♻️ Using cached Link result.');
      finalContent = cachedResult;
      successModel = 'CACHED';
    } else {
      const webResponse = await axios.get(targetUrl, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' }, validateStatus: false });
      if (webResponse.status !== 200) throw new Error(`無法存取網頁 (HTTP ${webResponse.status})`);

      const $ = cheerio.load(webResponse.data);
      $('script, style, nav, footer, header, .ads, #sidebar').remove();
      const title = $('title').text().trim() || '網頁內容';
      const paragraphs = [];
      $('p, div.post-body, .article-content, section').each((i, el) => {
        const txt = $(el).text().trim();
        if (txt.length > 30) paragraphs.push(txt);
      });

      let rawText = paragraphs.slice(0, 40).join('\n\n').trim();
      console.log(`[processLink] Extracted ${paragraphs.length} blocks. Paragraph length: ${rawText.length}`);

      if (rawText.length < 200) {
        console.warn('[processLink] Low paragraph count, falling back to body text.');
        rawText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 10000);
      }

      const combinedText = `標題：${title}\n\n${rawText}`.substring(0, 15000);
      console.log(`[processLink] Final combinedText length: ${combinedText.length}`);

      if (combinedText.length < 50) {
        throw new Error("未能從網頁提取足夠內容。可能是動態加載或存取被拒。");
      }

      const prompt = `你是一個專業的內容提取與教育助手。請對輸入內容進行全文提取與解析。
輸出必須嚴格包含以下兩個部分，並使用指定的分隔符號隔開：

【第一部分：全文內容】
1. 請提取並整理網頁的「完整中文內容」。
2. 如果原文是英文，請將其全文翻譯成地道的繁體中文（廣東話風格或正式書面語皆可）。
3. 移除所有廣告、導航、無關雜訊。
4. 返回整理後的純文本內容。

--- 延伸閱讀 ---
【第二部分：關鍵字菜單】
請從上述解析中提取 9 個值得深入了解的關鍵字或概念，並以純數字編號列表：
1. [關鍵字A]
...
9. [關鍵字I]

CRITICAL: TRADITIONAL CHINESE only. 請全程使用香港廣東話口語 (Hong Kong Colloquial Cantonese) 進行整理與翻譯，嚴禁使用書面語。
內容如下：
${combinedText}`;

      // Using centralized callGeminiApi with rotation
      const geminiResponse = await callGeminiApi(models, prompt, GEMINI_API_KEY, null, null, null, redis);
      finalContent = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text;
      if (finalContent) {
        successModel = "Gemini";
      }
    }

    if (!finalContent) throw new Error("未能生成網頁總結。");

    // Split logic
    const readingRegex = /---+\s*延伸閱讀\s*---+/;
    let fullTextPart = finalContent;
    let menuPart = "";

    if (readingRegex.test(finalContent)) {
      const parts = finalContent.split(readingRegex);
      fullTextPart = parts[0].replace(/【第一部分：全文內容】/, '').trim();
      menuPart = parts[1].trim();
    }

    // 1. Generate Voice for Entire Article (Chunked)
    const voiceChunks = chunkText(fullTextPart, 500);
    console.log(`Link Reading: Generated ${voiceChunks.length} voice chunks.`);

    if (voiceChunks.length > 0) {
      await messagingClient.sendText("🎙️ 正在生成全文語音導讀... ⏳");
    }

    for (let i = 0; i < voiceChunks.length; i++) {
      const label = voiceChunks.length > 1 ? `第 ${i + 1} 部分` : "";
      // Pass null for statusPrefix to skip redundant per-chunk status messages
      await generateAndSendVoice(voiceChunks[i], messagingClient, null, true, label);
      if (i < voiceChunks.length - 1) await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // 2. Save Menu for Keyword Deep-Dive (4-Digit ID)
    if (redis && menuPart) {
      const keywords = [];
      const lines = menuPart.split('\n');
      for (const line of lines) {
        const match = line.match(/^\d+[\.\、]\s*(.+)$/);
        if (match) keywords.push(match[1].trim().replace(/[\*\[\]]/g, ''));
      }
      if (keywords.length > 0) {
        const menuId = Math.floor(1000 + Math.random() * 9000).toString();
        const menuState = { keywords, context: fullTextPart.substring(0, 500) };
        await redis.set(`learning_state:${From}:${menuId}`, JSON.stringify(menuState), 'EX', 86400); // 24h
        await redis.set(`latest_learning_state_id:${From}`, menuId, 'EX', 86400);

        await messagingClient.sendText(`📖 內容提取完畢 (已發送語音)\n\n📌 [#${menuId}] 回覆數字深入學習，或輸入「${menuId} 數字」回顧舊話題：\n\n${menuPart}`);
      }
    }

    return { handled: true, result: finalContent };
  } catch (err) {
    console.error('ProcessLink Err:', err.message);
    await messagingClient.sendText(`❌ 導讀失敗: ${err.message}`);
    return { handled: false };
  }
}

/**
 * Helper: Process Image Fact-Check In Background
 */
async function processImage(imageUrl, imageMime, From, messagingClient, config, redis, cachedResult = null) {
  try {
    // 1. Initialize API Key
    if (config?.GEMINI_API_KEY) {
      GEMINI_API_KEY = config.GEMINI_API_KEY;
    } else if (config?.geminiKey) {
      GEMINI_API_KEY = config.geminiKey;
    }
    if (!GEMINI_API_KEY) {
      GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    }

    // 2. Download Media
    const imgBuffer = await messagingClient.downloadMedia(imageUrl);
    
    const models = [
      'gemini-flash-lite-latest',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash-latest',
      'gemini-1.5-flash-002',
      'gemini-1.5-pro-latest'
    ];

    const prompt = `你是一個專業的事實查核與教育助手。請對輸入內容進行深度分析，輸出必須嚴格包含以下三個部分，並使用指定的分隔符號隔開：

【第一部分：事實查核】
1. **結論**：[真實 / 虛假 / 誤導 / 有待核實]
2. **信心分數**：(標註 0-1)
3. **簡潔摘要**：用 2-3 句話總結發現。
4. **查核證據**：列出 2-3 個關鍵事實，並附上完整的來源網址 (URL)。這些來源網址對於信任度至關重要，必須提供。

--- 知識點解析 ---
【第二部分：教育解析】
請用簡單易懂的廣東話口語或書面語，解釋這件事背後的科學、歷史 or 社會知識點，幫助用戶學習新知識。

--- 延伸閱讀 ---
【第三部分：關鍵字菜單】
請從上述解析中提取 9 個值得深入了解的關鍵字或概念，並以純數字編號列表：
1. [關鍵字A]
...
9. [關鍵字I]

CRITICAL: TRADITIONAL CHINESE only. 必須使用香港廣東話口語，嚴禁使用書面語（例如用「係」唔好用「是」，用「佢地」唔好用「他們」）。Use Google Search grounding.`;

    let factCheckResult = null;
    let successModel = null;

    if (cachedResult) {
      console.log('♻️ Using cached Gemini result.');
      factCheckResult = cachedResult;
      successModel = 'CACHED';
    } else {
      const mediaData = { inline_data: { mime_type: imageMime, data: imgBuffer.toString('base64') } };
      const geminiResponse = await callGeminiApi(models, prompt, GEMINI_API_KEY, mediaData, [{ google_search: {} }], async (msg) => {
        try { await messagingClient.sendText(`🤖 [系統提示] ${msg} ⏳`); } catch (e) { }
      }, redis);

      factCheckResult = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text;
      if (factCheckResult) {
        successModel = "Gemini";
      }
    }

    if (!factCheckResult) throw new Error('事實查核失敗 (Gemini 沒回應)');

    console.log(`✅ Fact-check successful using ${successModel}`);

    // Shorten URLs
    const foundUrls = factCheckResult.match(/(https?:\/\/[^\s\)]+)/g) || [];
    for (const longUrl of [...new Set(foundUrls)]) {
      const short = await shortenUrl(longUrl);
      factCheckResult = factCheckResult.split(longUrl).join(short);
    }

    // Split logic
    let factCheckPart = factCheckResult;
    let explanationPart = "";
    let menuPart = "";
    const analysisRegex = /---+\s*知識點解析\s*---+/;
    const readingRegex = /---+\s*延伸閱讀\s*---+/;

    if (analysisRegex.test(factCheckResult)) {
      const parts = factCheckResult.split(analysisRegex);
      factCheckPart = parts[0].trim();
      const remainder = parts[1].trim();
      if (readingRegex.test(remainder)) {
        const subParts = remainder.split(readingRegex);
        explanationPart = subParts[0].trim();
        menuPart = subParts[1].trim();
      } else {
        explanationPart = remainder;
      }
    }

    // 1. Send Text
    const CHUNK_SIZE = 1500;
    for (let i = 0; i < factCheckResult.length; i += CHUNK_SIZE) {
      await messagingClient.sendText(`💡 事實查核與解析：\n\n${factCheckResult.substring(i, i + CHUNK_SIZE)}`);
    }

    // 2. Send Voice (Chunked for Full Result)
    if (factCheckPart) {
        await messagingClient.sendText("🎙️ 正在生成查核結果語音導讀... ⏳");
        const voiceChunks = chunkText(factCheckPart, 500);
        for (let i = 0; i < voiceChunks.length; i++) {
            const label = voiceChunks.length > 1 ? `第 ${i+1} 部分` : "";
            await generateAndSendVoice(voiceChunks[i], messagingClient, null, false, label);
            if (i < voiceChunks.length - 1) await new Promise(r => setTimeout(r, 1500));
        }
    }
    
    if (explanationPart) {
        await messagingClient.sendText("🎙️ 正在生成深度解析語音... ⏳");
        const voiceChunks = chunkText(explanationPart, 500);
        for (let i = 0; i < voiceChunks.length; i++) {
            const label = voiceChunks.length > 1 ? `解析 第 ${i+1} 部分` : "";
            await generateAndSendVoice(voiceChunks[i], messagingClient, null, false, label);
            if (i < voiceChunks.length - 1) await new Promise(r => setTimeout(r, 1500));
        }
    }

    // 3. Save Menu
    if (redis && menuPart) {
      const keywords = [];
      const lines = menuPart.split('\n');
      for (const line of lines) {
        const match = line.match(/^\d+[\.\、]\s*(.+)$/);
        if (match) keywords.push(match[1].trim().replace(/[\*\[\]]/g, ''));
      }
      if (keywords.length > 0) {
        const menuId = Math.floor(1000 + Math.random() * 9000).toString();
        const menuState = { keywords, context: factCheckPart.substring(0, 500) };
        await redis.set(`learning_state:${From}:${menuId}`, JSON.stringify(menuState), 'EX', 86400); // 24h
        await redis.set(`latest_learning_state_id:${From}`, menuId, 'EX', 86400);
        await messagingClient.sendText(`📌 [#${menuId}] 回覆數字深入學習，或輸入「${menuId} 數字」回顧舊話題。`);
      }
    }

    return { handled: true, result: factCheckResult };
  } catch (err) {
    console.error('ProcessImage Err:', err.message);
    await messagingClient.sendText(`❌ 查核失敗: ${err.message}`);
    return { handled: false };
  }
}

async function processDeepDive(keyword, context, From, messagingClient, config, redis, skipVoice = false, skipText = false, cachedResult = null) {
  // Initialize module-level GEMINI_API_KEY
  if (config?.GEMINI_API_KEY) {
    GEMINI_API_KEY = config.GEMINI_API_KEY;
  } else if (config?.geminiKey) {
    GEMINI_API_KEY = config.geminiKey;
  }

  if (!GEMINI_API_KEY) {
    GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
  }

  const models = [
    'gemini-flash-lite-latest',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro-latest'
  ];

  const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));

  const prompt = `你是一個專業的教育助手。用戶對以下主題中的「${keyword}」感興趣，請為他進行深入淺出的解析。
前情提要：${context}

輸出必須嚴格包含以下兩個部分，並使用指定的分隔符號隔開：

【第一部分：深度解析】
請用簡單易懂的廣東話口語或書面語，詳細解釋「${keyword}」的概念、運作原理或相關歷史。

--- 延伸閱讀 ---
【第二部分：關鍵字菜單】
請從你的解析中提取 9 個值得進一步了解的子關鍵字或新概念，並以純數字編號列表：
1. [子關鍵字A]
2. [子關鍵字B]
...

CRITICAL: TRADITIONAL CHINESE only.`;

  try {
    let result = null;
    let successModel = null;

    if (cachedResult) {
      console.log('♻️ Using cached Deep Dive result for consistency.');
      result = cachedResult;
      successModel = 'CACHED';
    } else {
      const geminiResponse = await callGeminiApi(models, prompt, GEMINI_API_KEY, null, null, async (msg) => {
        try { await messagingClient.sendText(`🤖 [系統提示] ${msg} ⏳`); } catch (e) { }
      }, redis);
      result = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text;
      if (result) {
        successModel = "Gemini";
      }
    }

    if (!result) {
      throw new Error("All models failed or returned empty.");
    }

    let explanationPart = result;
    let menuPart = "";

    if (result.includes('--- 延伸閱讀 ---')) {
      const parts = result.split('--- 延伸閱讀 ---');
      explanationPart = parts[0].trim();
      menuPart = parts[1].trim();
    }

    if (!skipText) {
      const CHUNK_SIZE = 1500;
      for (let i = 0; i < result.length; i += CHUNK_SIZE) {
        await messagingClient.sendText(`📚 ${keyword} 深度解析：\n\n${result.substring(i, i + CHUNK_SIZE)}`);
      }
    }

    if (!skipVoice && explanationPart) await generateAndSendVoice(explanationPart, messagingClient, "🎙️ 正在生成深度解析語音...");

    if (redis && menuPart) {
      const keywords = [];
      const lines = menuPart.split('\n');
      for (const line of lines) {
        const match = line.match(/^\d+[\.\、]\s*(.+)$/);
        if (match) keywords.push(match[1].trim().replace(/[\*\[\]]/g, ''));
      }
      if (keywords.length > 0) {
        const menuId = Math.floor(1000 + Math.random() * 9000).toString();
        const menuState = { keywords, context: explanationPart.substring(0, 500) };
        await redis.set(`learning_state:${From}:${menuId}`, JSON.stringify(menuState), 'EX', 86400); // 24h
        await redis.set(`latest_learning_state_id:${From}`, menuId, 'EX', 86400);

        if (!skipText) {
          await messagingClient.sendText(`📌 [#${menuId}] 回覆數字深入學習，或輸入「${menuId} 數字」回顧舊話題。`);
        }
      }
    }
    return { handled: true, result };
  } catch (error) {
    console.error('Deep Dive Error:', error.message);
    if (!skipText) await messagingClient.sendText("❌ 深入解析時發生錯誤，請稍後再試。");
    return false;
  }
}

module.exports = {
  shortenUrl,
  generateAndSendVoice,
  processRequest,
  processLink,
  processDeepDive,
  callGeminiApi
};
