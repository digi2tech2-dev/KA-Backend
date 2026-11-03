'use strict';

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const {
    COIN_RECHARGE_DYNAMIC_PRODUCT_ID,
} = require('../coinRecharge.constants');

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const TARGET_UID_RE = /^\d+$/;

class CoinRechargeApiError extends Error {
    constructor(message, { code = 'COIN_RECHARGE_API_ERROR', statusCode = null, providerCode = null } = {}) {
        super(message);
        this.name = 'CoinRechargeApiError';
        this.code = code;
        this.statusCode = statusCode;
        this.providerCode = providerCode;
    }
}

const safeMessage = (value, fallback) => String(value || fallback).slice(0, 500);

const safeResponse = (body = {}) => ({
    code: body?.code ?? null,
    message: safeMessage(body?.message, 'No supplier message'),
});

const validateDigits = (value, label) => {
    if (typeof value !== 'string' || !value || !TARGET_UID_RE.test(value) || value.length > 50) {
        throw new CoinRechargeApiError(`${label} must be a non-empty decimal digit string.`, {
            code: `INVALID_${label.toUpperCase().replace(/\s+/g, '_')}`,
        });
    }
    return value;
};

const validateCoins = (value) => {
    const text = String(value ?? '');
    if (!/^\d+$/.test(text)) {
        throw new CoinRechargeApiError('coins must be a positive safe integer.', { code: 'INVALID_COINS' });
    }
    const coins = Number(text);
    if (!Number.isSafeInteger(coins) || coins < 1 || coins > MAX_SAFE_INTEGER) {
        throw new CoinRechargeApiError('coins must be a positive safe integer.', { code: 'INVALID_COINS' });
    }
    return coins;
};

class CoinRechargeAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        this.isNonIdempotentSaleAdapter = true;
        this.supportsOrderStatusPolling = false;
        this.http = options.http || axios.create({
            baseURL: String(provider?.baseUrl || '').replace(/\/+$/, ''),
            timeout: Number(options.timeoutMs || process.env.COIN_RECHARGE_API_TIMEOUT_MS || 20000),
            // Explicitly do not install retry middleware for non-idempotent sales.
            validateStatus: () => true,
        });
    }

    _secretKey() {
        const token = this._resolveToken();
        if (!token) {
            throw new CoinRechargeApiError('Coin recharge credential is not configured.', {
                code: 'COIN_RECHARGE_CREDENTIAL_MISSING',
            });
        }
        return token;
    }

    _baseUrlIsValid() {
        try {
            const url = new URL(this.provider?.baseUrl);
            return ['http:', 'https:'].includes(url.protocol);
        } catch (_) {
            return false;
        }
    }

    _productConfig() {
        return this.provider?.coinRechargeConfig?.product || {};
    }

    async getProducts() {
        const config = this._productConfig();
        const price = String(config.unitPrice ?? '');
        const minQty = Number(config.minCoins);
        const maxQty = Number(config.maxCoins);
        if (!/^\d+(?:\.\d+)?$/.test(price) || Number(price) <= 0) {
            throw new CoinRechargeApiError('Coin recharge unit price is not configured.', { code: 'COIN_RECHARGE_PRODUCT_NOT_CONFIGURED' });
        }
        if (!Number.isSafeInteger(minQty) || !Number.isSafeInteger(maxQty) || minQty < 1 || maxQty < minQty) {
            throw new CoinRechargeApiError('Coin recharge quantity range is not configured.', { code: 'COIN_RECHARGE_PRODUCT_NOT_CONFIGURED' });
        }
        return [this._validateDTO({
            externalProductId: COIN_RECHARGE_DYNAMIC_PRODUCT_ID,
            rawName: config.name || 'Dynamic Coin Recharge',
            rawPrice: price,
            minQty,
            maxQty,
            isActive: config.isActive === true,
            rawPayload: {
                kind: 'synthetic_coin_recharge',
                unitPrice: price,
                minCoins: minQty,
                maxCoins: maxQty,
                isActive: config.isActive === true,
            },
        })];
    }

    async _get(path, params) {
        if (!this._baseUrlIsValid()) {
            throw new CoinRechargeApiError('Coin recharge base URL is invalid.', { code: 'COIN_RECHARGE_INVALID_BASE_URL' });
        }
        try {
            const response = await this.http.get(path, { params });
            if (response.status < 200 || response.status >= 300 || !response.data || typeof response.data !== 'object') {
                throw new CoinRechargeApiError('Coin recharge supplier returned an invalid response.', {
                    code: 'COIN_RECHARGE_INVALID_RESPONSE', statusCode: response.status,
                });
            }
            return response.data;
        } catch (err) {
            if (err instanceof CoinRechargeApiError) throw err;
            throw new CoinRechargeApiError('Coin recharge supplier request failed.', {
                code: err?.code || 'COIN_RECHARGE_REQUEST_FAILED',
                statusCode: err?.response?.status ?? null,
            });
        }
    }

    async getBalance() {
        const body = await this._get('/dealer/account', { secretKey: this._secretKey() });
        if (body.code !== 200 || !body.data || !/^\d+$/.test(String(body.data.coinBalance ?? ''))) {
            throw new CoinRechargeApiError('Coin recharge account response is invalid.', {
                code: 'COIN_RECHARGE_ACCOUNT_RESPONSE_INVALID', providerCode: body?.code ?? null,
            });
        }
        return { balance: String(body.data.coinBalance), unit: 'coins', currency: null, checkedAt: new Date(), source: 'coin_recharge_live' };
    }

    async verifyTargetUser({ targetUid }) {
        const userId = validateDigits(String(targetUid ?? ''), 'target user ID');
        const body = await this._get('/dealer/user-info', { secretKey: this._secretKey(), userId });
        if (body.code !== 200 || !body.data || typeof body.data !== 'object') {
            throw new CoinRechargeApiError(safeMessage(body?.message, 'Target verification failed.'), {
                code: 'COIN_RECHARGE_TARGET_INVALID', providerCode: body?.code ?? null,
            });
        }
        const returnedId = String(body.data.userId ?? userId);
        if (!TARGET_UID_RE.test(returnedId)) {
            throw new CoinRechargeApiError('Target verification response is malformed.', { code: 'COIN_RECHARGE_TARGET_RESPONSE_INVALID' });
        }
        if (BigInt(returnedId) !== BigInt(userId)) {
            throw new CoinRechargeApiError('Supplier returned a different target user.', { code: 'COIN_RECHARGE_TARGET_MISMATCH' });
        }
        return {
            valid: true,
            user: {
                userId: returnedId,
                nickName: body.data.nickName ? String(body.data.nickName) : null,
                avatar: body.data.avatar ? String(body.data.avatar) : null,
            },
        };
    }

    async validateUser(targetUid) {
        if (!this.provider?.isActive) {
            throw new CoinRechargeApiError('Provider is inactive.', { code: 'PROVIDER_INACTIVE' });
        }
        const { user } = await this.verifyTargetUser({ targetUid });
        return { uid: user.userId, nickName: user.nickName, avatar: user.avatar };
    }

    async placeOrder({ toUserId, target_uid, quantity, coins }) {
        // Every call made after this point is considered potentially delivered.
        // The supplier documents neither an idempotency key nor a status lookup.
        let params;
        try {
            if (!this._baseUrlIsValid()) throw new CoinRechargeApiError('Coin recharge base URL is invalid.', { code: 'COIN_RECHARGE_INVALID_BASE_URL' });
            params = {
                secretKey: this._secretKey(),
                toUserId: validateDigits(String(toUserId ?? target_uid ?? ''), 'target user ID'),
                coins: validateCoins(coins ?? quantity),
            };
        } catch (err) {
            return { success: false, definitePreSendFailure: true, providerStatus: 'Cancelled', providerOrderId: null, errorCode: err.code || 'COIN_RECHARGE_INVALID_REQUEST', errorMessage: err.message, rawResponse: { errorCode: err.code || 'COIN_RECHARGE_INVALID_REQUEST' } };
        }

        try {
            const response = await this.http.post('/dealer/sale', null, { params });
            const body = response?.data;
            if (response.status >= 200 && response.status < 300 && body && typeof body === 'object' && body.code === 200) {
                return { success: true, providerStatus: 'Completed', providerOrderId: null, rawResponse: safeResponse(body), errorCode: '200' };
            }
            return { success: false, requiresManualReview: true, outcomeUncertain: true, providerStatus: 'Unknown', providerOrderId: null, errorCode: String(body?.code ?? `HTTP_${response?.status ?? 'UNKNOWN'}`), errorMessage: safeMessage(body?.message, 'Supplier sale result is indeterminate.'), rawResponse: safeResponse(body) };
        } catch (err) {
            return { success: false, requiresManualReview: true, outcomeUncertain: true, providerStatus: 'Unknown', providerOrderId: null, errorCode: err?.code || 'COIN_RECHARGE_SALE_TRANSPORT_ERROR', errorMessage: 'Supplier sale result is indeterminate.', rawResponse: { errorCode: err?.code || 'COIN_RECHARGE_SALE_TRANSPORT_ERROR', httpStatus: err?.response?.status ?? null } };
        }
    }

    async getTransactionHistory({ page = 1 } = {}) {
        const safePage = Number(page);
        if (!Number.isSafeInteger(safePage) || safePage < 1) throw new CoinRechargeApiError('page must be a positive integer.', { code: 'INVALID_HISTORY_PAGE' });
        const body = await this._get('/dealer/list', { secretKey: this._secretKey(), page: safePage });
        if (!body || !Array.isArray(body.rows)) throw new CoinRechargeApiError('Coin recharge history response is invalid.', { code: 'COIN_RECHARGE_HISTORY_RESPONSE_INVALID' });
        return { total: Number(body.total) || 0, currentPage: Number(body.currentPage) || safePage, pageSize: Number(body.pageSize) || body.rows.length, lastPage: Number(body.lastPage) || 0, rows: body.rows.map((row) => ({ toUserId: String(row?.toUserId ?? ''), toNickName: row?.toNickName ? String(row.toNickName) : null, coins: String(row?.coins ?? ''), createAt: row?.createAt ?? null })) };
    }

    async checkOrder() { throw new CoinRechargeApiError('Order status polling is unsupported for coin recharge.', { code: 'COIN_RECHARGE_STATUS_UNSUPPORTED' }); }
    async checkOrders() { throw new CoinRechargeApiError('Batch status polling is unsupported for coin recharge.', { code: 'COIN_RECHARGE_STATUS_UNSUPPORTED' }); }
}

module.exports = { CoinRechargeAdapter, CoinRechargeApiError, TARGET_UID_RE, validateCoins };
