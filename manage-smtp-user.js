const logger = require('./logger/logger');
const mongo = require('./config/mongo');
const { createUser, blockUser, unblockUser, getUserStatus } = require('./schema/smtpUser');

// Function to manage users based on command-line arguments
async function manageUser() {
  try {
    await mongo.connect();

    const action = process.argv[2]; // e.g., create, block, unblock, status
    const username = process.argv[3];
    const password = process.argv[4];

    if (!action || !username) {
      throw new Error('Usage: node manage-smtp-user.js <action> <username> [password]\nActions: create, block, unblock, status');
    }

    switch (action) {
      case 'create':
        if (!password) {
          throw new Error('Password required for create action');
        }
        await createUser(username, password);
        logger.info(`User ${username} created`);
        break;

      case 'block':
        await blockUser(username);
        logger.info(`User ${username} blocked`);
        break;

      case 'unblock':
        await unblockUser(username);
        logger.info(`User ${username} unblocked`);
        break;

      case 'status':
        const statusResult = await getUserStatus(username);
        logger.info(`User ${username} status: ${statusResult.status}`);
        break;

      default:
        throw new Error('Invalid action. Use: create, block, unblock, status');
    }

    process.exit(0);
  } catch (err) {
    logger.error('Error managing user:', err.message);
    process.exit(1);
  }
}

manageUser();