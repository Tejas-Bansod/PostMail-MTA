const net = require('net');
const tls = require('tls');
const logger = require('../logger/logger');
const mongo = require('../config/mongo');
const redis = require('../config/redis');
const { resolveMxRecords } = require('../utils/dns');
const { DKIMSign } = require('dkim-signer');

const dkimPrivateKey = process.env.DKIM_PRIVATE_KEY; // Load from environment variable

if (!dkimPrivateKey) {
  throw new Error('DKIM_PRIVATE_KEY environment variable is not set');
}

async function sendMail(email) {
  const { from, to, subject, body, _id: emailId } = email;

  if (!to || !Array.isArray(to) || to.length === 0) {
    logger.error(`Email ${emailId} has invalid recipient: ${to}`);
    await mongo.updateEmail(emailId, { status: 'failed', updatedAt: new Date() });
    throw new Error('Invalid recipient');
  }

  const domain = to[0].split('@')[1];
  if (!domain) {
    logger.error(`Email ${emailId} has invalid recipient domain: ${to[0]}`);
    await mongo.updateEmail(emailId, { status: 'failed', updatedAt: new Date() });
    throw new Error('Invalid recipient domain');
  }

  if (!(await redis.checkRateLimit(domain))) {
    throw new Error(`Rate limit exceeded for ${domain}`);
  }

  const mxRecords = await resolveMxRecords(domain);
  const mx = mxRecords.sort((a, b) => a.priority - b.priority)[0];
  logger.info(`Sending email ${emailId} to ${mx.exchange}`);

  const message = [
    `Subject: ${subject}`,
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    '',
    body
  ].join('\r\n');

  const dkimHeader = DKIMSign(message, {
    privateKey: dkimPrivateKey,
    domainName: 'flashsend.in',
    selector: 'mail'
  });

  const signedEmail = `${dkimHeader}\r\n${message}`;

  return new Promise((resolve, reject) => {
    let socket;
    let stage = 'connect';
    let isTls = false;
    let buffer = '';

    const send = (line) => {
      logger.info(`>>> ${line}`);
      socket.write(line + '\r\n');
    };

    const fail = async (reason, permanent = false) => {
      socket.end();
      await mongo.updateEmail(emailId, {
        status: permanent ? 'failed' : 'retry',
        updatedAt: new Date()
      });
      logger.error(`[SMTP][${stage}] ${reason}`);
      reject(new Error(reason));
    };

    const next = async (code, text) => {
      logger.info(`<<< ${text.trim()}`);
      if (code.startsWith('4')) return fail(`Transient error: ${code}`, false);
      if (code.startsWith('5')) return fail(`Permanent error: ${code}`, true);

      switch (stage) {
        case 'connect':
          stage = 'ehlo';
          send('EHLO localhost');
          break;

        case 'ehlo':
          if (!isTls && /STARTTLS/i.test(buffer)) {
            stage = 'starttls';
            send('STARTTLS');
          } else {
            stage = 'mailfrom';
            send(`MAIL FROM:<${from}>`);
          }
          break;

        case 'starttls':
          buffer = '';
          socket.removeAllListeners('data');
          socket = tls.connect({ socket, rejectUnauthorized: false }, () => {
            logger.info(`[SMTP] TLS handshake completed`);
            isTls = true;
            stage = 'ehlo_tls';
            send('EHLO localhost');
          });
          socket.on('data', handleData);
          socket.on('error', handleError);
          break;

        case 'ehlo_tls':
          stage = 'mailfrom';
          send(`MAIL FROM:<${from}>`);
          break;

        case 'mailfrom':
          stage = 'rcptto';
          send(`RCPT TO:<${to[0]}>`);
          break;

        case 'rcptto':
          stage = 'data';
          send('DATA');
          break;

        case 'data':
          stage = 'sending';
          send(signedEmail + '\r\n.');
          break;

        case 'sending':
          stage = 'quit';
          send('QUIT');
          break;

        case 'quit':
          socket.end();
          await mongo.updateEmail(emailId, { status: 'sent', updatedAt: new Date() });
          logger.info(`Email ${emailId} sent successfully`);
          resolve('Email sent');
          break;
      }
    };

    const handleData = (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      for (let line of lines) {
        const match = line.match(/^(\d{3})(?:[ -])(.*)$/);
        if (match) {
          const [_, code, message] = match;
          if (!line.startsWith('250-') || stage === 'ehlo_tls') {
            buffer = ''; // reset buffer for next command
            next(code, message);
          }
        }
      }
    };

    const handleError = (err) => {
      fail(`SMTP client error: ${err.message}`, false);
    };

    const ip = mx.ipv4 || mx.ipv6;
    if (!ip) return reject(new Error(`No IP address resolved for ${mx.exchange}`));
    logger.info(`Connecting to ${mx.exchange} (${ip}) on port 587`);
    socket = net.connect(587, ip);

    socket.setTimeout(30000);
    socket.on('connect', () => logger.info(`Connected to ${mx.exchange}:587`));
    socket.on('data', handleData);
    socket.on('error', handleError);
    socket.on('timeout', () => fail('SMTP timeout', false));
  });
}

module.exports = { sendMail };