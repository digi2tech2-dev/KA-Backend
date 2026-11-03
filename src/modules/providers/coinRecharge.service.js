'use strict';

const Decimal = require('decimal.js');
const { Provider } = require('./provider.model');
const { getProviderAdapter } = require('./adapters/adapter.factory');
const { BusinessRuleError, NotFoundError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { COIN_RECHARGE_PROVIDER_SLUG, COIN_RECHARGE_DYNAMIC_PRODUCT_ID, COIN_RECHARGE_TARGET_FIELD_KEY } = require('./coinRecharge.constants');

const assertCoinRechargeProvider = async (providerId) => {
    const provider = await Provider.findById(providerId);
    if (!provider) throw new NotFoundError('Provider');
    if (String(provider.adapterType || provider.slug || '').toLowerCase() !== COIN_RECHARGE_PROVIDER_SLUG) {
        throw new BusinessRuleError('Provider is not a coin recharge supplier.', 'NOT_COIN_RECHARGE_PROVIDER');
    }
    return provider;
};

const isCoinRechargeProduct = (provider, providerProduct) =>
    String(provider?.adapterType || provider?.slug || '').toLowerCase() === COIN_RECHARGE_PROVIDER_SLUG
    && String(providerProduct?.externalProductId || '') === COIN_RECHARGE_DYNAMIC_PRODUCT_ID;

const updateProductConfig = async (providerId, config, auditContext = {}) => {
    const provider = await assertCoinRechargeProvider(providerId);
    if (!provider.isActive) throw new BusinessRuleError('Activate the supplier before configuring coin recharge.', 'PROVIDER_INACTIVE');
    let unitPrice;
    try { unitPrice = new Decimal(config.unitPrice); } catch (_) { throw new BusinessRuleError('unitPrice must be a positive finite decimal.', 'INVALID_COIN_RECHARGE_UNIT_PRICE'); }
    const minCoins = Number(config.minCoins);
    const maxCoins = Number(config.maxCoins);
    if (!unitPrice.isFinite() || !unitPrice.gt(0) || unitPrice.decimalPlaces() > 50) throw new BusinessRuleError('unitPrice must be a positive finite decimal.', 'INVALID_COIN_RECHARGE_UNIT_PRICE');
    if (!Number.isSafeInteger(minCoins) || minCoins < 1 || !Number.isSafeInteger(maxCoins) || maxCoins < minCoins) throw new BusinessRuleError('Coin limits must be positive safe integers and maxCoins must be >= minCoins.', 'INVALID_COIN_RECHARGE_RANGE');
    provider.coinRechargeConfig = { product: { externalProductId: COIN_RECHARGE_DYNAMIC_PRODUCT_ID, name: String(config.name || 'Dynamic Coin Recharge').trim(), unitPrice: unitPrice.toFixed(), minCoins, maxCoins, isActive: config.isActive === true } };
    await provider.save();
    // Deliberately regenerate the one local synthetic ProviderProduct.  This
    // performs no supplier HTTP request and makes it immediately publishable.
    await require('./providerProductSync.service').syncProviderProducts(provider._id);
    createAuditLog({ actorId: auditContext.actorId, actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN, action: ADMIN_ACTIONS.PROVIDER_UPDATED, entityType: ENTITY_TYPES.PROVIDER, entityId: provider._id, metadata: { event: 'COIN_RECHARGE_PRODUCT_CONFIG_UPDATED', externalProductId: COIN_RECHARGE_DYNAMIC_PRODUCT_ID, unitPrice: unitPrice.toFixed(), minCoins, maxCoins, isActive: config.isActive === true }, ipAddress: auditContext.ipAddress, userAgent: auditContext.userAgent });
    return provider.coinRechargeConfig.product;
};

const verifyTargetForProduct = async ({ provider, targetUid, quantity }) => {
    if (!provider?.isActive) throw new BusinessRuleError('Provider is inactive.', 'PROVIDER_INACTIVE');
    const config = provider.coinRechargeConfig?.product;
    if (config?.isActive !== true) throw new BusinessRuleError('Coin recharge product is inactive.', 'COIN_RECHARGE_PRODUCT_INACTIVE');
    if (quantity !== undefined && (!Number.isSafeInteger(quantity) || quantity < config.minCoins || quantity > config.maxCoins)) {
        throw new BusinessRuleError('Coin quantity is outside the configured range.', 'INVALID_COIN_RECHARGE_QUANTITY');
    }
    const adapter = getProviderAdapter(provider, { strict: true });
    return adapter.verifyTargetUser({ targetUid });
};

const mergeCoinRechargeProductBehavior = (productData) => {
    // AD renders dynamicFields first; the coin target must be the only input.
    productData.dynamicFields = [];
    productData.orderFields = [{ id: COIN_RECHARGE_TARGET_FIELD_KEY, key: COIN_RECHARGE_TARGET_FIELD_KEY, label: 'User ID', type: 'text', required: true, isVerifiable: true, validation: { digitsOnly: true, minLength: 1, maxLength: 50 }, verification: { required: true, type: 'coin_recharge_target' }, sortOrder: 0, isActive: true }];
    productData.providerMapping = { [COIN_RECHARGE_TARGET_FIELD_KEY]: 'toUserId' };
    productData.executionType = 'automatic';
};

module.exports = { assertCoinRechargeProvider, isCoinRechargeProduct, updateProductConfig, verifyTargetForProduct, mergeCoinRechargeProductBehavior };
