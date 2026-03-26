require('dotenv').config();
const axios = require('axios');

async function main() {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const apiKeys = GEMINI_API_KEY.split(',').map(k => k.trim().replace(/^"|"$/g, ''));
    const key = apiKeys[0];
    
    try {
        console.log('Checking v1beta models...');
        const resp = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        console.log('Available Models (v1beta):');
        resp.data.models.forEach(m => console.log(`- ${m.name}`));
    } catch (err) {
        console.error('v1beta Failed:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
    }

    try {
        console.log('\nChecking v1 models...');
        const resp = await axios.get(`https://generativelanguage.googleapis.com/v1/models?key=${key}`);
        console.log('Available Models (v1):');
        resp.data.models.forEach(m => console.log(`- ${m.name}`));
    } catch (err) {
        console.error('v1 Failed:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
    }
}

main();
