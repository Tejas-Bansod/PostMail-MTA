const redis = require('./config/redis');

redis.connect().then(async () => {
  for (let i = 0; i < 10; i++) { // Reduced to 10 for testing
    await redis.queueEmail(`test-email-${i}`); // Replace with a valid email ID in the format below
    // Example: await redis.queueEmail(`test${i}@example.com`);
  }
  console.log('Queued 10 emails');
  process.exit(0);
});