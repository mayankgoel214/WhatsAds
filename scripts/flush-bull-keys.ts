import Redis from 'ioredis';

const REDIS_URL = process.env['REDIS_URL']!;

async function main() {
  if (!REDIS_URL) {
    console.error('REDIS_URL not set');
    process.exit(1);
  }

  const redis = new Redis(REDIS_URL);

  // Find all bull:image-processing:* keys
  const keys = await redis.keys('bull:image-processing:*');
  console.log(`Found ${keys.length} bull:image-processing:* keys`);

  if (keys.length > 0) {
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.del(key);
    }
    await pipeline.exec();
    console.log(`Deleted ${keys.length} keys`);
  }

  // Check other queues
  for (const prefix of ['bull:payment-check', 'bull:session-timeout']) {
    const qKeys = await redis.keys(`${prefix}:*`);
    console.log(`Found ${qKeys.length} ${prefix}:* keys`);
  }

  await redis.quit();
  console.log('Done');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
