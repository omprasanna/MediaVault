const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema(
  {
    batchId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    playlistTitle: {
      type: String,
      default: 'Playlist Download Batch',
    },
    playlistUrl: {
      type: String,
      required: true,
    },
    totalItems: {
      type: Number,
      required: true,
    },
    completedItems: {
      type: Number,
      default: 0,
    },
    failedItems: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['processing', 'completed', 'partial_failure', 'failed'],
      default: 'processing',
    },
    rollupVersion: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Batch', batchSchema);
