const mongoose = require('mongoose');

const DEFAULT_MONGO_URI = 'mongodb://mongo:27017/mediavault';

/**
 * Establishes a MongoDB connection using Mongoose if not already connected.
 *
 * @returns {Promise<typeof mongoose>}
 */
async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  const uri = process.env.MONGO_URI || DEFAULT_MONGO_URI;
  await mongoose.connect(uri);
  return mongoose;
}

/**
 * Gracefully closes the active MongoDB connection.
 */
async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

module.exports = {
  connectDB,
  disconnectDB,
};
