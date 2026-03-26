require('dotenv').config();
const Redis = require('ioredis');

async function main() {
  const redisUrl = process.env.KV_REDIS_URL || process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('❌ REDIS_URL not found in .env');
    process.exit(1);
  }

  const redis = new Redis(redisUrl);
  console.log('📡 Connecting to Redis...');

  const keys = await redis.keys('*');
  console.log(`🔍 Found ${keys.length} keys.`);

  if (keys.length > 0) {
    // We can be selective or just flushall if it's a dedicated dev DB
    // To be safe, we clear our specific prefixes:
    const prefixes = ['retry:', 'learning_state:', 'latest_learning_state_id:', 'key_status:', 'voice_session:'];
    let deletedCount = 0;
    
    for (const key of keys) {
      if (prefixes.some(p => key.startsWith(p))) {
        await redis.del(key);
        deletedCount++;
      }
    }
    console.log(`✅ Deleted ${deletedCount} project-related cache keys.`);
  } else {
    console.log('ℹ️ No keys to delete.');
  }

  redis.quit();
  console.log('🏁 Cache cleared.');
}

main().catch(console.error);
