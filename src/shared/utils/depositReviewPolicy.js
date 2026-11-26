'use strict';
const { BusinessRuleError } = require('../errors/AppError');
const immutableAmount = (deposit, overrides = {}) => {
    if ((overrides.amount != null && Number(overrides.amount) !== Number(deposit.requestedAmount))
        || (overrides.currency != null && String(overrides.currency).toUpperCase() !== String(deposit.currency).toUpperCase())) {
        throw new BusinessRuleError('Deposit amount and currency cannot be changed during approval. Reject and submit a corrected deposit.', 'DEPOSIT_AMOUNT_IMMUTABLE');
    }
    if (!Number.isFinite(Number(deposit.requestedAmount)) || Number(deposit.requestedAmount) <= 0) throw new BusinessRuleError('Invalid deposit amount.', 'INVALID_AMOUNT');
};
const immutableUpdate = data => {
    if (['requestedAmount','currency','amountUsd'].some(key => Object.hasOwn(data || {},key))) throw new BusinessRuleError('Financial deposit evidence is immutable. Submit a corrected request.', 'DEPOSIT_AMOUNT_IMMUTABLE');
};
module.exports = { immutableAmount, immutableUpdate };
