'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-unit-test-secret-only-2026';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/never-connect-unit-tests';
jest.mock('../services/email.service', () => ({ sendTwoFactorOtpEmail: jest.fn().mockResolvedValue() }));
const auth = require('../modules/auth/auth.service');
const jwt = require('jsonwebtoken');
const email = require('../services/email.service');
test('Google sign-in must pass MFA before issuing an access token', async () => {
    const user = { _id: '507f1f77bcf86cd799439011', role: 'CUSTOMER', status: 'ACTIVE', email: 'owner@example.test', isTwoFactorEnabled: true, save: jest.fn().mockResolvedValue() };
    const result = await auth.loginWithGoogle(user);
    expect(result.token).toBeUndefined();
    expect(result.requires2FA).toBe(true);
    expect(jwt.verify(result.tempToken, process.env.JWT_SECRET).purpose).toBe('2fa-pending');
    expect(email.sendTwoFactorOtpEmail).toHaveBeenCalledTimes(1);
    expect(user.twoFactorOtp).not.toMatch(/^\d{6}$/);
});

test('privileged Google sign-in cannot bypass its MFA challenge', async () => {
    const user = { _id: '507f1f77bcf86cd799439012', role: 'ADMIN', status: 'ACTIVE', email: 'admin@example.test', isTwoFactorEnabled: false, save: jest.fn().mockResolvedValue() };
    const result = await auth.loginWithGoogle(user);
    expect(result.requires2FA).toBe(true);
    expect(jwt.verify(result.tempToken, process.env.JWT_SECRET).purpose).toBe('2fa-pending');
    expect(user.isTwoFactorEnabled).toBe(true);
    expect(result.token).toBeUndefined();
});

test.each([{ status: 'REJECTED' }, { status: 'ACTIVE', blockedAt: new Date() }, { status: 'ACTIVE', deletedAt: new Date() }])('Google login rejects unavailable accounts: %o', async state => {
    await expect(auth.loginWithGoogle({ _id: '507f1f77bcf86cd799439013', role: 'CUSTOMER', email: 'x@example.test', isTwoFactorEnabled: false, ...state }))
        .rejects.toThrow();
});
