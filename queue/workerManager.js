const { fork } = require('child_process');
const logger = require('../logger/logger');
const redis = require('../config/redis');

const MIN_WORKERS = parseInt(process.env.MIN_WORKERS) || 2;
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS) || 10;
const QUEUE_THRESHOLD_HIGH = parseInt(process.env.QUEUE_THRESHOLD_HIGH) || 100;
const QUEUE_THRESHOLD_LOW = parseInt(process.env.QUEUE_THRESHOLD_LOW) || 10;
const CHECK_INTERVAL = parseInt(process.env.WORKER_CHECK_INTERVAL) || 30000; // 30 seconds
const RESTART_DELAY = 5000; // 5 seconds delay before restarting a failed worker

let workers = [];
let workerIdCounter = 0;

async function startWorkerManager() {
  try {
    const redisClient = redis.getRedis();

    // Start minimum workers
    for (let i = 0; i < MIN_WORKERS; i++) {
      spawnWorker();
    }

    // Periodically check queue length
    setInterval(async () => {
      try {
        const queueLength = await redisClient.xlen('email_queue');
        logger.info(`Queue length: ${queueLength}, Active workers: ${workers.length}`);

        // Scale up if queue is too long
        if (queueLength > QUEUE_THRESHOLD_HIGH && workers.length < MAX_WORKERS) {
          const newWorkers = Math.min(
            Math.ceil(queueLength / QUEUE_THRESHOLD_HIGH),
            MAX_WORKERS - workers.length
          );
          for (let i = 0; i < newWorkers; i++) {
            spawnWorker();
          }
          logger.info(`Spawned ${newWorkers} new workers`);
        }

        // Scale down if queue is too short
        if (queueLength < QUEUE_THRESHOLD_LOW && workers.length > MIN_WORKERS) {
          const workersToRemove = Math.min(
            workers.length - MIN_WORKERS,
            Math.ceil((workers.length - MIN_WORKERS) / 2)
          );
          for (let i = 0; i < workersToRemove; i++) {
            terminateWorker();
          }
          logger.info(`Terminated ${workersToRemove} workers`);
        }
      } catch (err) {
        logger.error('Worker manager error:', err.message);
      }
    }, CHECK_INTERVAL);
  } catch (err) {
    logger.error('Failed to start worker manager:', err.message);
    throw err;
  }
}

function spawnWorker() {
  const workerId = `Worker-${workerIdCounter++}`;
  const worker = fork('./queue/processor.js', [workerId]);

  worker.on('exit', (code) => {
    logger.info(`Worker ${workerId} exited with code ${code}`);
    workers = workers.filter(w => w !== worker);
    // Respawn worker if it failed (e.g., due to Redis connection issues)
    if (code !== 0 && workers.length < MAX_WORKERS) {
      logger.info(`Respawning worker ${workerId} after ${RESTART_DELAY}ms`);
      setTimeout(() => spawnWorker(), RESTART_DELAY);
    }
  });

  workers.push(worker);
  logger.info(`Spawned worker ${workerId}`);
  worker.send({ workerId });
}

function terminateWorker() {
  if (workers.length === 0) return;
  const worker = workers.pop();
  worker.kill('SIGINT');
}

module.exports = { startWorkerManager };