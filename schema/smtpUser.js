const logger = require('../logger/logger');
const mongo = require('../config/mongo');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

// Updated schema structure
const smtpUserSchema = {
  username: String,     // Unique username for SMTP authentication
  password: String,     // Hashed password
  status: String,       // 'active' or 'blocked'
  createdAt: Date,      // When the user was created
  updatedAt: Date       // When the user was last updated
};

// Function to hash a password
async function hashPassword(password) {
  try {
    return await bcrypt.hash(password, SALT_ROUNDS);
  } catch (err) {
    logger.error('Error hashing password:', err.message);
    throw err;
  }
}

// Function to compare a password with its hash
async function comparePassword(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch (err) {
    logger.error('Error comparing password:', err.message);
    throw err;
  }
}

// Function to create a new SMTP user
async function createUser(username, password) {
  try {
    const hashedPassword = await hashPassword(password);
    const user = {
      username,
      password: hashedPassword,
      status: 'active',  // Default status
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const db = mongo.getDb();
    await db.collection('smtp_users').createIndex({ username: 1 }, { unique: true });
    await db.collection('smtp_users').insertOne(user);
    logger.info(`SMTP user ${username} created with status: ${user.status}`);
    return user;
  } catch (err) {
    logger.error('Error creating SMTP user:', err.message);
    throw err;
  }
}

// Function to find a user by username
async function findUserByUsername(username) {
  try {
    const db = mongo.getDb();
    return await db.collection('smtp_users').findOne({ username });
  } catch (err) {
    logger.error('Error finding SMTP user:', err.message);
    throw err;
  }
}

// Function to authenticate a user
async function authenticateUser(username, password) {
  try {
    const user = await findUserByUsername(username);
    if (!user) {
      return { success: false, message: 'User not found' };
    }
    if (user.status === 'blocked') {
      return { success: false, message: 'User is blocked from sending emails' };
    }
    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) {
      return { success: false, message: 'Invalid password' };
    }
    return { success: true, user };
  } catch (err) {
    logger.error('Error authenticating user:', err.message);
    return { success: false, message: err.message };
  }
}

// Function to block a user
async function blockUser(username) {
  try {
    const db = mongo.getDb();
    const result = await db.collection('smtp_users').updateOne(
      { username },
      { $set: { status: 'blocked', updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) {
      throw new Error('User not found');
    }
    logger.info(`User ${username} blocked`);
    return { success: true, message: `User ${username} blocked` };
  } catch (err) {
    logger.error('Error blocking user:', err.message);
    throw err;
  }
}

// Function to unblock a user
async function unblockUser(username) {
  try {
    const db = mongo.getDb();
    const result = await db.collection('smtp_users').updateOne(
      { username },
      { $set: { status: 'active', updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) {
      throw new Error('User not found');
    }
    logger.info(`User ${username} unblocked`);
    return { success: true, message: `User ${username} unblocked` };
  } catch (err) {
    logger.error('Error unblocking user:', err.message);
    throw err;
  }
}

// Function to get user status
async function getUserStatus(username) {
  try {
    const user = await findUserByUsername(username);
    if (!user) {
      throw new Error('User not found');
    }
    return { success: true, status: user.status };
  } catch (err) {
    logger.error('Error getting user status:', err.message);
    throw err;
  }
}

module.exports = {
  smtpUserSchema,
  createUser,
  findUserByUsername,
  authenticateUser,
  blockUser,
  unblockUser,
  getUserStatus
};