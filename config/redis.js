const Redis = require('ioredis');
const logger = require('../logger/logger');
const dotenv = require('dotenv')

dotenv.config();

let redis;

// Configurable rate limits
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE) || 20;
const RATE_LIMIT_WINDOW_SECONDS = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS) || 60;
const USER_RATE_LIMIT_PER_MINUTE = parseInt(process.env.USER_RATE_LIMIT_PER_MINUTE) || 50;

function connect() {
  return new Promise((resolve, reject) => {
    try {
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT) || 6379;
      redis = new Redis({
        host,
        port,
        retryStrategy: times => Math.min(times * 50, 2000)
      });

      redis.on('connect', async () => {
        logger.info('Redis connected successfully');
        await initConsumerGroup();
        resolve(redis);
      });

      redis.on('error', err => {
        logger.error('Redis error:', err.message);
        reject(err);
      });
    } catch (err) {
      logger.error('Redis connection failed:', err.message);
      reject(err);
    }
  });
}

async function initConsumerGroup() {
  try {
    await redis.xgroup('CREATE', 'email_queue', 'email_group', '$', 'MKSTREAM').catch(err => {
      if (err.message.includes('BUSYGROUP')) {
        logger.info('Consumer group email_group already exists');
      } else {
        throw err;
      }
    });
    logger.info('Initialized consumer group email_group for email_queue');
  } catch (err) {
    logger.error('Failed to initialize consumer group:', err.message);
    throw err;
  }
}

function getRedis() {
  if (!redis) {
    throw new Error('Redis not connected');
  }
  return redis;
}

async function queueEmail(emailId) {
  try {
    await redis.xadd('email_queue', '*', 'emailId', emailId);
    logger.info(`Queued email ${emailId} in Redis`);
  } catch (err) {
    logger.error('Failed to queue email:', err.message);
    throw err;
  }
}

async function dequeueEmails(workerId, count = 5) {
  try {
    return await redis.xreadgroup('GROUP', 'email_group', workerId, 'COUNT', count, 'BLOCK', 5000, 'STREAMS', 'email_queue', '>');
  } catch (err) {
    logger.error('Failed to dequeue emails:', err.message);
    throw err;
  }
}

async function acknowledgeMessage(messageId) {
  try {
    await redis.xack('email_queue', 'email_group', messageId);
    logger.info(`Acknowledged message ${messageId}`);
  } catch (err) {
    logger.error('Failed to acknowledge message:', err.message);
    throw err;
  }
}

async function deleteQueueEntry(id) {
  try {
    await redis.xdel('email_queue', id);
  } catch (err) {
    logger.error('Failed to delete queue entry:', err.message);
    throw err;
  }
}

async function cacheMxRecords(domain, records) {
  try {
    await redis.setex(`mx:${domain}`, 3600, JSON.stringify(records));
    logger.info(`Cached MX records for ${domain}`);
  } catch (err) {
    logger.error('Failed to cache MX records:', err.message);
    throw err;
  }
}

async function getCachedMxRecords(domain) {
  try {
    const cached = await redis.get(`mx:${domain}`);
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    logger.error('Failed to retrieve cached MX records:', err.message);
    throw err;
  }
}

async function checkRateLimit(domain) {
  try {
    const key = `rate:domain:${domain}:${Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000))}`;
    const count = await redis.incr(key);
    await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    const withinLimit = count <= RATE_LIMIT_PER_MINUTE;
    if (!withinLimit) {
      logger.warn(`Rate limit exceeded for domain ${domain}: ${count}/${RATE_LIMIT_PER_MINUTE}`);
    }
    return withinLimit;
  } catch (err) {
    logger.error('Failed to check domain rate limit:', err.message);
    throw err;
  }
}

async function checkUserRateLimit(user) {
  try {
    const key = `rate:user:${user}:${Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000))}`;
    const count = await redis.incr(key);
    await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    const withinLimit = count <= USER_RATE_LIMIT_PER_MINUTE;
    if (!withinLimit) {
      logger.warn(`Rate limit exceeded for user ${user}: ${count}/${USER_RATE_LIMIT_PER_MINUTE}`);
    }
    return withinLimit;
  } catch (err) {
    logger.error('Failed to check user rate limit:', err.message);
    throw err;
  }
}

async function isSenderBlacklisted(sender) {
  try {
    const blacklisted = await redis.sismember('sender_blacklist', sender);
    return blacklisted === 1;
  } catch (err) {
    logger.error('Failed to check sender blacklist:', err.message);
    throw err;
  }
}

async function blacklistSender(sender) {
  try {
    await redis.sadd('sender_blacklist', sender);
    logger.info(`Sender ${sender} added to blacklist`);
  } catch (err) {
    logger.error('Failed to blacklist sender:', err.message);
    throw err;
  }
}

module.exports = {
  connect,
  getRedis,
  queueEmail,
  dequeueEmails,
  acknowledgeMessage,
  deleteQueueEntry,
  cacheMxRecords,
  getCachedMxRecords,
  checkRateLimit,
  checkUserRateLimit,
  isSenderBlacklisted,
  blacklistSender
};