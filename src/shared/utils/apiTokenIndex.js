'use strict';
const crypto = require('node:crypto');
const digest = raw => crypto.createHash('sha256').update(String(raw)).digest('hex');
const isRaw = raw => typeof raw === 'string' && raw.length > 0 && !/^\$2[aby]\$/.test(raw);
module.exports = schema => {
    schema.add({ apiTokenLookupHash: { type: String, select: false, index: true } });
    // This hook must be installed before bcrypt replaces the raw API key.
    schema.pre('save', function indexApiToken(next) {
        if (this.isModified('apiToken')) this.apiTokenLookupHash = isRaw(this.apiToken) ? digest(this.apiToken) : null;
        next();
    });
    schema.pre('findOneAndUpdate', function indexUpdatedApiToken(next) {
        const update = this.getUpdate() || {};
        const fields = update.$set || update;
        if (Object.hasOwn(fields, 'apiToken')) fields.apiTokenLookupHash = isRaw(fields.apiToken) ? digest(fields.apiToken) : null;
        next();
    });
};
module.exports.digest = digest;
