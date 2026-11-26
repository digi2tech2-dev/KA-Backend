'use strict';

const { User } = require('../../modules/users/user.model');
const { NotFoundError } = require('../errors/AppError');

// Only mount on user parameters, after authentication/authorization. The
// application services continue using ObjectIds for all database relations.
const resolveUserNumber = (paramName = 'id', source = 'params') => async (req, _res, next) => {
    const value = String(req[source]?.[paramName] ?? '');
    if (!/^\d+$/.test(value) || /^[a-f\d]{24}$/i.test(value)) return next();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 100) return next(new NotFoundError('User'));
    try {
        const user = await User.findOne({ userNumber: number }).select('_id');
        if (!user) return next(new NotFoundError('User'));
        req[source][paramName] = user._id.toString();
        next();
    } catch (error) { next(error); }
};

module.exports = resolveUserNumber;
