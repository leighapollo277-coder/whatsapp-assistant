const axios = require('axios');
const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs');
const FormData = require('form-data');
const cheerio = require('cheerio');
const googleTTS = require('google-tts-api'); // Use existing dependency

let GEMINI_API_KEY = ""; // Module-level key initialized in processRequest

// Helper: Global (Model, Key) Priority Ordering
async function getPrioritizedPairs(models, rawKeys, redis) {
  const pairs = [];
  for (const model of models) {
    for (let i = 0; i < rawKeys.length; i++) {
      pairs.push({ model, key: rawKeys[i], index: i });
    }
  }

  if (!redis) return pairs.map(p => ({ ...p, status: 'UNTRIED', time: 0 }));

  const prioritized = await Promise.all(pairs.map(async p => {
    const rawStatus = await redis.get(`key_status:${p.model}:${p.key}`) || 'UNTRIED:0';
    const [status, timeStr] = rawStatus.split(':');
    const time = parseInt(timeStr, 10) || 0;
    return { ...p, status, time };
  }));

  // Priority: WORKING (0) > UNTRIED (1) > FAILED (2)
  const priorityMap = { 'WORKING': 0, 'UNTRIED': 1, 'FAILED': 2 };
  const modelValue = {
    'gemini-2.0-flash': 100,
    'gemini-1.5-flash': 80,
    'gemini-1.5-flash-002': 70,
    'gemini-1.5-flash-8b': 60,
    'gemini-1.5-pro': 50
  };

  return prioritized.sort((a, b) => {
    if (priorityMap[a.status] !== priorityMap[b.status]) {
      return priorityMap[a.status] - priorityMap[b.status];
    }
    // For WORKING, use MOST RECENT success first (Latest timestamp)
    if (a.status === 'WORKING') return b.time - a.time;
    // For FAILED, use OLDEST failure first (more recovery time)
    if (a.status === 'FAILED') return a.time - b.time;
    // Default: more capable model first
    return (modelValue[b.model] || 0) - (modelValue[a.model] || 0);
  });
}

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
    
    // Add part label to status if provided (e.g. " (第一部分)")
    const fullStatus = partLabel ? `${statusPrefix} (${partLabel})` : statusPrefix;
    if (fullStatus) await messagingClient.sendText(fullStatus);

    const cleanText = String(text)
      .replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '')
      .replace(/[\[\]#*]/g, '')
      .trim();

    console.log(`[generateAndSendVoice] Text: ${cleanText.substring(0, 100)}...`);
    
    // Strict limit for individual segments to avoid 10s timeout
    const charLimit = isLink ? 1000 : 700; 
    const finalCleanText = cleanText.substring(0, charLimit);

    if (finalCleanText.length < 5) return false;

    const tmpAudioPath = `/tmp/v_${Date.now()}_${Math.floor(Math.random()*1000)}.mp3`;
    const playbackRate = isLink ? '+40%' : '+20%'; // High speed for links to stay under 10s
    const synthTimeout = isLink ? 9500 : 25000;

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
      const catboxFileName = `v_${Date.now()}_${Math.floor(Math.random()*1000)}.mp3`;
      form.append('fileToUpload', fs.createReadStream(tmpAudioPath), { filename: catboxFileName });
      
      const uploadResp = await axios.post('https://catbox.moe/user/api.php', form, {
        headers: form.getHeaders(), timeout: 15000
      });
      const mediaUrl = String(uploadResp.data).trim();
      if (mediaUrl.startsWith('http')) {
        const now = new Date().toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
        const caption = partLabel ? `🎙️ ${partLabel} [${now}]` : `🎙️ [${now}]`;
        await messagingClient.sendVoice(mediaUrl, caption);
        try { fs.unlinkSync(tmpAudioPath); } catch (e) {}
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
async function callGeminiApi(model, prompt, key, mediaData = null, tools = null) {
  let geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const payload = {
    contents: [{ 
      parts: mediaData ? [{ text: prompt }, mediaData] : [{ text: prompt }] 
    }]
  };
  
  if (tools) {
    payload.tools = tools;
  }

  console.log(`[callGeminiApi] model: ${model}, tools: ${tools ? 'YES' : 'NO'}, Prompt prefix: ${prompt.substring(0, 50)}...`);

  try {
    return await axios.post(geminiUrl, payload, { 
      timeout: 30000, headers: { 'x-goog-api-key': key } 
    });
  } catch (err) {
    if (err.response?.status === 404) {
      console.warn(`⚠️ ${model} 404 on v1beta, trying v1...`);
      geminiUrl = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`;
      return await axios.post(geminiUrl, payload, { 
        timeout: 30000, headers: { 'x-goog-api-key': key } 
      });
    }
    throw err;
  }
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
  if (MediaUrl0 && MediaContentType0 && MediaContentType0.includes('image')) {
    // 1. Send immediate processing feedback
    console.log(`Processing image from ${From}`);
    await messagingClient.sendText("🖼️ 收到圖片！正在進行事實查核... ⏳\n\n(💤 提示：初次使用如需喚醒系統，可能會有 60 秒延遲。)");
    await new Promise(resolve => setTimeout(resolve, 1000));

    const imgBuffer = await messagingClient.downloadMedia(MediaUrl0);

    // Backup to Catbox for permanent storage before queuing
    const backupUrl = await uploadToCatbox(imgBuffer, MediaContentType0, `factcheck_${Date.now()}.jpg`);
    if (backupUrl) {
      payload.MediaUrl0 = backupUrl; // Update original payload so the queue persists the Catbox URL
    }

    const models = [
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest',
      'gemini-1.5-flash-002',
      'gemini-1.5-flash-8b',
      'gemini-1.5-pro'
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

    const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));
    let factCheckResult = null;
    let successModel = null;

    const politeModelNames = {
      'gemini-2.0-flash': 'Gemini 2.0',
      'gemini-1.5-flash': '1.5 Flash',
      'gemini-1.5-flash-002': '1.5 Flash V2',
      'gemini-1.5-flash-8b': '1.5 Flash 8B'
    };

    if (cachedResult) {
      console.log('♻️ Using cached Gemini result for consistency.');
      factCheckResult = cachedResult;
      successModel = 'CACHED';
    } else {
      const prioritizedPairs = await getPrioritizedPairs(models, apiKeys, redis);
      let currentIterModel = null;

      for (const { model, key, index: kIdx, status: startStatus } of prioritizedPairs) {
        try {
          if (currentIterModel && model !== currentIterModel && !factCheckResult && !skipText) {
            const oldName = politeModelNames[currentIterModel] || currentIterModel;
            const newName = politeModelNames[model] || model;
            try {
              await messagingClient.sendText(`🤖 [系統提示] ${oldName} (所有金鑰) 忙碌中，正嘗試切換至 ${newName}... ⏳`);
            } catch (notifyErr) {}
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          currentIterModel = model;

          console.log(`📡 Attempting ${model} with Key ${String.fromCharCode(65 + kIdx)} (Status: ${startStatus})`);
          
          const mediaData = { inline_data: { mime_type: MediaContentType0, data: imgBuffer.toString("base64") } };
          const geminiResponse = await callGeminiApi(model, prompt, key, mediaData, [{ google_search: {} }]);

          factCheckResult = geminiResponse.data.candidates[0].content.parts.map(p => p.text || '').join('\n').trim();
          if (factCheckResult) {
            successModel = model;
            if (redis) await redis.set(`key_status:${model}:${key}`, `WORKING:${Date.now()}`, 'EX', 3600);
            break;
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429) {
            if (redis) await redis.set(`key_status:${model}:${key}`, `FAILED:${Date.now()}`, 'EX', 600);
            
            const currentPairIdx = prioritizedPairs.findIndex(p => p.model === model && p.key === key);
            if (currentPairIdx < prioritizedPairs.length - 1) {
              const nextPair = prioritizedPairs[currentPairIdx + 1];
              if (!skipText && nextPair.model === model) {
                try {
                  await messagingClient.sendText(`🤖 [系統提示] Key ${String.fromCharCode(65 + kIdx)} 額度用盡，正嘗試切換至 Key ${String.fromCharCode(65 + nextPair.index)}... ⏳`);
                } catch (notifyErr) {}
              }
              await new Promise(resolve => setTimeout(resolve, skipText ? 100 : 1500));
              continue; 
            }
          } else {
            console.error(`Error with ${model} Key ${String.fromCharCode(65 + kIdx)}:`, err.message);
            continue;
          }
        }
      }
    }

    if (!factCheckResult) {
      throw new Error('All Gemini models exhausted or failed (429).');
    }

    console.log(`✅ Fact-check successful using ${successModel}`);

    // Shorten URLs
    const foundUrls = factCheckResult.match(/(https?:\/\/[^\s\)]+)/g) || [];
    for (const longUrl of [...new Set(foundUrls)]) {
      const short = await shortenUrl(longUrl);
      factCheckResult = factCheckResult.split(longUrl).join(short);
    }

    // Split and send
    let factCheckPart = factCheckResult;
    let explanationPart = "";
    let menuPart = "";
    
    // Split logic using regex for robustness
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

    if (!skipText) {
      const CHUNK_SIZE = 1500;
      for (let i = 0; i < factCheckResult.length; i += CHUNK_SIZE) {
        await messagingClient.sendText(`💡 事實查核與解析：\n\n${factCheckResult.substring(i, i + CHUNK_SIZE)}`);
      }
    }

    if (!skipVoice) {
      if (factCheckPart) {
        await generateAndSendVoice(factCheckPart, messagingClient, "🎙️ 正在生成查核結果語音...");
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (explanationPart) {
        await generateAndSendVoice(explanationPart, messagingClient, "🎙️ 正在生成知識點解析語音...");
      }
    }

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
        
        if (!skipText) {
          await messagingClient.sendText(`📌 [#${menuId}] 回覆數字深入學習，或輸入「${menuId} 數字」回顧舊話題。`);
        }
      }
    }

    return { handled: true, result: factCheckResult };
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
        await messagingClient.sendText("📖 正在為您讀取網頁內容並準備導讀... 請稍候 ⏳");
        return { handled: true, linkUrl: targetUrl };
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

    const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-002'];
    const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));
    const prioritizedPairs = await getPrioritizedPairs(models, apiKeys, redis);
    let extractionResult = null;

    for (const { model, key } of prioritizedPairs) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const resp = await axios.post(geminiUrl, { contents: [{ parts: [{ text: extractionPrompt }] }] }, { timeout: 25000, headers: { 'x-goog-api-key': key } });
        extractionResult = resp.data.candidates[0].content.parts[0].text;
        if (extractionResult) break;
      } catch (e) {
        console.error(`Extraction error ${model}:`, e.message);
      }
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

    const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-002'];
    const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));
    const prioritizedPairs = await getPrioritizedPairs(models, apiKeys, redis);
    let transcription = null;

    for (const { model, key, index: kIdx } of prioritizedPairs) {
      try {
        console.log(`🎙️ Attempting transcription with ${model} (Key ${String.fromCharCode(65 + kIdx)})`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const transcriptionResp = await axios.post(geminiUrl, {
          contents: [{ parts: [{ text: transcriptionPrompt }, { inline_data: { mime_type: MediaContentType0, data: buffer.toString("base64") } }] }]
        }, { timeout: 35000, headers: { 'x-goog-api-key': key } });
     // 1.5 Transcription & Intent Detection
    const transcriptionText = transcriptionResp.data.candidates[0].content.parts[0].text.trim();
    if (!transcriptionText) throw new Error("未能識別語音內容。");

    // Detect Intent (NEW_NOTE, LIST_NOTES, MODIFY_NOTE)
    const intentPrompt = `分析以下語音轉錄內容並判斷用戶意圖。
內容：${transcriptionText}

可能的意圖：
- LIST_NOTES: 用戶想查看、查詢或閱讀之前的筆記/任務。（例如：「幫我查下琴日寫咗咩」、「有咩未做」、「讀返最近嗰幾條俾我聽」）
- MODIFY_NOTE: 用戶想刪除、更改或更新之前的筆記。（例如：「刪除最後嗰條」、「頭先嗰個改返做聽日」、「頭先講錯咗，唔好要」）
- NEW_NOTE: 用戶正在記錄新的想法、任務或筆記。（所有不屬於上述兩者的內容）

JSON Output: { "intent": "INTENT_NAME", "query": "關鍵字（如果是查詢）", "action": "動作（如果是修改，如 DELETE, UPDATE）" }`;

    const intentResp = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY.split(',')[0].trim()}`, {
      contents: [{ parts: [{ text: intentPrompt }] }]
    }, { timeout: 15000 });
    
    let intentData = { intent: 'NEW_NOTE' };
    try {
      const intentText = intentResp.data.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
      intentData = JSON.parse(intentText);
    } catch (e) { console.error('Intent Parse Error:', e.message); }

    // --- CASE 1: LIST_NOTES ---
    if (intentData.intent === 'LIST_NOTES') {
      const redisListKey = `notes:${From}`;
      const recentNotes = redis ? await redis.lrange(redisListKey, 0, 9) : [];
      
      if (recentNotes.length === 0) {
        await messagingClient.sendText("📋 您目前沒有任何已儲存的筆記。");
        return { handled: true };
      }

      const listStr = recentNotes.map((n, i) => {
        const item = JSON.parse(n);
        return `${i + 1}. [${item.category}] ${item.refined}`;
      }).join('\n\n');

      const summaryPrompt = `這是我最近的筆記內容。請用廣東話口語簡短地為我總結這 ${recentNotes.length} 條記錄，像是在跟我對話一樣。
內容：
${listStr}`;
      
      const summaryResp = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY.split(',')[0].trim()}`, {
        contents: [{ parts: [{ text: summaryPrompt }] }]
      }, { timeout: 15000 });
      
      const audioSummary = summaryResp.data.candidates[0].content.parts[0].text.trim();
      await messagingClient.sendText(`📋 最近的筆記：\n\n${listStr}`);
      await generateAndSendVoice(audioSummary, messagingClient, "🎙️ 正在為您朗讀筆記總結...");
      return { handled: true };
    }

    // --- CASE 2: MODIFY_NOTE (DELETE sample) ---
    if (intentData.intent === 'MODIFY_NOTE' && intentData.action === 'DELETE') {
      const redisListKey = `notes:${From}`;
      const globalKey = 'notes:all';
      
      const lastNote = redis ? await redis.lindex(redisListKey, 0) : null;
      if (lastNote) {
        // Simple "Delete last one" for now
        await redis.lpop(redisListKey);
        // Also find and remove from global (expensive if many, but fine for now)
        const allNotes = await redis.lrange(globalKey, 0, 50);
        for (const n of allNotes) {
          if (n === lastNote) {
            await redis.lrem(globalKey, 1, n);
            break;
          }
        }
        await messagingClient.sendText("🗑️ 已成功刪除最近的一條筆記。");
        return { handled: true };
      } else {
        await messagingClient.sendText("⚠️ 找不到可以刪除的筆記。");
        return { handled: true };
      }
    }

    // --- CASE 3: NEW_NOTE (Existing Drafting Logic) ---
    await messagingClient.sendText(`📝 識別內容：\n"${transcriptionText}"`);
        transcription = transcriptionText; // Assign transcriptionText to the existing 'transcription' variable
        if (transcription) {
          if (redis) await redis.set(`key_status:${model}:${key}`, `WORKING:${Date.now()}`, 'EX', 3600);
          break;
        }
      } catch (e) {
        if (e.response?.status === 429 || e.response?.status === 400) {
          if (redis) await redis.set(`key_status:${model}:${key}`, `FAILED:${Date.now()}`, 'EX', 1800);
          console.warn(`Transcription Key ${String.fromCharCode(65 + kIdx)} busy, rotating...`);
          continue;
        }
        console.error(`Transcription error ${model}:`, e.message);
      }
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
    await messagingClient.sendText("🌐 收到網頁！正在讀取並分析全文... ⏳\n\n(💤 提示：初次使用如需喚醒系統，可能會有 60 秒延遲。)");
    // Initialize module-level GEMINI_API_KEY if not already set or if config provides a new one
    if (config?.GEMINI_API_KEY) {
      GEMINI_API_KEY = config.GEMINI_API_KEY;
    } else if (config?.geminiKey) {
       GEMINI_API_KEY = config.geminiKey;
    }
    
    if (!GEMINI_API_KEY) {
      GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    }

    const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-002', 'gemini-1.5-flash-8b', 'gemini-1.5-pro'];
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
      $('p').each((i, el) => { 
        const txt = $(el).text().trim(); 
        if (txt.length > 20) paragraphs.push(txt); 
      });
      
      let rawText = paragraphs.slice(0, 30).join('\n\n').trim(); 
      if (rawText.length < 100) rawText = $('body').text().substring(0, 8000).trim();
      const combinedText = `標題：${title}\n\n${rawText}`.substring(0, 15000);
      
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

      const prioritizedPairs = await getPrioritizedPairs(models, apiKeys, redis);
      for (const { model, key, index: kIdx } of prioritizedPairs) {
        try {
          console.log(`📡 Link Extract: Attempting ${model} with Key ${String.fromCharCode(65 + kIdx)}`);
          const resp = await callGeminiApi(model, prompt, key, null, null);
          const result = resp.data.candidates[0].content.parts.map(p => p.text || '').join('\n').trim();
          if (result) {
            finalContent = result;
            successModel = model;
            if (redis) await redis.set(`key_status:${model}:${key}`, `WORKING:${Date.now()}`, 'EX', 3600);
            break;
          }
        } catch (e) { 
          const status = e.response?.status;
          if (status === 429) {
            if (redis) await redis.set(`key_status:${model}:${key}`, `FAILED:${Date.now()}`, 'EX', 600);
            console.warn(`Link Key ${String.fromCharCode(65 + kIdx)} hit quota, rotating...`);
          } else {
            console.error(`Link extract error ${model}:`, e.message); 
          }
        }
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
    const voiceChunks = chunkText(fullTextPart, 800);
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
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-002',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro'
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
      const prioritizedPairs = await getPrioritizedPairs(models, apiKeys, redis);
      let currentIterModel = null;
      
      for (const { model, key, index: kIdx, status: startStatus } of prioritizedPairs) {
        try {
          if (currentIterModel && model !== currentIterModel && !result && !skipText) {
            const currentName = currentIterModel.includes('2.0') ? 'Gemini 2.0' : currentIterModel.includes('lite') ? '1.5 Lite' : '1.5 Flash';
            const nextName = model.includes('2.0') ? 'Gemini 2.0' : model.includes('lite') ? '1.5 Lite' : '1.5 Flash';
            
            try {
              await messagingClient.sendText(`🤖 [系統提示] ${currentName} (所有金鑰) 忙碌中，正嘗試切換至 ${nextName}... ⏳`);
            } catch (notifyErr) {}
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          currentIterModel = model;

          console.log(`📡 Attempting Deep Dive with model: ${model} using Key ${String.fromCharCode(65 + kIdx)} (Status: ${startStatus})`);
          const geminiResponse = await callGeminiApi(model, prompt, key, null, null);

          result = geminiResponse.data.candidates[0].content.parts.map(p => p.text || '').join('\n').trim();
          if (result) {
            successModel = model;
            if (redis) await redis.set(`key_status:${model}:${key}`, `WORKING:${Date.now()}`, 'EX', 3600);
            break;
          }
        } catch (err) {
          const errStatus = err.response?.status;
          const errData = err.response?.data;
          console.error(`ERROR (${model}): Status ${errStatus}, Data:`, JSON.stringify(errData));
          if (errStatus === 429) {
            if (redis) await redis.set(`key_status:${model}:${key}`, `FAILED:${Date.now()}`, 'EX', 600);
            
            const currentPairIdx = prioritizedPairs.findIndex(p => p.model === model && p.key === key);
            if (currentPairIdx < prioritizedPairs.length - 1) {
              const nextPair = prioritizedPairs[currentPairIdx + 1];
              if (!skipText && nextPair.model === model) {
                try {
                  await messagingClient.sendText(`🤖 [系統提示] Key ${String.fromCharCode(65 + kIdx)} 忙碌，正切換至 Key ${String.fromCharCode(65 + nextPair.index)}... ⏳`);
                } catch (notifyErr) {}
              }
              await new Promise(resolve => setTimeout(resolve, skipText ? 100 : 1500));
              continue;
            }
          } else {
            console.error(`Deep Dive ${model} error:`, err.message);
            continue; 
          }
        }
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
  processDeepDive
};
