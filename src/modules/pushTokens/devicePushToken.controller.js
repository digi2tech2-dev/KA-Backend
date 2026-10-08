'use strict';

const service = require('./devicePushToken.service');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

const register = catchAsync(async (req, res) => {
    const device = await service.registerPushToken({
        userId: req.user._id,
        token: req.body.token,
        platform: req.body.platform,
    });
    sendSuccess(res, { device }, 'Push device registered.');
});

const unregister = catchAsync(async (req, res) => {
    const result = await service.unregisterPushToken({ userId: req.user._id, token: req.body.token });
    sendSuccess(res, result, 'Push device unregistered.');
});

module.exports = { register, unregister };
