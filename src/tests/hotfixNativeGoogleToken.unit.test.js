'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-unit-test-secret-only-2026';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/never-connect-unit-tests';
process.env.GOOGLE_WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';
const { verifyNativeGoogleIdToken } = require('../modules/auth/nativeGoogle.service');

const valid = { sub: 'google-subject', email: 'verified@example.test', email_verified: true,
    aud: process.env.GOOGLE_WEB_CLIENT_ID, iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 300 };
const client = payload => ({ verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => payload }) });

test.each([
    [{ ...valid, aud: 'attacker-client' }],
    [{ ...valid, iss: 'https://attacker.example' }],
    [{ ...valid, exp: Math.floor(Date.now() / 1000) - 1 }],
    [{ ...valid, email_verified: false }],
    [{ ...valid, sub: undefined }],
])('rejects invalid Google identity claims', async payload => {
    await expect(verifyNativeGoogleIdToken('id-token', { client: client(payload) })).rejects.toThrow();
});

test('accepts a verified, correctly targeted, unexpired Google identity', async () => {
    await expect(verifyNativeGoogleIdToken('id-token', { client: client(valid) })).resolves.toMatchObject({ id: 'google-subject' });
});
