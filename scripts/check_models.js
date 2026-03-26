const axios = require('axios');
require('dotenv').config({ path: '/Users/kenneth/.gemini/antigravity/scratch/whatsapp-assistant/.env' });

async function check() {
    const key = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
    try {
        const res = await axios.get(url);
        console.log(JSON.stringify(res.data.models.map(m => m.name), null, 2));
    } catch (e) {
        console.error(e.message);
    }
}
check();
