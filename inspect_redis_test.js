const Redis = require('ioredis');
const KV_REDIS_URL = "redis://default:apbCGNSi4Cv1Ccj9oPbEezc3f0MGX14e@redis-11167.c258.us-east-1-4.ec2.cloud.redislabs.com:11167";

async function inspectRedis() {
  const redis = new Redis(KV_REDIS_URL);
  console.log('🔍 Inspecting Redis for test number +85200000000...');
  
  try {
    const allKeys = await redis.keys('*');
    console.log(`Total keys: ${allKeys.length}`);
    for (const k of allKeys) {
      const type = await redis.type(k);
      const val = type === 'string' ? await redis.get(k) : 'complex-type';
      console.log(`[${type}] ${k} -> ${val}`);
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    redis.disconnect();
  }
}

inspectRedis();
