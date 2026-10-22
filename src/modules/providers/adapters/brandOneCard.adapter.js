'use strict';

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const { Currency } = require('../../currency/currency.model');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const { Decimal, toStr } = require('../../../shared/utils/decimalPrecision');
const { sanitize } = require('./canonicalB2B.adapter');

const currencyCode = (value) => String(value ?? '').trim().toUpperCase();
const statusOf = (status) => ({ accept: 'Completed', wait: 'Pending', reject: 'Cancelled' }[
    String(status ?? '').trim().toLowerCase()
] || 'Pending');

class BrandOneCardAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken();
        if (!token) throw new Error('[BrandOneCard] api token is required');
        this._client = options.httpClient || axios.create({
            baseURL: String(provider.baseUrl || 'https://api.brand-one-card.com').replace(/\/+$/, ''),
            timeout: options.timeoutMs ?? 180_000,
            headers: { 'api-token': token, Accept: 'application/json' },
        });
    }

    async _get(path, params) {
        const { data } = await this._client.get(`/client/api${path}`, params ? { params } : undefined);
        if (String(data?.status).toUpperCase() === 'ERROR') {
            const error = new BusinessRuleError(
                `[BrandOneCard] ${data.msg || data.detail || 'Provider request rejected'} (code ${data.code})`,
                'BRAND_ONE_CARD_API_ERROR'
            );
            error.providerBody = sanitize(data);
            throw error;
        }
        return data;
    }

    async getBalance() {
        return sanitize(await this._get('/profile'));
    }

    async getContent(categoryId = 0) {
        return sanitize(await this._get(`/content/${encodeURIComponent(categoryId)}`));
    }

    async getProducts() {
        const data = await this._get('/products');
        const products = Array.isArray(data) ? data : data?.products ?? data?.data?.products;
        if (!Array.isArray(products)) throw new Error('[BrandOneCard] Invalid product catalog');
        let accountCurrency;
        if (products.some((product) => !currencyCode(product.currency))) {
            accountCurrency = currencyCode((await this.getBalance()).currency);
        }
        // Validate the entire catalog before returning any DTOs to either sync engine.
        // Rates are scoped to this fetch so a later fetch sees admin changes.
        const rates = new Map();
        for (const product of products) {
            const code = currencyCode(product.currency) || accountCurrency;
            if (!code) throw new BusinessRuleError('[BrandOneCard] Product and account currency are missing', 'PROVIDER_CURRENCY_MISSING');
            if (rates.has(code)) continue;
            const currency = await Currency.findOne({ code });
            let rate;
            try { rate = new Decimal(currency?.platformRate ?? NaN); } catch (_) { rate = new Decimal(NaN); }
            if (!currency || !currency.isActive || !rate.isFinite() || !rate.gt(0) || (code === 'USD' && !rate.eq(1))) {
                throw new BusinessRuleError(
                    `[BrandOneCard] ${code} currency is missing, disabled, or has an invalid platformRate`,
                    'PROVIDER_CURRENCY_RATE_INVALID'
                );
            }
            rates.set(code, rate);
        }
        return products.map((product) => {
            const code = currencyCode(product.currency) || accountCurrency;
            let price;
            try { price = new Decimal(product.price); } catch (_) { price = new Decimal(NaN); }
            if (!price.isFinite() || price.isNegative()) {
                throw new BusinessRuleError(`[BrandOneCard] Invalid price for product ${product.id}`, 'PROVIDER_PRICE_INVALID');
            }
            const qty = product.qty_values;
            if (qty != null && (!Number.isFinite(Number(qty.min)) || !Number.isFinite(Number(qty.max))
                || Number(qty.min) < 1 || Number(qty.max) < Number(qty.min))) {
                throw new BusinessRuleError(`[BrandOneCard] Invalid quantity range for product ${product.id}`, 'PROVIDER_QUANTITY_INVALID');
            }
            // The existing platform bills price x quantity. Keep fixed-price
            // packages at one to preserve that contract without changing it.
            const isPackage = product.product_type === 'package';
            if (isPackage && qty != null && Number(qty.min) > 1) {
                throw new BusinessRuleError(
                    `[BrandOneCard] Fixed-price package ${product.id} does not allow quantity 1; it cannot be priced by the existing platform`,
                    'PROVIDER_PACKAGE_QUANTITY_UNSUPPORTED'
                );
            }
            return this._validateDTO({
                externalProductId: String(product.id ?? ''),
                rawName: String(product.name || 'Unknown'),
                rawPrice: toStr(price.div(rates.get(code))),
                minQty: isPackage || qty == null ? 1 : Number(qty.min),
                maxQty: isPackage || qty == null ? 1 : Number(qty.max),
                isActive: ![false, 0, '0', 'false'].includes(product.available),
                rawPayload: sanitize({ ...product, sourcePrice: product.price, sourceCurrency: code,
                    pricingCurrency: 'USD', platformRate: toStr(rates.get(code)) }),
            });
        });
    }

    _order(item) {
        if (item?.order_id == null) return null;
        return { providerOrderId: String(item.order_id), providerStatus: statusOf(item.status), rawResponse: sanitize(item) };
    }

    async _check(params) {
        const data = await this._get('/check', params);
        if (!Array.isArray(data?.data)) throw new Error('[BrandOneCard] Invalid check response');
        return data.data;
    }

    async checkOrderByReference(referenceId) {
        if (!referenceId) throw new Error('[BrandOneCard] referenceId is required');
        const items = await this._check({ uuid: 1, orders: JSON.stringify([String(referenceId)]) });
        const order = this._order(items.find((item) => String(item.order_uuid) === String(referenceId)));
        return order ? { found: true, ...order } : { found: false };
    }

    async checkOrders(orderIds) {
        if (!orderIds?.length) return [];
        const items = await this._check({ orders: JSON.stringify(orderIds) });
        const requested = new Set(orderIds.map(String));
        return items.map((item) => this._order(item)).filter((item) => item && requested.has(item.providerOrderId));
    }

    async checkOrder(orderId) {
        return (await this.checkOrders([orderId]))[0] || null;
    }

    async _recover(referenceId) {
        try {
            const recovered = await this.checkOrderByReference(referenceId);
            if (recovered.found) return { success: true, ...recovered, errorMessage: null };
        } catch (_) { /* Cron will retry reference lookup without issuing a refund. */ }
        return { success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN',
            rawResponse: { placement: 'uncertain' }, errorMessage: null };
    }

    async placeOrder(params = {}) {
        const productId = params.externalProductId ?? params.providerProductId ?? params.productId;
        const quantity = params.quantity ?? params.amount;
        const referenceId = String(params.referenceId ?? '').trim();
        const failure = (message, rawResponse = {}) => ({ success: false, providerOrderId: null,
            providerStatus: 'Cancelled', rawResponse: sanitize(rawResponse), errorMessage: message });
        if (!productId || !referenceId || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
            return failure('[BrandOneCard] Product, positive quantity and stable referenceId are required');
        }
        // Fulfillment already applies providerMapping. Forward only customer fields;
        // internal execution and financial fields must never reach the query string.
        const internal = new Set(['externalProductId', 'providerProductId', 'productId', 'quantity', 'amount',
            'referenceId', 'qty', 'order_uuid', 'providerMapping', 'customerInput']);
        const fields = Object.fromEntries(Object.entries(params.providerFields ?? params).filter(([key, value]) =>
            !internal.has(key) && !/price|balance|wallet|currency|cost|markup|token|secret/i.test(key)
            && value != null && ['string', 'number', 'boolean'].includes(typeof value)));
        try {
            const data = await this._get(`/newOrder/${encodeURIComponent(productId)}/params`, {
                ...fields, qty: quantity, order_uuid: referenceId,
            });
            const order = this._order(data?.data);
            if (!order) return this._recover(referenceId);
            return { success: true, ...order, rawResponse: sanitize(data), errorMessage: null };
        } catch (error) {
            if (error.code === 'BRAND_ONE_CARD_API_ERROR') return failure(error.message, error.providerBody);
            // Without an explicit API rejection even an HTTP failure cannot prove
            // that the side-effecting GET did not create an upstream order.
            return this._recover(referenceId);
        }
    }
}

module.exports = { BrandOneCardAdapter };
