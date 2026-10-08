'use strict';

const getSafeInternalRoute = (value, fallback = '') => {
    if (typeof value !== 'string') return fallback;
    const route = value.trim();
    if (!route || !route.startsWith('/') || route.startsWith('//') || route.includes('://') || route.includes('\\')) {
        return fallback;
    }

    try {
        const parsed = new URL(route, 'https://internal.invalid');
        return parsed.origin === 'https://internal.invalid'
            ? `${parsed.pathname}${parsed.search}${parsed.hash}`
            : fallback;
    } catch (_) {
        return fallback;
    }
};

module.exports = { getSafeInternalRoute };
