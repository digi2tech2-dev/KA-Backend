'use strict';

const { validationResult } = require('express-validator');
const { ValidationError } = require('../errors/AppError');

/**
 * Runs after express-validator chains.
 * Collects all field errors and throws a ValidationError with details.
 */
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const formatted = errors.array().map((err) => ({
            field: err.path || err.param,
            message: err.msg,
        }));
        throw new ValidationError('Request validation failed', formatted);
    }
    next();
};

module.exports = validate;
