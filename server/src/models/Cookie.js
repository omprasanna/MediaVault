const mongoose = require('mongoose');

const cookieSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: ['youtube', 'instagram', 'facebook', 'x', 'dailymotion'],
      required: true,
      unique: true,
      index: true,
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
