const Redis = require('ioredis');
const redis = new Redis('redis://default:apbCGNSi4Cv1Ccj9oPbEezc3f0MGX14e@redis-11167.c258.us-east-1-4.ec2.cloud.redislabs.com:11167');

async function cleanup() {
  try {
    console.log('--- 🧹 Redis Cleanup Started ---');

    // 1. Delete all separate retry:task keys (old format)
    const keys = await redis.keys('retry:task:*');
    if (keys.length > 0) {
      console.log(`🗑️ Deleting ${keys.length} old retry:task:* keys...`);
      await redis.del(...keys);
    } else {
      console.log('✅ No old format keys found.');
    }

    // 2. Handle the retry:task Hash
    const tasks = await redis.hgetall('retry:task');
    const now = Date.now();
    let deletedHashFields = 0;

    for (const [id, raw] of Object.entries(tasks)) {
      const task = JSON.parse(raw);
      const startTime = task.startTime || task.queuedAt || 0;
      const ageHours = (now - startTime) / (1000 * 60 * 60);

      // If stuck (isProcessing) and older than 1 hour, or just very old (> 48h)
      if ((task.isProcessing && ageHours > 1) || ageHours > 48) {
        console.log(`🗑️ Removing stuck/old task: ${id} (Age: ${ageHours.toFixed(1)}h)`);
        await redis.hdel('retry:task', id);
        await redis.srem('retry:pending', id);
        deletedHashFields++;
      }
    }
    console.log(`✅ Cleaned up ${deletedHashFields} fields from retry:task hash.`);

    // 3. Final verification of retry:pending
    const pending = await redis.smembers('retry:pending');
    for (const id of pending) {
      const exists = await redis.hexists('retry:task', id);
      if (!exists) {
        console.log(`🗑️ Removing dangling ID from retry:pending: ${id}`);
        await redis.srem('retry:pending', id);
      }
    }

    console.log('--- ✨ Cleanup Complete ---');
  } catch (err) {
    console.error('❌ Error during cleanup:', err.message);
  } finally {
    redis.quit();
  }
}

cleanup();
