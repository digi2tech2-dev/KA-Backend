'use strict';
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { User } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const session = require('../shared/utils/sessionControl');
const auth = require('../modules/auth/auth.service');
const email = require('../services/email.service');
beforeAll(async () => mongoose.connect(process.env.MONGO_TEST_URI));
afterAll(async () => mongoose.disconnect());
afterEach(() => jest.restoreAllMocks());
let counter = 0;
const customer = async extra => {
    const group = await Group.create({ name: `hotfix-${++counter}-${Date.now()}`, percentage: 10, isActive: true });
    return User.create({ name: 'Security Owner', email: `security-${counter}-${Date.now()}@example.test`, password: 'OriginalPassword123!', role: 'CUSTOMER', groupId: group._id, status: 'ACTIVE', verified: true, phone: '+201012345678', country: 'EG', currency: 'USD', profileCompletedAt: new Date(), ...extra });
};
test('password changes invalidate a previously valid JWT', async () => {
    const user = await customer();
    const token = await session.issue(user._id);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    expect(decoded.exp - decoded.iat).toBe(900);
    expect(() => session.validate(decoded, user)).not.toThrow();
    user.password = 'ReplacementPassword123!'; await user.save();
    expect(() => session.validate(decoded, user)).toThrow();
});
test('a role change through a query invalidates the original JWT', async () => {
    const user = await customer();
    const decoded = jwt.verify(await session.issue(user._id), process.env.JWT_SECRET);
    const updated = await User.findByIdAndUpdate(user._id, { $set: { role: 'SUPERVISOR' } }, { new: true });
    expect(() => session.validate(decoded, updated)).toThrow();
});
test('concurrent OTP replays can issue only one authenticated session', async () => {
    const user = await customer({ isTwoFactorEnabled: true });
    let otp;
    jest.spyOn(email, 'sendTwoFactorOtpEmail').mockImplementation(async (u, value) => { otp = value; });
    const challenge = await auth.loginWithGoogle(user);
    expect(challenge.token).toBeUndefined();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => session.exchange(challenge.tempToken, otp)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
});
test('five incorrect OTP attempts block even a subsequently correct code', async () => {
    const user = await customer({ isTwoFactorEnabled: true });
    let otp;
    jest.spyOn(email, 'sendTwoFactorOtpEmail').mockImplementation(async (u, value) => { otp = value; });
    const challenge = await auth.loginWithGoogle(user);
    for (let i = 0; i < 5; i++) await expect(session.exchange(challenge.tempToken, 'invalid')).rejects.toThrow();
    await expect(session.exchange(challenge.tempToken, otp)).rejects.toThrow();
});
test('legacy tokens and direct access-token minting cannot bypass MFA', async () => {
    const user = await customer({ isTwoFactorEnabled: true });
    expect(() => session.validate({ id: user._id }, user)).toThrow();
    await expect(session.issue(user._id)).rejects.toThrow();
});
test('financial aggregation pipelines remain available without revoking sessions', async () => {
    const user = await customer({ walletBalance: 100 });
    const decoded = jwt.verify(await session.issue(user._id), process.env.JWT_SECRET);
    const updated = await User.findByIdAndUpdate(user._id, [{ $set: { walletBalance: { $add: ['$walletBalance', 5] } } }], { new: true });
    expect(updated.walletBalance).toBe(105);
    expect(() => session.validate(decoded, updated)).not.toThrow();
});
