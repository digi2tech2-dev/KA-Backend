'use strict';

const { Setting } = require('../admin/setting.model');
const { ERROR_CODES } = require('./clientCompat.errors');

// Compatibility maintenance blocks only new orders. Catalogue and status calls
// remain available so integrations can continue to inspect existing work.
const requireCompatOrderingAvailable = async (_req, res, next) => {
    try {
        const maintenance = await Setting.findOne({ key: 'maintenanceMode' })
            .select('value')
            .lean();

        if (maintenance?.value === true) {
            return res.status(503).json({
                status: 'ERROR',
                code: ERROR_CODES.MAINTENANCE,
                message: 'Site is under maintenance',
            });
        }

        return next();
    } catch (_err) {
        return res.status(500).json({
            status: 'ERROR',
            code: ERROR_CODES.INTERNAL,
            message: 'Unknown internal error',
        });
    }
};

module.exports = { requireCompatOrderingAvailable };
