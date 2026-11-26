'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-unit-test-secret-only-2026';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/never-connect-unit-tests';
const { User } = require('../modules/users/user.model');
const { updateMyProfile } = require('../modules/users/user.service');

describe('Hot fix: account takeover and wallet currency', () => {
    let user;
    beforeEach(() => {
        user = { _id: '507f1f77bcf86cd799439011', email: 'owner@example.test', currency: 'EGP', walletBalance: 100,
            profileCompletionRequired: false, save: jest.fn(), toSafeObject: () => ({ name: user.name, currency: user.currency }) };
        jest.spyOn(User, 'findById').mockImplementation(() => Object.assign(Promise.resolve(user), {
            select: () => Promise.resolve({ password: 'hashed', comparePassword: async value => value === 'OldPassword123!' })
        }));
    });
    afterEach(() => jest.restoreAllMocks());
    test('rejects denomination changes before saving an existing balance', async () => {
        await expect(updateMyProfile(user._id, { currency: 'USD' })).rejects.toMatchObject({ code: 'CUSTOMER_CURRENCY_CHANGE_DISABLED' });
        expect(user.save).not.toHaveBeenCalled();
        expect(user.walletBalance).toBe(100);
    });
    test('rejects replacing the recovery email without ownership verification', async () => {
        await expect(updateMyProfile(user._id, { email: 'attacker@example.test' })).rejects.toMatchObject({ code: 'EMAIL_CHANGE_REQUIRES_VERIFICATION' });
        expect(user.save).not.toHaveBeenCalled();
    });
    test('rejects a password change with no current password', async () => {
        await expect(updateMyProfile(user._id, { password: 'NewPassword123!' })).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' });
        expect(user.save).not.toHaveBeenCalled();
    });
    test('accepts a password change after verifying the current password', async () => {
        await updateMyProfile(user._id, { password: 'NewPassword123!', currentPassword: 'OldPassword123!' });
        expect(user.save).toHaveBeenCalledTimes(1);
        expect(user.password).toBe('NewPassword123!');
    });
    test('preserves ordinary profile updates', async () => {
        await updateMyProfile(user._id, { name: 'New Name' });
        expect(user.save).toHaveBeenCalledTimes(1);
        expect(user.name).toBe('New Name');
    });
});
