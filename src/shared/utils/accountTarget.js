'use strict';
const { AuthorizationError } = require('../errors/AppError');
module.exports = async (actorId, target) => {
    const { User } = require('../../modules/users/user.model');
    const actor = await User.findById(actorId).select('role status deletedAt');
    if (!actor || actor.status !== 'ACTIVE' || actor.deletedAt || !['ADMIN', 'SUPERVISOR'].includes(actor.role)) throw new AuthorizationError();
    if (actor.role !== 'ADMIN' && target.role !== 'CUSTOMER') throw new AuthorizationError('Supervisors may manage customer accounts only.');
};
