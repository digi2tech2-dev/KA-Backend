'use strict';

const config = require('../../config/config');
const { seedDefaultSettings } = require('../../modules/admin/setting.model');

// Loading the application must not implicitly write to a production-like
// database while an engineer is using safe local inspection mode.
const startDefaultSettingsSeed = ({
    safeLocalProductionMode = config.safeLocalProductionMode,
    seed = seedDefaultSettings,
} = {}) => {
    if (safeLocalProductionMode) return false;

    Promise.resolve(seed()).catch(() => {});
    return true;
};

module.exports = { startDefaultSettingsSeed };
