'use strict';

const { DevicePushToken, ANDROID_APP_ID } = require('./devicePushToken.model');

const normalizeToken = (value) => String(value || '').trim();

const registerPushToken = async ({ userId, token, platform }) => {
    const normalizedToken = normalizeToken(token);
    const now = new Date();
    const device = await DevicePushToken.findOneAndUpdate(
        { token: normalizedToken },
        {
            $set: {
                userId,
                platform,
                appId: ANDROID_APP_ID,
                isActive: true,
                lastSeenAt: now,
            },
            $setOnInsert: { token: normalizedToken },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return {
        id: device._id,
        platform: device.platform,
        appId: device.appId,
        isActive: device.isActive,
        lastSeenAt: device.lastSeenAt,
    };
};

const unregisterPushToken = async ({ userId, token }) => {
    const result = await DevicePushToken.updateOne(
        { userId, token: normalizeToken(token) },
        { $set: { isActive: false, lastSeenAt: new Date() } }
    );
    return { deactivated: result.modifiedCount > 0 };
};

const getActiveAndroidTokens = async (userIds = null) => {
    const filter = { platform: 'android', appId: ANDROID_APP_ID, isActive: true };
    if (Array.isArray(userIds)) filter.userId = { $in: userIds };
    return DevicePushToken.find(filter).select('+token userId').lean();
};

const deactivateTokens = async (tokens = []) => {
    const normalized = [...new Set(tokens.map(normalizeToken).filter(Boolean))];
    if (!normalized.length) return;
    await DevicePushToken.updateMany(
        { token: { $in: normalized } },
        { $set: { isActive: false, lastSeenAt: new Date() } }
    );
};

module.exports = {
    registerPushToken,
    unregisterPushToken,
    getActiveAndroidTokens,
    deactivateTokens,
};
