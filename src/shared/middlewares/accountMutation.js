'use strict';
const { User } = require('../../modules/users/user.model');
const { AuthorizationError } = require('../errors/AppError');
module.exports = async (req,res,next) => {
    try {
        if (['GET','HEAD','OPTIONS'].includes(req.method) || req.user?.role==='ADMIN') return next();
        const id=req.params.id || req.params.userId;
        if (!/^[a-f\d]{24}$/i.test(String(id))) return next();
        const target=await User.findById(id).select('role');
        if(target && target.role!=='CUSTOMER') throw new AuthorizationError('Supervisors may manage customer accounts only.');
        if (['role','permissions','isApiEnabled','apiAccessEnabled','currency','walletBalance','creditLimit','creditUsed','quantityLimit'].some(key=>Object.hasOwn(req.body || {},key))) {
            throw new AuthorizationError('Privilege and financial account changes require an administrator.');
        }
        next();
    } catch(error){next(error);}
};
