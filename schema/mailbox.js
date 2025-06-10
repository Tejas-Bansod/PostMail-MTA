const logger = require('../logger/logger');
const mongo = require('../config/mongo');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Define the mailbox structure (stored in MongoDB)
const mailboxSchema = {
  username: String, // e.g., "user" for user@flashsend.in
  emailId: String,  // Unique email ID
  from: String,
  to: [String],
  subject: String,
  body: String,
  receivedAt: Date,
  diskPath: String  // Path to the email file on disk
};

// Directory to store emails on disk (maildir structure)
const MAILBOX_DIR = path.join(__dirname, '../../mailboxes');

// Ensure mailbox base directory exists
if (!fs.existsSync(MAILBOX_DIR)) {
  fs.mkdirSync(MAILBOX_DIR, { recursive: true });
}

async function deliverEmail(email) {
  try {
    const { from, to, subject, body } = email;
    const username = to[0].split('@')[0]; // e.g., "user" from user@flashsend.in
    const emailId = email._id;

    // Set up maildir structure: tmp/, new/, cur/
    const userDir = path.join(MAILBOX_DIR, username);
    const tmpDir = path.join(userDir, 'tmp');
    const newDir = path.join(userDir, 'new');
    const curDir = path.join(userDir, 'cur');

    [userDir, tmpDir, newDir, curDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    // Generate a unique filename for the email (maildir format)
    const timestamp = Date.now();
    const uniqueId = crypto.randomUUID();
    const filename = `${timestamp}.${uniqueId}.${process.pid}`;
    const tmpPath = path.join(tmpDir, filename);
    const newPath = path.join(newDir, filename);

    // Write the email to tmp/ first
    const emailContent = [
      `From: ${from}`,
      `To: ${to.join(', ')}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      '',
      body
    ].join('\r\n');
    fs.writeFileSync(tmpPath, emailContent);

    // Move to new/ (indicates the email is ready for reading)
    fs.renameSync(tmpPath, newPath);

    // Store email metadata in MongoDB
    const emailEntry = {
      username,
      emailId,
      from,
      to,
      subject,
      body,
      receivedAt: new Date(),
      diskPath: newPath
    };
    const db = mongo.getDb();
    await db.collection('mailbox').insertOne(emailEntry);

    logger.info(`Delivered email ${emailId} to mailbox for ${username} at ${newPath}`);
    return { success: true, message: `Delivered to ${username}` };
  } catch (err) {
    logger.error(`Failed to deliver email: ${err.message}`);
    throw err;
  }
}

async function getEmailsForUser(username) {
  try {
    const db = mongo.getDb();
    return await db.collection('mailbox').find({ username }).toArray();
  } catch (err) {
    logger.error(`Failed to retrieve emails for ${username}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  mailboxSchema,
  deliverEmail,
  getEmailsForUser
};