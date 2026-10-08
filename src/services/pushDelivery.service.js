'use strict';

const { getMessaging } = require('firebase-admin/messaging');
const { getFirebaseApp } = require('./firebaseAdmin.service');
const { getActiveAndroidTokens, deactivateTokens } = require('../modules/pushTokens/devicePushToken.service');
const { getSafeInternalRoute } = require('../shared/utils/safeInternalRoute');

const FCM_BATCH_SIZE = 500;
const INVALID_TOKEN_CODES = new Set([
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered',
]);

const buildMessage = ({ title, message, notificationId, type, route }) => ({
    notification: { title: String(title || 'AD CARD'), body: String(message || '') },
    data: {
        notificationId: String(notificationId || ''),
        type: String(type || 'INFO'),
        route: getSafeInternalRoute(route),
    },
    android: {
        priority: 'high',
        notification: { channelId: 'adcard_general', sound: 'default' },
    },
});

const sendToTokens = async (tokens, payload, options = {}) => {
    if (!tokens.length) return { sent: 0 };
    const app = options.app || getFirebaseApp();
    if (!app) return { sent: 0, disabled: true };

    const messaging = options.messaging || getMessaging(app);
    const invalidTokens = [];
    let sent = 0;
    for (let index = 0; index < tokens.length; index += FCM_BATCH_SIZE) {
        const batch = tokens.slice(index, index + FCM_BATCH_SIZE);
        try {
            const result = await messaging.sendEachForMulticast({ ...buildMessage(payload), tokens: batch });
            sent += result.successCount || 0;
            result.responses.forEach((response, responseIndex) => {
                if (!response.success && INVALID_TOKEN_CODES.has(response.error?.code)) {
                    invalidTokens.push(batch[responseIndex]);
                }
            });
        } catch (error) {
            console.warn('[Push] FCM batch failed:', error.message);
        }
    }
    if (invalidTokens.length) await deactivateTokens(invalidTokens).catch((error) => {
        console.warn('[Push] stale-token deactivation failed:', error.message);
    });
    return { sent, invalidTokens };
};

const dispatchPushForNotification = async (notification, options = {}) => {
    try {
        const userId = notification?.userId?._id || notification?.userId;
        if (!userId) return { sent: 0 };
        const devices = await (options.getActiveTokens || getActiveAndroidTokens)([userId]);
        return sendToTokens(devices.map((device) => device.token), {
            title: notification.title,
            message: notification.message,
            notificationId: notification._id,
            type: notification.type,
            route: notification.link,
        }, options);
    } catch (error) {
        console.warn('[Push] user delivery failed:', error.message);
        return { sent: 0, error };
    }
};

const dispatchBroadcastPush = async (notification, options = {}) => {
    try {
        const devices = await (options.getActiveTokens || getActiveAndroidTokens)();
        return sendToTokens(devices.map((device) => device.token), {
            title: notification.title,
            message: notification.message,
            notificationId: notification._id,
            type: notification.type,
            route: notification.link,
        }, options);
    } catch (error) {
        console.warn('[Push] broadcast delivery failed:', error.message);
        return { sent: 0, error };
    }
};

module.exports = {
    FCM_BATCH_SIZE,
    buildMessage,
    sendToTokens,
    dispatchPushForNotification,
    dispatchBroadcastPush,
};
