'use strict';

/**
 * Email identity helpers.
 *
 * New authentication identities retain every meaningful part of the address:
 * they are only trimmed and lower-cased.  The legacy form is retained solely
 * for lookups of accounts created while express-validator normalizeEmail() was
 * in use (notably Gmail dot and subaddress removal).
 */

const validator = require('validator');

const canonicalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

const legacyNormalizeEmail = (email) => {
    const canonicalEmail = canonicalizeEmail(email);
    return validator.normalizeEmail(canonicalEmail) || canonicalEmail;
};

const getEmailLookupValues = (email) => {
    const canonicalEmail = canonicalizeEmail(email);
    const legacyEmail = legacyNormalizeEmail(canonicalEmail);
    return [...new Set([canonicalEmail, legacyEmail])];
};

const buildEmailLookup = (email) => ({
    email: { $in: getEmailLookupValues(email) },
});

module.exports = {
    canonicalizeEmail,
    legacyNormalizeEmail,
    getEmailLookupValues,
    buildEmailLookup,
};
