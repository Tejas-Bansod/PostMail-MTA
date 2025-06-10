const { promises: dns } = require('dns');
const redis = require('../config/redis');
const logger = require('../logger/logger');

async function resolveMxRecords(domain) {
  const cached = await redis.getCachedMxRecords(domain);
  if (cached) {
    logger.info(`Using cached MX records for ${domain}`);
    return cached;
  }

  try {
    const records = await dns.resolveMx(domain);
    // Resolve IPv4 (A) and IPv6 (AAAA) addresses for each MX server
    for (const record of records) {
      try {
        const aRecords = await dns.resolve4(record.exchange);
        if (aRecords.length > 0) {
          record.ipv4 = aRecords[0];
          logger.info(`Resolved IPv4 for ${record.exchange}: ${record.ipv4}`);
        }
      } catch (err) {
        logger.warn(`No IPv4 for ${record.exchange}: ${err.message}`);
      }

      try {
        const aaaaRecords = await dns.resolve6(record.exchange);
        if (aaaaRecords.length > 0) {
          record.ipv6 = aaaaRecords[0];
          logger.info(`Resolved IPv6 for ${record.exchange}: ${record.ipv6}`);
        }
      } catch (err) {
        logger.warn(`No IPv6 for ${record.exchange}: ${err.message}`);
      }
    }

    await redis.cacheMxRecords(domain, records);
    logger.info(`Resolved MX records for ${domain}`);
    return records;
  } catch (err) {
    logger.error(`DNS resolution failed for ${domain}: ${err.message}`);
    throw err;
  }
}

module.exports = { resolveMxRecords };