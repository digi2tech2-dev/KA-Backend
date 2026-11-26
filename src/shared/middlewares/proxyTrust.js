'use strict';
const { isIP } = require('node:net');

// Trust concrete reverse proxy addresses only, never a hop count supplied by
// an unknown network topology. Direct connections ignore forwarded headers.
module.exports = (raw = process.env.TRUSTED_PROXY_CIDRS || '') => {
    const entries = String(raw).split(',').map(value => value.trim()).filter(Boolean);
    for (const value of entries) {
        const [address, mask, extra] = value.split('/');
        const family = isIP(address);
        if (!family || extra !== undefined || (mask !== undefined && (!/^\d+$/.test(mask)
            || Number(mask) === 0 || Number(mask) > (family === 4 ? 32 : 128)))) {
            throw new Error('TRUSTED_PROXY_CIDRS requires explicit proxy IP addresses or CIDRs.');
        }
    }
    return entries.length ? entries : false;
};
