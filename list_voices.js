const { EdgeTTS } = require('node-edge-tts');

async function main() {
    try {
        const tts = new EdgeTTS();
        const voices = await tts.getVoices();
        const hkVoices = voices.filter(v => v.Name.includes('HK') || v.Locale === 'zh-HK');
        console.log('--- Cantonese Voices (zh-HK) ---');
        console.log(JSON.stringify(hkVoices, null, 2));
    } catch (err) {
        console.error('Error fetching voices:', err.message);
    }
}

main();
