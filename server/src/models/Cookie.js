const mongoose = require('mongoose');

const cookieSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      unique: true,
      index: true,
      match: /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/,
    },
    content: {
      type: String,
      required: true,
    },
    isValid: {
      type: Boolean,
      default: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Cookie', cookieSchema);
