require('dotenv').config();
const { generateAndSendVoice } = require('./api/lib/processor');

const mockMessaging = {
  sendText: async (t) => console.log('   [TEXT]', t),
  sendVoice: async (url, cap) => console.log('   [VOICE]', url, cap || '')
};

async function main() {
  console.log('--- Debugging Voice Generation ---');
  
  console.log('\n--- Request 1: Quantum ---');
  await generateAndSendVoice("量子糾喚係一個好有趣嘅內容。", mockMessaging, "🎙️ 正在生成 1...", true);
  
  console.log('\n--- Request 2: Relativity ---');
  await generateAndSendVoice("相對論係愛因斯坦提出嘅。", mockMessaging, "🎙️ 正在生成 2...", true);
  
  console.log('\n--- Done ---');
}

main().catch(console.error);
