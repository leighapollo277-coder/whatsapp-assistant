const { callGeminiApi } = require('../api/lib/processor');
const axios = require('axios');
const assert = require('assert');

/**
 * Mock Redis Client for testing
 */
class MockRedis {
  constructor() {
    this.store = {};
  }
  async get(key) {
    return this.store[key] || null;
  }
  async set(key, value, mode, ttl) {
    this.store[key] = value;
    return "OK";
  }
}

/**
 * Automated Test: Verification of Gemini API Key Rotation & Health Tracking
 */
async function runRotationTest() {
  console.log("🚀 Starting Automated Rotation Test...");
  const mockRedis = new MockRedis();
  const keysStr = "KEY_429, KEY_500, KEY_VALID";
  const models = ["gemini-1.5-flash"];
  
  let attemptCount = 0;
  const originalPost = axios.post;

  // Mock Axios to simulate different API behaviors
  axios.post = async (url, payload) => {
    attemptCount++;
    const key = url.split('key=')[1];
    
    if (key === "KEY_429") {
      throw { response: { status: 429, data: { error: { message: "Quota exceeded" } } } };
    }
    if (key === "KEY_500") {
      throw { response: { status: 500, data: { error: { message: "Internal Server Error" } } } };
    }
    if (key === "KEY_VALID") {
      return { 
        data: { 
          candidates: [{ 
            content: { parts: [{ text: "Rotation successful!" }] },
            finishReason: "STOP" 
          }] 
        } 
      };
    }
    return originalPost(url, payload);
  };

  try {
    // Phase 1: Verify basic rotation
    console.log("\n--- Phase 1: Basic Rotation ---");
    const result1 = await callGeminiApi(models, "Test", keysStr, null, null, null, mockRedis);
    console.log("Result:", result1.candidates[0].content.parts[0].text);
    // With 3 keys, it should take between 1 and 3 attempts depending on where the random start is.
    // If it starts at KEY_VALID, it's 1 attempt. If it starts at KEY_429, it could be up to 3.
    assert(attemptCount >= 1 && attemptCount <= 3, `Should have attempted between 1 and 3 times (Actual: ${attemptCount})`);
    console.log(`✅ Phase 1 Passed: Succeeded in ${attemptCount} attempts.`);

    // Phase 2: Verify Health Tracking (Cooldown)
    console.log("\n--- Phase 2: Health Tracking (Cooldown) ---");
    attemptCount = 0;
    const result2 = await callGeminiApi(models, "Test 2", keysStr, null, null, null, mockRedis);
    // Should skip KEY_429 and KEY_500 because they are marked in Redis
    assert.strictEqual(attemptCount, 1, "Should have skipped to valid key immediately due to cooldowns");
    console.log("✅ Phase 2 Passed: Successfully skipped keys in cooldown.");

    // Phase 3: Verify Error Awareness (400 should not rotate)
    console.log("\n--- Phase 3: Non-Retryable Error (400) ---");
    axios.post = async () => {
       throw { response: { status: 400, data: { error: { message: "Bad Request" } } } };
    };
    try {
      await callGeminiApi(models, "Bad Prompt", keysStr, null, null, null, mockRedis);
      assert.fail("Should have thrown error on 400");
    } catch (e) {
      assert(e.message.includes("Gemini Error: Bad Request"), "Should surface the 400 error message");
      console.log("✅ Phase 3 Passed: 400 Error stopped rotation correctly.");
    }

    console.log("\n🏁 ALL ROTATION TESTS PASSED!");
  } catch (err) {
    console.error("\n❌ TEST FAILED:", err.message);
    process.exit(1);
  } finally {
    axios.post = originalPost;
  }
}

runRotationTest();
