'use strict';

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const validate = require('../../shared/middlewares/validate');
const controller = require('./devicePushToken.controller');
const { registerPushTokenValidation, unregisterPushTokenValidation } = require('./devicePushToken.validation');

const router = Router();
router.use(authenticate, requireActiveUser);
router.post('/push', registerPushTokenValidation, validate, controller.register);
router.delete('/push', unregisterPushTokenValidation, validate, controller.unregister);

module.exports = router;
