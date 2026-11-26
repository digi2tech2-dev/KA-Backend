'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../modules/users/user.model');

const run = async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
    await mongoose.connect(process.env.MONGO_URI);

    const result = await User.updateMany(
        { isTwoFactorEnabled: { $ne: true } },
        { $set: { isTwoFactorEnabled: true, twoFactorOtp: null, twoFactorOtpExpires: null, twoFactorAttempts: 0 } }
    );

    console.log(`Enabled 2FA for ${result.modifiedCount} existing accounts.`);
};

run()
    .catch((error) => {
        console.error('[enable-2fa] migration failed:', error.name || 'Error', error.code || '');
        process.exitCode = 1;
    })
    .finally(async () => {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
