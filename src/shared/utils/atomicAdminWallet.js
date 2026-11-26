'use strict';
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const { User } = require('../../modules/users/user.model');
const { WalletTransaction } = require('../../modules/wallet/walletTransaction.model');
const { AuditLog } = require('../../modules/audit/audit.model');
const { ADMIN_ACTIONS, ENTITY_TYPES } = require('../../modules/audit/audit.constants');
const { BusinessRuleError, AuthorizationError, NotFoundError, ConflictError } = require('../errors/AppError');
const Operation = mongoose.models.HotfixWalletOperation || mongoose.model('HotfixWalletOperation', new mongoose.Schema({ _id:String, fingerprint:String, transactionId:mongoose.Schema.Types.ObjectId, actorId:mongoose.Schema.Types.ObjectId }, { timestamps:true }));
const Budget = mongoose.models.HotfixManualBudget || mongoose.model('HotfixManualBudget', new mongoose.Schema({ _id:String, usedCents:{ type:Number,default:0 } }, { timestamps:true }));
const decimal = value => { try { const result=new Decimal(value); if (!result.isFinite()) throw new Error(); return result; } catch { throw new BusinessRuleError('Invalid monetary amount.', 'INVALID_AMOUNT'); } };
const limit = (name, fallback) => { const value=Number(process.env[name] || fallback); if (!Number.isFinite(value) || value<=0) throw new Error(`${name} must be positive.`); return value; };
const requireAdmin = async (actorId, session) => {
    const actor = await User.findById(actorId).select('role status deletedAt').session(session || null);
    if (!actor || actor.role !== 'ADMIN' || actor.status !== 'ACTIVE' || actor.deletedAt) throw new AuthorizationError('Manual financial adjustments require an active administrator.');
    return actor;
};
const reserveBudget = async (actorId, amount, currency, session) => {
    const rate = await require('../../services/currencyConverter.service').getConversionRate(currency);
    if (!Number.isFinite(Number(rate)) || Number(rate)<=0) throw new BusinessRuleError('Invalid currency rate.', 'INVALID_RATE');
    const usd = decimal(amount).abs().div(rate);
    if (usd.gt(limit('MAX_MANUAL_OPERATION_USD',1000))) throw new BusinessRuleError('Amount requires additional financial approval.', 'SECOND_APPROVAL_REQUIRED');
    const cents=usd.mul(100).ceil().toNumber(), cap=Math.floor(limit('MAX_MANUAL_DAILY_USD',5000)*100);
    const id=`${actorId}:${new Date().toISOString().slice(0,10)}`;
    await Budget.updateOne({ _id:id }, { $setOnInsert:{usedCents:0} }, { upsert:true,session });
    const reserved=await Budget.findOneAndUpdate({ _id:id,usedCents:{$lte:cap-cents} },{$inc:{usedCents:cents}},{new:true,session});
    if (!reserved) throw new BusinessRuleError('Daily manual financial limit exceeded.', 'DAILY_FINANCIAL_LIMIT');
};
const adjust = async (mode,userId,amount,reason,actorId,key) => {
    if (!['ADD','DEDUCT','SET'].includes(mode)) throw new BusinessRuleError('Invalid adjustment mode.');
    if (typeof key!=='string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) throw new BusinessRuleError('Idempotency-Key is required.', 'IDEMPOTENCY_KEY_REQUIRED');
    if (typeof reason!=='string' || reason.trim().length<3) throw new BusinessRuleError('An adjustment reason is required.');
    const value=decimal(amount);
    if (value.decimalPlaces()>2 || (mode!=='SET' && value.lte(0)) || value.abs().gt(1000000)) throw new BusinessRuleError('Invalid adjustment amount.', 'INVALID_AMOUNT');
    const id=crypto.createHash('sha256').update(`${actorId}:${key}`).digest('hex');
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify([mode,String(userId),value.toString(),reason.trim()])).digest('hex');
    const session=await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            await requireAdmin(actorId,session);
            const replay=await Operation.findById(id).session(session);
            if (replay) {
                if (replay.fingerprint!==fingerprint) throw new ConflictError('Idempotency key belongs to another adjustment.');
                result={transaction:await WalletTransaction.findById(replay.transactionId).session(session),idempotent:true};return;
            }
            const user=await User.findById(userId).session(session);
            if (!user || user.deletedAt) throw new NotFoundError('User');
            const before=decimal(user.walletBalance || 0);
            const after=mode==='SET'?value:before.plus(mode==='ADD'?value:value.negated());
            const delta=after.minus(before);
            if (delta.isZero()) throw new BusinessRuleError('Adjustment must change the balance.', 'NO_BALANCE_CHANGE');
            if (after.lt(decimal(user.creditLimit || 0).negated())) throw new BusinessRuleError('Insufficient available balance.', 'INSUFFICIENT_BALANCE');
            await reserveBudget(actorId,delta.toNumber(),user.currency || 'USD',session);
            user.walletBalance=after.toNumber();
            user.creditUsed=Decimal.min(Decimal.max(after.negated(),0),user.creditLimit || 0).toNumber();
            await user.save({session});
            const [transaction]=await WalletTransaction.create([{userId,type:delta.gt(0)?'CREDIT':'DEBIT',amount:delta.abs().toNumber(),balanceBefore:before.toNumber(),balanceAfter:after.toNumber(),status:'COMPLETED',description:reason.trim(),
                semanticType:'ADMIN_ADJUSTMENT',sourceType:'ADMIN_ADJUSTMENT',direction:delta.gt(0)?'CREDIT':'DEBIT',currency:user.currency,reason:reason.trim(),note:reason.trim(),actorId,
                metadata:{operation:mode,actorId,reason:reason.trim()}}],{session});
            await AuditLog.create([{actorId,actorRole:'ADMIN',action:ADMIN_ACTIONS.WALLET_ADJUSTED,entityType:ENTITY_TYPES.WALLET,entityId:userId,metadata:{type:mode,amount:value.toString(),currency:user.currency,reason:reason.trim(),balanceBefore:before.toNumber(),balanceAfter:after.toNumber(),transactionId:transaction._id}}],{session});
            await Operation.create([{_id:id,fingerprint,transactionId:transaction._id,actorId}],{session});
            result={transaction,user};
        });
        return result;
    } catch (error) {
        if (error.code===11000) {
            const replay=await Operation.findById(id);
            if (replay?.fingerprint===fingerprint) return {transaction:await WalletTransaction.findById(replay.transactionId),idempotent:true};
        }
        throw error;
    } finally { await session.endSession(); }
};
module.exports={adjust,reserveBudget,requireAdmin,Operation,Budget};
