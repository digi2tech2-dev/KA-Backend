'use strict';

const { body } = require('express-validator');

const tokenValidation = body('token')
    .isString().withMessage('token must be a string')
    .trim()
    .isLength({ min: 20, max: 4096 }).withMessage('token must be between 20 and 4096 characters');

const registerPushTokenValidation = [
    tokenValidation,
    body('platform').equals('android').withMessage('platform must be android'),
];

const unregisterPushTokenValidation = [tokenValidation];

module.exports = { registerPushTokenValidation, unregisterPushTokenValidation };
