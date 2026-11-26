'use strict';

const { User, ROLES, USER_STATUS } = require('../users/user.model');
const { ConflictError } = require('../../shared/errors/AppError');
const { getHighestPercentageGroup } = require('../groups/group.service');
const {
    resolveReferralOwnerForNewUser,
    buildReferralAssignment,
    createUserWithReferralCodeRetry,
} = require('../referrals/referral.service');

const getGoogleProfileEmail = (profile = {}) => (
    profile.emails?.[0]?.value
    || profile.email
    || ''
);

const resolveGoogleUser = async (profile, oauthState = {}) => {
    const googleId = profile?.id;
    const email = String(getGoogleProfileEmail(profile)).trim().toLowerCase();
    const name = profile?.displayName || email.split('@')[0];

    if (!googleId) {
        throw new Error('Google profile is missing an id.');
    }

    if (!email) {
        throw new Error('Google account has no accessible email address.');
    }

    let user = await User.findOne({ googleId });
    if (user) {
        return { user, isNewUser: false, linkedExistingEmailUser: false };
    }

    // A verified email alone is not proof that the existing local account is
    // controlled by this Google subject. Linking must be an explicit,
    // authenticated account-management operation.
    user = await User.findOne({ email });
    if (user) throw new ConflictError(
        'This email already belongs to an account. Sign in to that account and link Google from account settings.'
    );

    const group = await getHighestPercentageGroup();
    const referralOwner = oauthState?.intent === 'signup' && oauthState?.referralCode
        ? await resolveReferralOwnerForNewUser(oauthState.referralCode, email)
        : null;

    user = await createUserWithReferralCodeRetry({
        name,
        email,
        googleId,
        role: ROLES.CUSTOMER,
        groupId: group._id,
        // Match password registration policy: newly registered customers are
        // ACTIVE immediately, while access is still gated by Google verified
        // email and the normal account status checks.
        status: USER_STATUS.ACTIVE,
        verified: true,
        ...buildReferralAssignment(referralOwner),
    });

    return { user, isNewUser: true, linkedExistingEmailUser: false };
};

module.exports = {
    resolveGoogleUser,
};
