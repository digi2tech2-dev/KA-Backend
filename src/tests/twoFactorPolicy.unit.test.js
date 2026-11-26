'use strict';

jest.mock('../services/email.service', () => ({
    sendTwoFactorOtpEmail: jest.fn(async () => {}),
}));

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const emailService = require('../services/email.service');
const policy = require('../shared/utils/twoFactorPolicy');
const sessionControl = require('../shared/utils/sessionControl');
const authService = require('../modules/auth/auth.service');
const { User } = require('../modules/users/user.model');

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
    emailService.sendTwoFactorOtpEmail.mockClear();
});

test('production policy upgrades an account and sends a login challenge', async () => {
    process.env.NODE_ENV = 'production';
    const user = {
        _id: '507f1f77bcf86cd799439011',
        email: 'customer@example.test',
        isTwoFactorEnabled: false,
        sessionVersion: 'session-1',
        save: jest.fn(async () => {}),
    };

    const result = await policy.startLoginChallenge(user);

    expect(user.isTwoFactorEnabled).toBe(true);
    expect(user.save).toHaveBeenCalledTimes(2);
    expect(emailService.sendTwoFactorOtpEmail).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ requires2FA: true, email: user.email });
    expect(jwt.verify(result.tempToken, config.jwt.secret).purpose).toBe('2fa-pending');
});

test('production policy rejects access tokens without second-factor proof', () => {
    process.env.NODE_ENV = 'production';
    const user = { status: 'ACTIVE', sessionVersion: 'session-1', isTwoFactorEnabled: false };
    expect(() => sessionControl.validate({ purpose: 'access', sv: 'session-1', mfa: false }, user)).toThrow();
});

test('production policy does not issue a full token before second-factor verification', async () => {
    process.env.NODE_ENV = 'production';
    const user = { _id: '507f1f77bcf86cd799439011', role: 'CUSTOMER', status: 'ACTIVE',
        sessionVersion: 'session-1', isTwoFactorEnabled: false };
    jest.spyOn(User, 'findById').mockResolvedValue(user);

    await expect(sessionControl.issue(user._id)).rejects.toThrow('Login verification required.');
    const token = await sessionControl.issue(user._id, {}, true);
    expect(jwt.verify(token, config.jwt.secret).mfa).toBe(true);
});

test('production policy prevents users from disabling required 2FA', async () => {
    process.env.NODE_ENV = 'production';
    const findById = jest.spyOn(User, 'findById');

    await expect(authService.disable2FA('507f1f77bcf86cd799439011', { password: 'correct-password' }))
        .rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    expect(findById).not.toHaveBeenCalled();
});
