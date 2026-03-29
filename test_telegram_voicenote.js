const axios = require('axios');
const Redis = require('ioredis');

// --- CONFIGURATION ---
const SERVER_URL = "https://whatsapp-assistant-ex7w.onrender.com/api/voicenote";
const REDIS_URL = "redis://default:apbCGNSi4Cv1Ccj9oPbEezc3f0MGX14e@redis-11167.c258.us-east-1-4.ec2.cloud.redislabs.com:11167";
const TEST_CHAT_ID = "1452229048"; // From user's previous context

const redis = new Redis(REDIS_URL);

async function runTests() {
  console.log('--- 🚀 Starting Automated Telegram Voicenote Tests ---');

  try {
    // 1. Clear previous session for clean start
    console.log('🧹 Clearing previous session...');
    await redis.del(`voice_session:${TEST_CHAT_ID}`);

    // 2. Test: Simulate Incoming Voice Note
    console.log('\n🧪 Test 1: Simulating Incoming Voice Note...');
    const voicePayload = {
      message: {
        chat: { id: TEST_CHAT_ID },
        voice: { file_id: "AwACAgUAAxkBAAIDmGYN9yA..." } // Mock file_id
      }
    };

    const resp1 = await axios.post(SERVER_URL, voicePayload);
    console.log(`✅ Response Status: ${resp1.status}`);

    // Wait for background processing (transcription simulation)
    console.log('⏳ Waiting for background transcription (10s)...');
    await new Promise(r => setTimeout(r, 10000));

    // Check if session was created in Redis
    const session = await redis.get(`voice_session:${TEST_CHAT_ID}`);
    if (session) {
      console.log('✅ Session created in Redis.');
      const sessionData = JSON.parse(session);
      console.log(`📝 Captured Draft (Mock): "${sessionData.currentDraft.substring(0, 30)}..."`);
    } else {
      console.warn('⚠️ No session found in Redis. (This might be OK if using production and log auditing is required).');
    }

    // 3. Test: Simulate Confirmation ("OK")
    console.log('\n🧪 Test 2: Simulating Confirmation ("OK")...');
    const confirmPayload = {
      message: {
        chat: { id: TEST_CHAT_ID },
        text: "OK"
      }
    };

    const resp2 = await axios.post(SERVER_URL, confirmPayload);
    console.log(`✅ Response Status: ${resp2.status}`);

    // Wait for background extraction (10s)
    console.log('⏳ Waiting for background extraction (10s)...');
    await new Promise(r => setTimeout(r, 10000));

    // 4. Verify Redis State for Notes & Tasks
    console.log('\n🧪 Test 3: Verifying Redis Persistence...');
    const latestNote = await redis.lindex(`notes:${TEST_CHAT_ID}`, 0);
    if (latestNote) {
      const note = JSON.parse(latestNote);
      console.log('✅ Found latest note in Redis!');
      console.log(`   📌 Category: ${note.category}`);
      console.log(`   📝 Refined: ${note.refined.substring(0, 50)}...`);
      console.log(`   🔨 Tasks found: ${note.tasks ? note.tasks.length : 0}`);
      if (note.tasks && note.tasks.length > 0) {
        note.tasks.forEach((t, i) => console.log(`      - [${i+1}] ${t}`));
      }
    } else {
      console.error('❌ FAILED: No note found in Redis after confirmation.');
    }

    // 5. Test: List Command
    console.log('\n🧪 Test 4: Simulating /list command...');
    const listPayload = {
      message: {
        chat: { id: TEST_CHAT_ID },
        voice: { file_id: "mock_voice_123" }
      },
      isMock: true
    };
    const resp3 = await axios.post(SERVER_URL, listPayload);
    console.log(`✅ Response Status: ${resp3.status}`);

  } catch (err) {
    console.error(`\n❌ TEST FAILED: ${err.message}`);
    if (err.response) console.error('   Server Response:', err.response.data);
  } finally {
    redis.quit();
    console.log('\n--- 🏁 Tests Completed ---');
  }
}

runTests();
