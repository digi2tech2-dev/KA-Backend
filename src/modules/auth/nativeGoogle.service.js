'use strict';

const { OAuth2Client } = require('google-auth-library');
const config = require('../../config/config');
const { AuthenticationError } = require('../../shared/errors/AppError');

const verifyNativeGoogleIdToken = async (idToken, options = {}) => {
    const webClientId = options.webClientId || config.google.webClientId;
    if (!webClientId) {
        throw new AuthenticationError('Google native sign-in is not configured.');
    }
    if (!idToken || typeof idToken !== 'string') {
        throw new AuthenticationError('Google ID token is required.');
    }

    let ticket;
    try {
        const client = options.client || new OAuth2Client(webClientId);
        ticket = await client.verifyIdToken({ idToken, audience: webClientId });
    } catch (_) {
        throw new AuthenticationError('Google ID token is invalid.');
    }

    const payload = ticket?.getPayload?.() || null;
    const sub = String(payload?.sub || '').trim();
    const email = String(payload?.email || '').trim().toLowerCase();
    if (!sub || !email || payload?.email_verified !== true) {
        throw new AuthenticationError('Google account email must be verified.');
    }

    return {
        id: sub,
        displayName: String(payload?.name || '').trim() || email.split('@')[0],
        emails: [{ value: email }],
    };
};

module.exports = { verifyNativeGoogleIdToken };
