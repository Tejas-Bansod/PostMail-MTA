const logger = require('./logger/logger');
const mongo = require('./config/mongo');
const redis = require('./config/redis');
const { startSmtpServer } = require('./SMTP/server');
const { startWorkerManager } = require('./queue/workerManager');
const dotenv = require('dotenv')

dotenv.config();

async function start() {
  try {
    await mongo.connect();
    const redisClient = await redis.connect();
    const smtpServer = startSmtpServer();

    // Start worker manager instead of fixed workers
    await startWorkerManager();

    process.on('SIGINT', () => {
      smtpServer.close(() => {
        redisClient.quit();
        logger.info('MTA shut down');
        process.exit(0);
      });
    });
  } catch (err) {
    logger.error('Startup error:', err.message);
    process.exit(1);
  }
}

start();