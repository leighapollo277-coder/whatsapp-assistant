const Redis = require('ioredis');
const redis = new Redis("redis://default:apbCGNSi4Cv1Ccj9oPbEezc3f0MGX14e@redis-11167.c258.us-east-1-4.ec2.cloud.redislabs.com:11167");

async function checkTasks() {
  try {
    const pending = await redis.smembers('retry:pending');
    console.log('Pending Tasks:', pending);
    
    for (const code of pending) {
      const data = await redis.get(`retry:task:${code}`);
      const lock = await redis.get(`lock:task:${code}`);
      console.log(`Task ${code}:`, data);
      console.log(`Lock ${code}:`, lock);
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    redis.quit();
  }
}

checkTasks();
