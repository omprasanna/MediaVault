const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    batchId: {
      type: String,
      default: null,
      index: true,
    },
    sourceUrl: {
      type: String,
      required: true,
    },
    platform: {
      type: String,
      required: true,
      index: true,
      match: /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/,
    },
    title: {
      type: String,
      default: 'Media File',
      trim: true,
    },
    thumbnailUrl: {
      type: String,
      default: null,
    },
    duration: {
      type: Number,
      default: 0,
    },
    mode: {
      type: String,
      enum: ['video', 'audio'],
      required: true,
    },
    container: {
      type: String,
      enum: ['mp4', 'mkv', 'webm', 'mp3'],
      required: true,
    },
    formatSelector: {
      type: String,
      required: true,
    },
    useCookies: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['queued', 'downloading', 'muxing', 'paused', 'ready', 'failed', 'expired', 'cancelled'],
      default: 'queued',
      index: true,
    },
    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    downloadSpeed: {
      type: String,
      default: null,
    },
    eta: {
      type: String,
      default: null,
    },
    filePath: {
      type: String,
      default: null,
    },
    fileName: {
      type: String,
      default: null,
    },
    fileSizeBytes: {
      type: Number,
      default: 0,
    },
    totalSizeBytes: {
      type: Number,
      default: 0,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound index for fast user job history queries.
jobSchema.index({ userId: 1, createdAt: -1 });

// Non-TTL index for storage cleanup sweep lookups; expiration preserves history and reconciles batches.
jobSchema.index({ expiresAt: 1 });

/**
 * Drops any legacy MongoDB TTL index on `expiresAt` (which silently purged documents
 * without reconciling parent batch rollups) and ensures the plain query index exists.
 */
jobSchema.statics.ensureNonTtlExpiresIndex = async function ensureNonTtlExpiresIndex() {
  let indexes = [];
  try {
    indexes = await this.collection.indexes();
  } catch (err) {
    if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) {
      await this.createIndexes();
      return;
    }
    throw err;
  }

  for (const idx of indexes) {
    if (
      idx &&
      idx.key &&
      idx.key.expiresAt === 1 &&
      Object.keys(idx.key).length === 1 &&
      typeof idx.expireAfterSeconds === 'number'
    ) {
      try {
        await this.collection.dropIndex(idx.name);
      } catch (err) {
        // API and worker processes can race while removing this legacy index.
        if (err?.codeName !== 'IndexNotFound' && err?.code !== 27) {
          throw err;
        }
      }
    }
  }

  await this.createIndexes();
};

module.exports = mongoose.model('Job', jobSchema);
