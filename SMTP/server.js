const { SMTPServer } = require('smtp-server');
const crypto = require('crypto');
const logger = require('../logger/logger');
const mongo = require('../config/mongo');
const redis = require('../config/redis');
const { authenticateUser } = require('../schema/smtpUser');
const { deliverEmail } = require('../schema/mailbox');
const emailValidator = require('email-validator');
const sanitizeHtml = require('sanitize-html');

function startSmtpServer() {
  const server = new SMTPServer({
    secure: true,
    allowInsecureAuth: false,
    onAuth(auth, session, callback) {
      authenticateUser(auth.username, auth.password)
        .then(result => {
          if (result.success) {
            session.user = result.user.username; // Store user in session
            callback(null, { user: result.user.username });
          } else {
            callback(new Error(result.message));
          }
        })
        .catch(err => {
          logger.error('Authentication error:', err.message);
          callback(new Error('Authentication failed'));
        });
    },
    onMailFrom(address, session, callback) {
      const sender = address.address;
      if (!emailValidator.validate(sender)) {
        logger.error(`Invalid sender email: ${sender}`);
        return callback(new Error('Invalid sender email'));
      }

      // Check sender blacklist
      redis.isSenderBlacklisted(sender)
        .then(blacklisted => {
          if (blacklisted) {
            logger.warn(`Sender ${sender} is blacklisted`);
            return callback(new Error('Sender is blacklisted'));
          }
          session.envelopeFrom = sender;
          logger.info(`MAIL FROM: ${sender}`);
          callback();
        })
        .catch(err => {
          logger.error('Error checking sender blacklist:', err.message);
          callback(new Error('Internal server error'));
        });
    },
    onRcptTo(address, session, callback) {
      const recipient = address.address;
      if (!emailValidator.validate(recipient)) {
        logger.error(`Invalid recipient email: ${recipient}`);
        return callback(new Error('Invalid recipient email'));
      }
      if (!session.envelopeTo) {
        session.envelopeTo = [];
      }
      session.envelopeTo.push(recipient);
      logger.info(`RCPT TO: ${recipient}`);
      callback();
    },
    onData(stream, session, callback) {
      let message = '';
      stream.on('data', chunk => message += chunk);
      stream.on('end', async () => {
        try {
          // Check user rate limit
          const user = session.user;
          if (!user) {
            throw new Error('User not authenticated');
          }
          const withinUserLimit = await redis.checkUserRateLimit(user);
          if (!withinUserLimit) {
            logger.warn(`User ${user} exceeded rate limit`);
            // Blacklist sender after exceeding rate limit
            await redis.blacklistSender(session.envelopeFrom);
            return callback(new Error('User rate limit exceeded'));
          }

          const sanitizedBody = sanitizeHtml(message, {
            allowedTags: [],
            allowedAttributes: {}
          });

          const emailId = crypto.randomUUID();
          const email = {
            _id: emailId,
            from: session.envelopeFrom || 'unknown',
            to: session.envelopeTo || [],
            subject: message.match(/Subject: (.*)\r\n/)?.[1] || 'No Subject',
            body: sanitizedBody,
            status: 'queued',
            retryCount: 0,
            createdAt: new Date()
          };

          if (!email.from || email.to.length === 0) {
            logger.error(`Invalid email data: from=${email.from}, to=${email.to}`);
            callback(new Error('Invalid sender or recipient'));
            return;
          }

          const localDomain = 'flashsend.in';
          const localRecipients = email.to.filter(recipient => recipient.endsWith(`@${localDomain}`));
          const externalRecipients = email.to.filter(recipient => !recipient.endsWith(`@${localDomain}`));

          if (localRecipients.length > 0) {
            const localEmail = { ...email, to: localRecipients };
            await deliverEmail(localEmail);
          }

          if (externalRecipients.length > 0) {
            const externalEmail = { ...email, to: externalRecipients };
            await mongo.saveEmail(externalEmail);
            await redis.queueEmail(emailId);
            logger.info(`Email ${emailId} queued from ${email.from} to ${externalRecipients.join(', ')}`);
          }

          callback(null, '250 Message processed');
        } catch (err) {
          logger.error('Error processing email:', err.message);
          callback(err);
        }
      });
    }
  });

  const port = parseInt(process.env.SMTP_PORT) || 465;
  server.listen(port, () => {
    logger.info(`SMTP server running on port ${port}`);
  });

  return server;
}

module.exports = { startSmtpServer };