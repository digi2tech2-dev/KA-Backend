'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { AuthenticationError } = require('../errors/AppError');
const Grant = mongoose.models.OAuthProofGrant || mongoose.model('OAuthProofGrant', new mongoose.Schema({
    _id: String, purpose: String, challenge: String, context: mongoose.Schema.Types.Mixed,
    userId: mongoose.Schema.Types.ObjectId, sessionVersion: String, expiresAt: { type: Date, expires: 0 },
}));
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const invalid = () => new AuthenticationError('Invalid, expired, or revoked Google login. Start again.');
const begin = async req => {
    if (typeof req.query.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(req.query.code_challenge)) throw invalid();
    const state = crypto.randomBytes(32).toString('hex');
    const referral = req.query.referralCode || req.query.ref || req.query.refCode || req.query.inviteCode;
    await Grant.create({ _id: digest(state), purpose: 'state', challenge: req.query.code_challenge,
        context: { intent: req.query.intent === 'signup' ? 'signup' : 'login', referralCode: typeof referral === 'string' ? referral.slice(0,32) : undefined },
        expiresAt: new Date(Date.now() + 600000) });
    return state;
};
const consumeState = async raw => {
    if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw invalid();
    const state = await Grant.findOneAndDelete({ _id: digest(raw), purpose: 'state', expiresAt: { $gt: new Date() } });
    if (!state) throw invalid();
    return { ...state.context, handoffChallenge: state.challenge };
};
const store = async (req, user) => {
    const challenge = req.oauthState?.handoffChallenge;
    if (!challenge || !user?._id) throw invalid();
    const code = crypto.randomBytes(32).toString('hex');
    // Grants contain neither access tokens nor profile-completion secrets.
    await Grant.create({ _id: digest(code), purpose: 'handoff', challenge, userId: user._id,
        sessionVersion: String(user.sessionVersion || '0'), expiresAt: new Date(Date.now() + 60000) });
    return code;
};
const exchange = async (req, res, next) => {
    try {
        const { code, verifier } = req.body || {};
        if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code) || typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw invalid();
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const grant = await Grant.findOneAndDelete({ _id: digest(code), purpose: 'handoff', challenge, expiresAt: { $gt: new Date() } });
        if (!grant) throw invalid();
        const { User } = require('../../modules/users/user.model');
        const user = await User.findById(grant.userId);
        if (!user || user.deletedAt || user.blockedAt || user.status !== 'ACTIVE' || String(user.sessionVersion || '0') !== grant.sessionVersion) throw invalid();
        const result = await require('../../modules/auth/auth.service').loginWithGoogle(user);
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        res.json({ success: true, data: result });
    } catch (error) { next(error); }
};
module.exports = { begin, consumeState, store, exchange, Grant };
