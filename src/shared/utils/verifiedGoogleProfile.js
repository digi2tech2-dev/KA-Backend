'use strict';
const { AuthenticationError } = require('../errors/AppError');
module.exports = profile => {
    if (!profile?.id || profile._json?.email_verified !== true || !profile.emails?.[0]?.value) {
        throw new AuthenticationError('A verified Google account email is required.');
    }
};
