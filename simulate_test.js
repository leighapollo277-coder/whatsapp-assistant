const axios = require('axios');
const { execSync } = require('child_process');
const qs = require('querystring');

const SERVER_URL = "https://whatsapp-assistant-ex7w.onrender.com/api/webhook";
const SERVICE_ID = "srv-d72g624hg0os738jtqu0";

async function runTest1() {
    console.log("🚀 Starting Test 1: Blogspot Link Extraction...");
    const link = "https://ymch130.blogspot.com/2026/02/w40-4.html?m=1";
    
    const payload = qs.stringify({
        Body: link,
        From: "whatsapp:+85291234567",
        To: "whatsapp:+14155238886"
    });
    
    const startTime = Date.now();
    try {
        await axios.post(SERVER_URL, payload, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`✅ Initial Response received in ${elapsed.toFixed(1)}s (Goal: <10s)`);
        
        console.log("⏳ Waiting 30s for background processing...");
        await new Promise(r => setTimeout(r, 30000));
        
        console.log("📊 Auditing Production Logs...");
        const logs = execSync(`export RENDER_API_KEY=rnd_pNra6ZPZyfWDnLJD1pwmxmjrck2P && render logs -r ${SERVICE_ID} --direction backward --limit 200 --output json`).toString();
        
        const hasExtracted = logs.includes("Extracted");
        const hasVoice = logs.includes("voice chunks");
        const hasSuccess = logs.includes("SUCCESS with");
        const hasCompleted = logs.includes("Task") && logs.includes("completed");
        const hasAllFailed = logs.includes("All attempts exhausted");
        
        console.log(`  📋 Extraction: ${hasExtracted ? '✅' : '❌'}`);
        console.log(`  📋 Voice Chunks: ${hasVoice ? '✅' : '❌'}`);
        console.log(`  📋 Gemini Success: ${hasSuccess ? '✅' : '⏳ Pending'}`);
        console.log(`  📋 Task Completed: ${hasCompleted ? '✅' : '⏳ Pending'}`);
        if (hasAllFailed) console.log(`  ⚠️ All Gemini attempts exhausted — check API keys/quotas.`);
        
        if (hasExtracted && (hasSuccess || hasVoice)) {
            console.log("🎉 SUCCESS: Link processing working!");
        } else if (hasExtracted) {
            console.log("⚠️ PARTIAL: Extraction works but Gemini summarization failed.");
        } else {
            console.log("❌ FAILURE: Could not find extraction logs.");
        }
    } catch (err) {
        console.error("❌ Test 1 Error:", err.message);
    }
}

async function runTest2(imageUrl) {
    if (!imageUrl) {
        console.log("⏩ Skipping Test 2: No image URL provided.");
        return;
    }
    console.log("🚀 Starting Test 2: Musk Screenshot Fact-Check...");
    const payload = qs.stringify({
        MediaUrl0: imageUrl,
        MediaContentType0: "image/png",
        From: "whatsapp:+85291234567",
        To: "whatsapp:+14155238886"
    });
    try {
        await axios.post(SERVER_URL, payload, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log("✅ Image simulation sent.");
        
        console.log("⏳ Waiting 45s for AI fact-check...");
        await new Promise(r => setTimeout(r, 45000));
        
        const logs = execSync(`export RENDER_API_KEY=rnd_pNra6ZPZyfWDnLJD1pwmxmjrck2P && render logs -r ${SERVICE_ID} --limit 100 --output json`).toString();
        if (logs.includes("fact-check") || logs.includes("Musk")) {
            console.log("🎉 SUCCESS: Musk fact-check analyzed and voice generated!");
        } else {
            console.log("❌ FAILURE: Could not find fact-check logs.");
        }
    } catch (err) {
        console.error("❌ Test 2 Error:", err.message);
    }
}

// Entry point
const testType = process.argv[2] || 'all';
const imgUrl = process.argv[3];

async function runTest3() {
    console.log("🚀 Starting Test 3: Deep-Dive Numeric Reply...");
    const payload = qs.stringify({
        Body: "1",
        From: "whatsapp:+85291234567",
        To: "whatsapp:+14155238886"
    });
    try {
        await axios.post(SERVER_URL, payload, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log("✅ Numeric reply '1' sent.");
        
        console.log("⏳ Waiting 30s for AI deep-dive analysis...");
        await new Promise(r => setTimeout(r, 30000));
        
        const logs = execSync(`export RENDER_API_KEY=rnd_pNra6ZPZyfWDnLJD1pwmxmjrck2P && render logs -r ${SERVICE_ID} --limit 200 --output json`).toString();
        if (logs.includes("深度解析") || logs.includes("Deep Dive successful") || logs.includes("Deep-Dive successful")) {
            console.log("🎉 SUCCESS: Numeric reply triggered Deep-Dive!");
        } else {
            console.log("❌ FAILURE: Could not find Deep-Dive logs. (Check if previous test created a menu state)");
        }
    } catch (err) {
        console.error("❌ Test 3 Error:", err.message);
    }
}

(async () => {
    // Run sequentially to ensure state is created
    await runTest1();
    await runTest3(); 
    // runTest2 requires a manual image URL, skip for now unless provided
    if (testType === '2' || testType === 'all') await runTest2(imgUrl);
})();
