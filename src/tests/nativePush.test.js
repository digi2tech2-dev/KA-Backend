'use strict';

const { verifyNativeGoogleIdToken } = require('../modules/auth/nativeGoogle.service');
const { DevicePushToken } = require('../modules/pushTokens/devicePushToken.model');
const {
    registerPushToken,
    unregisterPushToken,
} = require('../modules/pushTokens/devicePushToken.service');
const { buildMessage, sendToTokens } = require('../services/pushDelivery.service');
const { getFirebaseApp } = require('../services/firebaseAdmin.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
    await DevicePushToken.syncIndexes();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

describe('native Google ID tokens', () => {
    it('accepts only a verified token payload and maps it to the existing Google profile shape', async () => {
        const profile = await verifyNativeGoogleIdToken('native-token', {
            webClientId: 'web-client.apps.googleusercontent.com',
            client: {
                verifyIdToken: jest.fn().mockResolvedValue({
                    getPayload: () => ({
                        sub: 'google-subject',
                        email: 'user@example.com',
                        email_verified: true,
                        name: 'Verified User',
                    }),
                }),
            },
        });

        expect(profile).toEqual({
            id: 'google-subject',
            displayName: 'Verified User',
            emails: [{ value: 'user@example.com' }],
        });
        expect(profile).toBeDefined();
    });

    it('rejects an unverified Google email', async () => {
        await expect(verifyNativeGoogleIdToken('native-token', {
            webClientId: 'web-client.apps.googleusercontent.com',
            client: { verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => ({ sub: 'sub', email: 'user@example.com', email_verified: false }) }) },
        })).rejects.toMatchObject({ statusCode: 401 });
    });

    it('uses the configured Web OAuth client fallback as the token audience', async () => {
        const config = require('../config/config');
        const original = config.google.webClientId;
        config.google.webClientId = 'fallback-web-client.apps.googleusercontent.com';
        const client = { verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => ({ sub: 'sub', email: 'user@example.com', email_verified: true }) }) };
        await verifyNativeGoogleIdToken('native-token', { client });
        expect(client.verifyIdToken).toHaveBeenCalledWith({
            idToken: 'native-token',
            audience: 'fallback-web-client.apps.googleusercontent.com',
        });
        config.google.webClientId = original;
    });
});

describe('device push tokens', () => {
    const token = (suffix) => `fcm-registration-token-${suffix}-${'x'.repeat(40)}`;

    it('reassigns a globally unique installation token to its newest user', async () => {
        const group = await createGroup();
        const firstUser = await createCustomer({ groupId: group._id });
        const secondUser = await createCustomer({ groupId: group._id });
        const value = token('handoff');

        await registerPushToken({ userId: firstUser._id, token: value, platform: 'android' });
        await registerPushToken({ userId: secondUser._id, token: value, platform: 'android' });

        const record = await DevicePushToken.findOne({}).select('+token');
        expect(record.userId.toString()).toBe(secondUser._id.toString());
        expect(record.token).toBe(value);
        expect(record.appId).toBe('com.adcard.app');
        expect(await DevicePushToken.countDocuments({})).toBe(1);
    });

    it('keeps registration tokens excluded from normal query results and only unregisters their owner', async () => {
        const group = await createGroup();
        const owner = await createCustomer({ groupId: group._id });
        const other = await createCustomer({ groupId: group._id });
        const value = token('owner');
        await registerPushToken({ userId: owner._id, token: value, platform: 'android' });

        const normal = await DevicePushToken.findOne({});
        expect(normal.token).toBeUndefined();

        await unregisterPushToken({ userId: other._id, token: value });
        expect((await DevicePushToken.findOne({}).select('+token')).isActive).toBe(true);

        await unregisterPushToken({ userId: owner._id, token: value });
        expect((await DevicePushToken.findOne({}).select('+token')).isActive).toBe(false);
    });

    it('enforces the Android-only platform enum', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });
        await expect(new DevicePushToken({ userId: user._id, token: token('ios'), platform: 'ios' }).validate())
            .rejects.toThrow(/platform/);
    });
});

describe('push payload delivery', () => {
    it('removes unsafe routes from FCM data and batches sends at 500 tokens', async () => {
        const message = buildMessage({ title: 'Title', message: 'Body', notificationId: 'id', type: 'INFO', route: 'https://evil.invalid' });
        expect(message.data.route).toBe('');

        const messaging = {
            sendEachForMulticast: jest.fn().mockImplementation(({ tokens }) => Promise.resolve({
                successCount: tokens.length,
                responses: tokens.map(() => ({ success: true })),
            })),
        };
        const tokens = Array.from({ length: 501 }, (_, index) => `batch-token-${index}-${'x'.repeat(40)}`);
        const result = await sendToTokens(tokens, { title: 'Title', message: 'Body', notificationId: 'id', type: 'INFO', route: '/orders' }, {
            app: {},
            messaging,
        });

        expect(result.sent).toBe(501);
        expect(messaging.sendEachForMulticast).toHaveBeenCalledTimes(2);
    });

    it('deactivates invalid FCM registration tokens and treats missing Firebase configuration as a no-op', async () => {
        expect(getFirebaseApp()).toBeNull();
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });
        const invalid = `fcm-registration-token-invalid-${'x'.repeat(40)}`;
        await registerPushToken({ userId: user._id, token: invalid, platform: 'android' });
        await sendToTokens([invalid], { title: 'Title', message: 'Body', notificationId: 'id', type: 'INFO', route: '/orders' }, {
            app: {},
            messaging: {
                sendEachForMulticast: jest.fn().mockResolvedValue({
                    successCount: 0,
                    responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }],
                }),
            },
        });
        expect((await DevicePushToken.findOne({}).select('+token')).isActive).toBe(false);
    });
});
