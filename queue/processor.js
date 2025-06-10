const logger = require('../logger/logger');
const redis = require('../config/redis');
const mongo = require('../config/mongo');
const { sendMail } = require('../SMTP/client');

const LOCK_EXPIRATION = 60;

async function processQueue(workerId) {
  let workerShouldStop = false;

  try {
    await redis.connect();
    logger.info({ message: 'Redis connected successfully in child process', workerId });
  } catch (err) {
    logger.error({ message: 'Failed to connect to Redis', workerId, error: err.message });
    process.exit(1);
  }

  try {
    logger.info({ message: 'Attempting to connect to MongoDB', workerId });
    await mongo.connect();
    logger.info({ message: 'MongoDB connected successfully in child process', workerId });
  } catch (err) {
    logger.error({ message: 'Failed to connect to MongoDB', workerId, error: err.message });
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    workerShouldStop = true;
    logger.info({ message: 'Worker received shutdown signal', workerId });
    await cleanUp();
    process.exit(0);
  });

  while (!workerShouldStop) {
    try {
      const redisClient = redis.getRedis();
      const messages = await redis.dequeueEmails(workerId, 5);

      if (!messages) {
        logger.info({ message: 'No messages in queue, waiting', workerId });
        continue;
      }

      for (const [, entries] of messages) {
        for (const [id, fields] of entries) {
          const data = {};
          for (let i = 0; i < fields.length; i += 2) {
            data[fields[i]] = fields[i + 1];
          }

          const emailId = data.emailId;
          if (!emailId) {
            logger.warn({ message: 'Skipping malformed entry', workerId, messageId: id });
            await redis.acknowledgeMessage(id);
            continue;
          }

          const lockKey = `lock:email:${emailId}`;
          const lockExists = await redisClient.exists(lockKey);
          if (lockExists) {
            logger.info({ message: 'Skipped email (lock exists)', workerId, emailId });
            continue;
          }

          const lockAcquired = await redisClient.set(lockKey, workerId, 'NX', 'EX', LOCK_EXPIRATION);
          if (!lockAcquired) {
            logger.info({ message: 'Failed to acquire lock for email', workerId, emailId });
            continue;
          }

          logger.info({ message: 'Locked and processing email', workerId, emailId });

          try {
            const email = await mongo.findEmail(emailId);
            if (email && (email.status === 'queued' || email.status === 'sending')) {
              if (email.status !== 'sending') {
                await mongo.updateEmail(emailId, { status: 'sending' });
              }

              try {
                await sendMail(email);
                await redis.acknowledgeMessage(id);
                logger.info({ message: 'Email sent successfully', workerId, emailId });
              } catch (err) {
                logger.error({ message: 'Error sending email', workerId, emailId, error: err.message });
                await handleRetry(email);
                await redis.acknowledgeMessage(id);
              }
            } else {
              logger.warn({ message: 'Email not found or invalid status', workerId, emailId, status: email?.status });
              await redis.acknowledgeMessage(id);
            }
          } finally {
            const delResponse = await redisClient.del(lockKey);
            if (delResponse === 1) {
              logger.info({ message: 'Lock for email deleted successfully', workerId, emailId });
            } else {
              logger.warn({ message: 'Failed to delete lock for email', workerId, emailId });
            }
          }
        }
      }
    } catch (err) {
      logger.error({ message: 'Queue error', workerId, error: err.message });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function handleRetry(email) {
  const retryCount = (email.retryCount || 0) + 1;
  const emailId = email._id;

  if (retryCount > 3) {
    await mongo.updateEmail(emailId, {
      status: 'failed',
      updatedAt: new Date()
    });
    logger.error({ message: 'Email failed after max retries', emailId, retryCount });
  } else {
    const nextRetry = new Date(Date.now() + 10000 * Math.pow(2, retryCount));
    await mongo.updateEmail(emailId, {
      status: 'queued',
      retryCount,
      nextRetry,
      updatedAt: new Date()
    });
    await redis.queueEmail(emailId);
    logger.info({ message: 'Email scheduled for retry', emailId, retryCount });
  }
}

async function cleanUp() {
  logger.info('Worker shutting down gracefully...');
}

process.on('message', async (msg) => {
  if (msg.workerId) {
    await processQueue(msg.workerId);
  }
});

module.exports = { processQueue };