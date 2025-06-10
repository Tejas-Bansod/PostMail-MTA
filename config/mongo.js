const { MongoClient } = require('mongodb');
const logger = require('../logger/logger');
const dotenv = require('dotenv');

dotenv.config();
let db;

async function connect() {
  try {
    const url = process.env.MONGO_URL || 'mongodb://localhost:27017';
    const dbName = process.env.MONGO_DB || 'mta_db';
    const client = new MongoClient(url); // Removed useUnifiedTopology
    await client.connect();
    db = client.db(dbName);
    await db.collection('emails').createIndex({ status: 1 });
    logger.info('MongoDB connected successfully');
    return db;
  } catch (err) {
    logger.error('MongoDB connection failed:', err.message);
    throw err;
  }
}

function getDb() {
  if (!db) {
    throw new Error('MongoDB not connected');
  }
  return db;
}

async function saveEmail(email) {
  return getDb().collection('emails').insertOne(email);
}

async function findEmail(id) {
  return getDb().collection('emails').findOne({ _id: id });
}

async function updateEmail(id, update) {
  return getDb().collection('emails').updateOne({ _id: id }, { $set: update });
}

module.exports = { connect, getDb, saveEmail, findEmail, updateEmail };