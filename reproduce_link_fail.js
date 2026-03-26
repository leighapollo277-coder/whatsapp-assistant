require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');

async function main() {
    const targetUrl = 'https://ymch130.blogspot.com/2025/04/w24-2.html';
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));
    
    console.log('--- Step 1: Fetching Web Content ---');
    const webResponse = await axios.get(targetUrl, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' }, validateStatus: false });
    console.log(`HTTP Status: ${webResponse.status}`);
    
    const $ = cheerio.load(webResponse.data);
    $('script, style, nav, footer, header, .ads, #sidebar').remove();
    const title = $('title').text().trim() || '網頁內容';
    const paragraphs = [];
    $('p').each((i, el) => { 
      const txt = $(el).text().trim(); 
      if (txt.length > 20) paragraphs.push(txt); 
    });
    
    let rawText = paragraphs.slice(0, 30).join('\n\n').trim(); 
    if (rawText.length < 100) {
        console.log('Paragraphs too short, falling back to body text...');
        rawText = $('body').text().substring(0, 8000).trim();
    }
    const combinedText = `標題：${title}\n\n${rawText}`.substring(0, 15000);
    console.log(`Extracted Text Length: ${combinedText.length}`);
    console.log(`Content Sample: ${combinedText.substring(0, 200)}...`);

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

    console.log('\n--- Step 2: Calling Gemini API ---');
    const model = 'gemini-1.5-flash'; // Start with a fast one
    const key = apiKeys[0];
    
    try {
        let geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const payload = { contents: [{ parts: [{ text: prompt }] }] };
        let resp;
        try {
            resp = await axios.post(geminiUrl, payload, { timeout: 45000 });
        } catch (err) {
            if (err.response?.status === 404) {
                console.log('404 on v1beta, trying v1...');
                geminiUrl = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`;
                resp = await axios.post(geminiUrl, payload, { timeout: 45000 });
            } else {
                throw err;
            }
        }
        
        if (resp.data.candidates && resp.data.candidates[0].content) {
            const result = resp.data.candidates[0].content.parts.map(p => p.text || '').join('\n').trim();
            console.log('Success! Result length:', result.length);
            console.log('Result Preview:', result.substring(0, 300));
        } else {
            console.log('API responded but no candidates found. Safety filter?');
            console.log(JSON.stringify(resp.data, null, 2));
        }
    } catch (err) {
        console.error('API Error:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
    }
}

main();
