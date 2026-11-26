'use strict';

// MFA is mandatory everywhere except isolated automated tests.
const isRequired = () => process.env.NODE_ENV !== 'test';
const isRequiredFor = (user) => isRequired() || Boolean(user?.isTwoFactorEnabled);

const startLoginChallenge = async (user) => {
    if (isRequired() && !user.isTwoFactorEnabled) {
        user.isTwoFactorEnabled = true;
        await user.save();
    }
    return require('./loginChallenge')(user);
};

module.exports = { isRequired, isRequiredFor, startLoginChallenge };
