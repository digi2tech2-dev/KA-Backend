'use strict';
const {BusinessRuleError}=require('../errors/AppError');
module.exports=async(user,currency)=>{
    if(String(currency || '').toUpperCase()===String(user.currency || '').toUpperCase())return;
    const {WalletTransaction}=require('../../modules/wallet/walletTransaction.model');
    const {Order}=require('../../modules/orders/order.model');
    if(Number(user.walletBalance || 0)!==0 || Number(user.creditLimit || 0)!==0
        || await WalletTransaction.exists({userId:user._id}) || await Order.exists({userId:user._id})) {
        throw new BusinessRuleError('Wallet currency cannot change during onboarding after financial activity.', 'ONBOARDING_CURRENCY_LOCKED');
    }
};
