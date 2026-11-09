'use strict';

const { BusinessRuleError } = require('../../shared/errors/AppError');
const isMaya = (provider) => [provider?.adapterType, provider?.slug, provider?.name].some((key) => ['maya-card', 'maya card', 'mayacard'].includes(String(key || '').trim().toLowerCase()));
const numeric = (value) => {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value))) {
        throw new BusinessRuleError('Invalid Maya numeric value', 'MAYA_QUANTITY_INVALID');
    }
    return Number(value);
};
const quantityRules = (value) => {
    if (value === undefined) return { minQty: 1, maxQty: 9999 };
    if (value === null) return { minQty: 1, maxQty: 1 };
    const integer = (v) => { const n = numeric(v); if (!Number.isSafeInteger(n) || n < 1) throw new BusinessRuleError('Invalid Maya quantity', 'MAYA_QUANTITY_INVALID'); return n; };
    if (Array.isArray(value)) {
        if (!value.length) throw new BusinessRuleError('Empty Maya quantities', 'MAYA_QUANTITY_INVALID');
        const allowed = value.map(integer);
        return { minQty: Math.min(...allowed), maxQty: Math.max(...allowed), allowed };
    }
    if (typeof value !== 'object' || Object.keys(value).some((k) => !['min', 'max'].includes(k))) throw new BusinessRuleError('Unknown Maya quantity rules', 'MAYA_QUANTITY_INVALID');
    const minQty = integer(value.min), maxQty = numeric(value.max);
    if (maxQty < minQty) throw new BusinessRuleError('Inverted Maya quantity range', 'MAYA_QUANTITY_INVALID');
    return { minQty, maxQty };
};
const validateQuantity = (quantity, payload) => {
    const qty = numeric(quantity);
    if (!Number.isSafeInteger(qty) || qty < 1) throw new BusinessRuleError('Quantity must be a positive safe integer', 'MAYA_QUANTITY_INVALID');
    if (payload) {
        const rules = quantityRules(payload.qty_values);
        if (qty < rules.minQty || qty > rules.maxQty || (rules.allowed && !rules.allowed.includes(qty))) throw new BusinessRuleError('Quantity is not allowed', 'MAYA_QUANTITY_INVALID');
    }
    return qty;
};
module.exports = { isMaya, numeric, quantityRules, validateQuantity };
