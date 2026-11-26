'use strict';
const { BusinessRuleError, AuthorizationError }=require('../errors/AppError');
const amountLimit=()=>{
    const limit=Number(process.env.MAX_DEPOSIT_USD || 10000);
    if(!Number.isFinite(limit)||limit<=0)throw new Error('MAX_DEPOSIT_USD must be positive.');
    return limit;
};
const checkAmount=async(amount,currency)=>{
    const value=Number(amount),rate=Number(await require('../../services/currencyConverter.service').getConversionRate(currency));
    if(!Number.isFinite(value)||value<=0||!Number.isFinite(rate)||rate<=0||value/rate>amountLimit())throw new BusinessRuleError('Deposit exceeds the permitted amount.', 'DEPOSIT_LIMIT_EXCEEDED');
};
const checkReviewer=async(actorId,existing,overrides)=>{
    // Only the server's SMS reconciliation worker uses this sentinel actor.
    if(String(actorId)==='000000000000000000000001' && overrides.reviewSource==='VODAFONE_SMS_AUTO' && overrides.paymentEventId){
        const {PaymentEvent}=require('../../modules/paymentEvents/paymentEvent.model');
        const event=await PaymentEvent.findById(overrides.paymentEventId);
        if(!event || String(event.matchedDepositId)!==String(existing._id) || !['MATCHED','PROCESSED'].includes(event.matchStatus))throw new AuthorizationError('Verified payment evidence required.');
        return;
    }
    const {User}=require('../../modules/users/user.model');
    const actor=await User.findById(actorId).select('role status deletedAt');
    if(!actor||actor.role!=='ADMIN'||actor.status!=='ACTIVE'||actor.deletedAt)throw new AuthorizationError('Financial approval requires an active administrator.');
};
module.exports={checkAmount,checkReviewer};
