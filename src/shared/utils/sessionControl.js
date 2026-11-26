'use strict';
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const { AuthenticationError } = require('../errors/AppError');
const sensitive = ['password', 'email', 'role', 'permissions', 'status', 'deletedAt', 'isTwoFactorEnabled'];
const install = schema => {
    schema.add({ sessionVersion: { type: String, default: '0' }, twoFactorAttempts: { type: Number, default: 0 } });
    const revoke = fields => ({ ...fields, sessionVersion: crypto.randomUUID(), twoFactorOtp: null, twoFactorOtpExpires: null,
        twoFactorTempToken: null, twoFactorTempTokenExpires: null, profileCompletionToken: null, profileCompletionTokenExpires: null, apiToken: null, apiTokenLookupHash: null });
    schema.pre('save', function invalidateSessions(next) {
        if (!this.isNew && sensitive.some(key => this.isModified(key))) this.set(revoke({}));
        next();
    });
    for (const operation of ['findOneAndUpdate', 'updateOne', 'updateMany']) {
        schema.pre(operation, function invalidateUpdatedSessions(next) {
            const update = this.getUpdate() || {};
            if (Array.isArray(update)) {
                // Wallet arithmetic uses aggregation pipelines. Allow those
                // while refusing identity changes or whole-document replacement.
                const safe = update.every(stage => Object.keys(stage).length === 1 && stage.$set
                    && Object.keys(stage.$set).every(key => !sensitive.includes(key.split('.')[0])));
                return next(safe ? undefined : new Error('Identity pipeline updates require explicit session invalidation.'));
            }
            const changed = Object.keys(update).filter(k => !k.startsWith('$')).concat(...Object.values(update).filter(v => v && typeof v === 'object').map(v => Object.keys(v)));
            if (changed.some(key => sensitive.includes(key.split('.')[0]))) {
                if (changed.includes('password')) return next(new Error('Password changes must use document save.'));
                update.$set = revoke(update.$set || {});
                this.setUpdate(update);
            }
            next();
        });
    }
};
const validate = (decoded, user, purpose = 'access') => {
    if (!user || user.deletedAt || user.blockedAt || user.status !== 'ACTIVE' || decoded.purpose !== purpose
        || typeof decoded.sv !== 'string' || decoded.sv !== String(user.sessionVersion || '0')
        || (purpose === 'access' && user.isTwoFactorEnabled && decoded.mfa !== true)) {
        throw new AuthenticationError('Session is no longer valid. Please log in again.');
    }
};
const issue = async (userId, extra = {}, mfaVerified = false) => {
    const { User } = require('../../modules/users/user.model');
    const user = await User.findById(userId);
    if (!user || user.deletedAt || user.blockedAt || user.status !== 'ACTIVE' || (user.isTwoFactorEnabled && !mfaVerified)) throw new AuthenticationError('Login verification required.');
    return jwt.sign({ ...extra, id: String(user._id), role: user.role, purpose: 'access', sv: String(user.sessionVersion || '0'), mfa: Boolean(user.isTwoFactorEnabled && mfaVerified) }, config.jwt.secret,
        { algorithm: 'HS256', expiresIn: '15m', jwtid: crypto.randomUUID() });
};
const exchange = async (tempToken, code) => {
    const { User } = require('../../modules/users/user.model');
    let decoded;
    try { decoded = jwt.verify(tempToken, config.jwt.secret, { algorithms: ['HS256'] }); } catch { throw new AuthenticationError('Invalid temporary token.'); }
    const user = await User.findById(decoded.id);
    validate(decoded, user, '2fa-pending');
    if (!user.isTwoFactorEnabled) throw new AuthenticationError('Two-factor authentication is not enabled.');
    await User.updateOne({ _id: user._id, twoFactorOtpExpires: { $lte: new Date() } }, { $set: { twoFactorOtp: null, twoFactorOtpExpires: null } });
    const filter = { _id: user._id, sessionVersion: decoded.sv, isTwoFactorEnabled: true, deletedAt: null, status: 'ACTIVE', twoFactorOtp: { $ne: null }, twoFactorOtpExpires: { $gt: new Date() }, twoFactorAttempts: { $lt: 5 } };
    const attempt = await User.findOneAndUpdate(filter, { $inc: { twoFactorAttempts: 1 } }, { new: true }).select('+twoFactorOtp');
    const hash = crypto.createHmac('sha256', config.jwt.secret).update(String(code).trim()).digest('hex');
    if (!attempt || attempt.twoFactorOtp !== hash) throw new AuthenticationError('Invalid or expired 2FA code.');
    // At most one request can consume a matching unexpired challenge.
    const consumed = await User.findOneAndUpdate({ ...filter, twoFactorAttempts: { $lte: 5 }, twoFactorOtp: hash }, { $set: { twoFactorOtp: null, twoFactorOtpExpires: null } }, { new: true });
    if (!consumed) throw new AuthenticationError('Challenge already consumed.');
    return consumed;
};
module.exports = { install, validate, issue, exchange };
