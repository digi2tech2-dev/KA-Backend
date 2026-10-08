'use strict';

const mongoose = require('mongoose');

const ANDROID_APP_ID = 'com.adcard.app';

const devicePushTokenSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    token: {
        type: String,
        required: true,
        unique: true,
        select: false,
        trim: true,
    },
    platform: {
        type: String,
        enum: ['android'],
        required: true,
        default: 'android',
    },
    appId: {
        type: String,
        required: true,
        default: ANDROID_APP_ID,
        enum: [ANDROID_APP_ID],
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true,
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
    },
}, { timestamps: true, versionKey: false });

devicePushTokenSchema.index({ userId: 1, isActive: 1 });

const DevicePushToken = mongoose.model('DevicePushToken', devicePushTokenSchema);

module.exports = { DevicePushToken, ANDROID_APP_ID };
