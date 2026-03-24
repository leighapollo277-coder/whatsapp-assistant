const axios = require('axios');
const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs');
const FormData = require('form-data');
const cheerio = require('cheerio');
const { GoogleSheetsHelper } = require('./sheets');
const { google } = require('googleapis');

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
    'gemini-flash-latest': 80,
    'gemini-flash-lite-latest': 60,
    'gemini-2.5-flash-lite': 40
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

// Helper: Generate and send voice message
async function generateAndSendVoice(text, messagingClient, statusPrefix = "🎙️ 正在準備廣東話語音總結...") {
  try {
    if (statusPrefix) {
      await messagingClient.sendText(statusPrefix);
    }
    const cleanText = text
      .replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '')
      .replace(/[\[\]#*]/g, '')
      .replace(/https?:\/\/[^\s]+/g, '') // Strip URLs from voice
      .trim()
      .substring(0, 1500);
    
    if (!cleanText || cleanText.length < 5) {
      console.warn('Voice Helper: Content too short or only English.');
      if (statusPrefix) {
        await messagingClient.sendText("⚠️ 內容過短或僅含英文，無法生成廣東話語音。");
      }
      return false;
    }

    const tts = new EdgeTTS({
      voice: 'zh-HK-WanLungNeural',
      lang: 'zh-HK',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      rate: '+15%',
      pitch: '-5%',
      timeout: 60000,
      saveSubtitles: false
    });
    const tmpAudioPath = `/tmp/voice_${Date.now()}.mp3`;
    console.log(`Generating TTS for ${cleanText.length} characters...`);
    await tts.ttsPromise(cleanText, tmpAudioPath);
    
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(tmpAudioPath));
    const uploadResponse = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 15000
    });
    const mediaUrl = uploadResponse.data.trim();
    await messagingClient.sendVoice(mediaUrl, "");
    return true;
  } catch (err) {
    console.error('Voice Helper Error:', err.message);
    await messagingClient.sendText(`⚠️ 語音失敗: ${err.message}`);
    return false;
  }
}

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

/**
 * Core Processing Logic
 */
async function processRequest(payload, messagingClient, tasksApi, config, redis, skipVoice = false, skipText = false, cachedResult = null) {
  const { Body, From, MediaUrl0, MediaContentType0, platform } = payload;
  const { GEMINI_API_KEY, GOOGLE_TASK_LIST_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_CALENDAR_ID } = config;

  // Initialize Google Auth for Sheets/Calendar if needed
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive.file']
  );
  const sheetsHelper = new GoogleSheetsHelper(auth);
  const calendar = google.calendar({ version: 'v3', auth });

  // 1. Handle Image (Fact-Check)
  if (MediaUrl0 && MediaContentType0 && MediaContentType0.includes('image')) {
    console.log(`Processing image from ${From}`);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const imgBuffer = await messagingClient.downloadMedia(MediaUrl0);

    // Backup to Catbox for permanent storage before queuing
    const backupUrl = await uploadToCatbox(imgBuffer, MediaContentType0, `factcheck_${Date.now()}.jpg`);
    if (backupUrl) {
      payload.MediaUrl0 = backupUrl; // Update original payload so the queue persists the Catbox URL
    }

    const models = [
      'gemini-2.0-flash',
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'gemini-2.5-flash-lite'
    ];

    const prompt = `你是一個專業的事實查核與教育助手。請對輸入內容進行深度分析，輸出必須嚴格包含以下三個部分，並使用指定的分隔符號隔開：

【第一部分：事實查核】
1. **結論**：[真實 / 虛假 / 誤導 / 有待核實]
2. **信心分數**：(標註 0-1)
3. **簡潔摘要**：用 2-3 句話總結發現。
4. **查核證據**：列出 2-3 個關鍵事實，並附上完整的來源網址 (URL)。

--- 知識點解析 ---
【第二部分：教育解析】
請用簡單易懂的廣東話口語或書面語，解釋這件事背後的科學、歷史 or 社會知識點，幫助用戶學習新知識。

--- 延伸閱讀 ---
【第三部分：關鍵字菜單】
請從上述解析中提取 9 個值得深入了解的關鍵字或概念，並以純數字編號列表：
1. [關鍵字A]
2. [關鍵字B]
...

CRITICAL: TRADITIONAL CHINESE only. Use Google Search grounding.`;

    const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));
    let factCheckResult = null;
    let successModel = null;

    const politeModelNames = {
      'gemini-2.0-flash': 'Gemini 2.0',
      'gemini-flash-latest': '1.5 Flash',
      'gemini-flash-lite-latest': '1.5 Lite',
      'gemini-2.5-flash-lite': '2.5 Lite'
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
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          const geminiResponse = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: MediaContentType0, data: imgBuffer.toString("base64") } }] }],
            tools: [{ google_search: {} }]
          }, { timeout: 45000, headers: { 'x-goog-api-key': key } });

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
        await redis.set(`learning_state:${From}`, JSON.stringify({ keywords, context: factCheckPart.substring(0, 500) }), 'EX', 3600);
      }
    }

    return { handled: true, result: factCheckResult };
  }

  // 2. Handle Text (URL only, no context)
  if (Body) {
    const urlMatch = Body.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      const targetUrl = urlMatch[0];
      await messagingClient.sendText("📖 正在為您讀取網頁內容並準備導讀... 請稍候 ⏳");
      return { handled: true, linkUrl: targetUrl };
    }
  }

  // 3. Handle Voice / Drafting Session
  const sessionKey = `voice_session:${From}`;
  const sessionData = redis ? await redis.get(sessionKey) : null;
  const session = sessionData ? JSON.parse(sessionData) : null;

  // A. Handle Confirmation (User says "OK", "確定", "可以", etc.)
  if (session && Body && /^(ok|okay|可以|確定|确认|好|得|冇問題|無問題)$/i.test(Body.trim())) {
    await messagingClient.sendText("✅ 收到！正在為您整理並同步至 Google Sheets 及日曆... ⏳");
    
    // Extract Metadata (Category, Tasks, Calendar Events)
    const extractionPrompt = `分析以下內容並提取元數據。TRADITIONAL CHINESE only. 
內容：${session.currentDraft}
JSON Output: {
  "refined": "對內容進行潤飾（廣東話口語化）",
  "category": "分類（例如：工作、生活、財務、學習）",
  "tasks": ["任務1", "任務2"],
  "calendar_events": [{"title": "事件名", "start": "ISO_DATE_TIME", "end": "ISO_DATE_TIME", "description": "..."}]
}
Current Time: ${new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong Kong' })}`;

    const cleanKey = GEMINI_API_KEY.split(',')[0].trim().replace(/^"|"$/g, '');
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cleanKey}`;
    const extractionResponse = await axios.post(geminiUrl, {
      contents: [{ parts: [{ text: extractionPrompt }] }]
    }, { timeout: 25000 });

    const extractionResult = extractionResponse.data.candidates[0].content.parts[0].text;
    const jsonMatch = extractionResult.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const metadata = JSON.parse(jsonMatch[0]);
      
      // 1. Sync to Google Sheets
      const spreadsheetId = await sheetsHelper.getOrCreateSpreadsheet(redis);
      await sheetsHelper.appendRow(spreadsheetId, {
        timestamp: new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong Kong' }),
        original: session.originalTranscription,
        refined: metadata.refined,
        category: metadata.category,
        tasks: metadata.tasks?.join('\n'),
        calendarLink: '' // Will update if events created
      });

      // 2. Sync to Google Calendar
      let calLinks = [];
      if (metadata.calendar_events && metadata.calendar_events.length > 0) {
        for (const event of metadata.calendar_events) {
          try {
            const calRes = await calendar.events.insert({
              calendarId: GOOGLE_CALENDAR_ID || 'primary',
              requestBody: {
                summary: event.title,
                description: event.description + `\n\n備註：${metadata.refined}`,
                start: { dateTime: event.start, timeZone: 'Asia/Hong Kong' },
                end: { dateTime: event.end, timeZone: 'Asia/Hong Kong' }
              }
            });
            if (calRes.data.htmlLink) calLinks.push(calRes.data.htmlLink);
          } catch (calErr) {
            console.error('Calendar Insert Error:', calErr.message);
          }
        }
      }

      // 3. Set Reminders
      if (metadata.calendar_events && metadata.calendar_events.length > 0) {
        for (const event of metadata.calendar_events) {
          const reminderTime = new Date(new Date(event.start).getTime() - 15 * 60000).getTime(); // 15 mins before
          if (reminderTime > Date.now()) {
            const reminderTask = {
              type: 'reminder',
              platform: platform || 'whatsapp',
              to: From,
              message: `⏰ 提醒您：待會兒 ${new Date(event.start).toLocaleTimeString('zh-HK')} 需要「${event.title}」！\n內容：${metadata.refined}`,
              time: reminderTime
            };
            // Use Sorted Set for reminders: score is the timestamp
            await redis.zadd('reminders:pending', reminderTime, JSON.stringify(reminderTask));
          }
        }
      }

      await messagingClient.sendText(`🎉 已成功處理：\n\n📌 分類：${metadata.category}\n📝 潤飾：${metadata.refined}${calLinks.length > 0 ? `\n📅 已加入日曆：${calLinks[0]}` : ''}\n\n您可以在網頁管理後台查看完整內容！`);
      await redis.del(sessionKey);
    }
    return { handled: true };
  }

  // B. Handle New Voice or Voice Edit
  if (MediaUrl0 && MediaContentType0 && (MediaContentType0.includes('audio') || MediaContentType0.includes('video'))) {
    console.log(`Processing voice message from ${From}`);
    if (!session) {
      await messagingClient.sendText("正在傾聽您的想法... ⏳");
    } else {
      await messagingClient.sendText("正在根據您的新指令修改草稿... ⏳");
    }

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

    const cleanKey = GEMINI_API_KEY.split(',')[0].trim().replace(/^"|"$/g, '');
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cleanKey}`;
    const transcriptionResponse = await axios.post(geminiUrl, {
      contents: [{ parts: [{ text: transcriptionPrompt }, { inline_data: { mime_type: MediaContentType0, data: buffer.toString("base64") } }] }]
    }, { timeout: 25000 });

    const transcription = transcriptionResponse.data.candidates[0].content.parts[0].text.trim();

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

async function processLink(targetUrl, From, messagingClient, config, redis, cachedResult = null) {
  const { GEMINI_API_KEY } = config;
  try {
    let finalContent = null;
    if (cachedResult) {
      console.log('♻️ Using cached Link result.');
      finalContent = cachedResult;
    } else {
      const webResponse = await axios.get(targetUrl, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }, validateStatus: false });
      if (webResponse.status !== 200) throw new Error(`無法存取網頁 (HTTP ${webResponse.status})`);
      const $ = cheerio.load(webResponse.data);
      $('script, style, nav, footer, header').remove();
      const title = $('title').text().trim() || '網頁導讀';
      const paragraphs = [];
      $('p').each((i, el) => { const txt = $(el).text().trim(); if (txt.length > 30) paragraphs.push(txt); });
      let rawText = paragraphs.slice(0, 15).join('\n\n').trim();
      if (rawText.length < 100) rawText = $('body').text().substring(0, 2500).trim();
      const combinedText = `標題：${title}\n\n${rawText}`.substring(0, 4000);
      
      const containsChinese = /[\u4e00-\u9fa5]/.test(combinedText);
      if (containsChinese) {
        const prompt = `你是一個專業的內容提取助手。請從以下文本中提取所有「中文內容」，並將其轉換為「繁體中文」。
要求：
1. 只保留中文詞彙、短語或句子。
2. 刪除所有英文、數字及不必要的符號。
3. 輸出必須是純繁體中文。
4. 保持內容的連貫性。

內容如下：
${combinedText}`;
        const prioritizedPairs = await getPrioritizedPairs(['gemini-1.5-flash', 'gemini-flash-latest'], GEMINI_API_KEY.split(',').map(k => k.trim()), redis);
        for (const { model, key } of prioritizedPairs) {
          try {
            const resp = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 45000 });
            const result = resp.data.candidates[0].content.parts.map(p => p.text || '').join('\n').trim();
            if (result) {
              finalContent = result;
              break;
            }
          } catch (e) { console.error(`Chinese extract error ${model}:`, e.message); }
        }
      }
      
      if (!finalContent) finalContent = combinedText;
    }
    const CHUNK_SIZE = 1500;
    for (let i = 0; i < finalContent.length; i += CHUNK_SIZE) {
      await messagingClient.sendText(finalContent.substring(i, i + CHUNK_SIZE));
    }
    await generateAndSendVoice(finalContent, messagingClient, "🎙️ 正在生成語音導讀...");
    return { handled: true, result: finalContent };
  } catch (err) {
    console.error('ProcessLink Err:', err.message);
    await messagingClient.sendText(`❌ 導讀失敗: ${err.message}`);
    return { handled: false };
  }
}

async function processDeepDive(keyword, context, From, messagingClient, config, redis, skipVoice = false, skipText = false, cachedResult = null) {
  const { GEMINI_API_KEY } = config;

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
    const models = [
      'gemini-2.0-flash',
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'gemini-2.5-flash-lite'
    ];
    
    const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));
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

          console.log(`📚 Attempting Deep Dive with model: ${model} using Key ${String.fromCharCode(65 + kIdx)} (Status: ${startStatus})`);
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          const geminiResponse = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }]
          }, { timeout: 45000, headers: { 'x-goog-api-key': key } });

          result = geminiResponse.data.candidates[0].content.parts.map(p => p.text || '').join('\n').trim();
          if (result) {
            successModel = model;
            if (redis) await redis.set(`key_status:${model}:${key}`, `WORKING:${Date.now()}`, 'EX', 3600);
            break;
          }
        } catch (err) {
          const errStatus = err.response?.status;
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
        await redis.set(`learning_state:${From}`, JSON.stringify({ keywords, context: explanationPart.substring(0, 500) }), 'EX', 3600);
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
