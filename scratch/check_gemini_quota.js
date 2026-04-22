const axios = require('axios');
require('dotenv').config({ path: '.env.production.local' });

const keys = process.env.GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));

async function listModels() {
    console.log(`🔍 Checking ${keys.length} API Keys via models.list...`);

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const keyShort = `${key.substring(0, 8)}...`;
        console.log(`\n🔑 Key #${i + 1} (${keyShort})`);

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
            const response = await axios.get(url, { timeout: 10000 });
            
            const models = response.data.models || [];
            console.log(`  ✅ Key is VALID. Found ${models.length} accessible models.`);
            
            // Print top free-tier relevant models
            const flashModels = models.filter(m => m.name.includes('flash'));
            console.log(`  🔹 Available Flash Models:`);
            flashModels.slice(0, 8).forEach(m => {
                console.log(`    - ${m.name} (Methods: ${m.supportedGenerationMethods.join(', ')})`);
            });

        } catch (err) {
            const status = err.response?.status;
            const errMsg = err.response?.data?.error?.message || err.message;
            const reason = err.response?.data?.error?.status || "UNKNOWN";
            
            console.log(`  ❌ Key FAILED | HTTP ${status || 'ERR'} | ${reason} | ${errMsg.substring(0, 150)}`);
        }
    }
}

listModels();
