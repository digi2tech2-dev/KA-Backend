'use strict';

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const { Currency } = require('../../currency/currency.model');
const { Decimal, toStr } = require('../../../shared/utils/decimalPrecision');
const { numeric, quantityRules, validateQuantity } = require('../mayaCard.rules');
const { sanitize } = require('./canonicalB2B.adapter');
const ERRORS = Object.freeze({ 120: 'TOKEN_REQUIRED', 121: 'INVALID_TOKEN', 122: 'API_NOT_ALLOWED', 123: 'IP_NOT_ALLOWED', 130: 'MAINTENANCE', 100: 'INSUFFICIENT_BALANCE', 105: 'QUANTITY_UNAVAILABLE', 106: 'QUANTITY_NOT_ALLOWED', 107: 'PLAYER_BLOCKED', 108: 'TWO_FACTOR_REQUIRED', 109: 'PRODUCT_NOT_FOUND', 110: 'PRODUCT_UNAVAILABLE', 111: 'RETRY_LATER', 112: 'QUANTITY_TOO_SMALL', 113: 'QUANTITY_TOO_LARGE', 114: 'UNKNOWN_ORDER_ERROR', 500: 'SERVER_ERROR' });
const statusOf = (v) => ({ accept: 'Completed', wait: 'Pending', reject: 'Cancelled' }[String(v ?? '').trim().toLowerCase()] || 'Pending');
const uuidV4 = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
class MayaCardAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        if (!this._resolveToken()) throw new Error('[MayaCard] API token required');
        const url = new URL(provider.baseUrl || 'https://maya-card.com');
        if (url.origin !== 'https://maya-card.com' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('[MayaCard] Invalid API base URL');
        this.preserveMissingProducts = true;
        this._client = options.httpClient || axios.create({ baseURL: url.origin, timeout: options.timeoutMs ?? 30000, maxRedirects: 0,
            headers: { 'api-token': this._resolveToken(), Accept: 'application/json' } });
    }
    _safe(value) {
        // Also redact an echoed credential inside free text, not only secret keys.
        const token = this._resolveToken();
        const clean = (v) => typeof v === 'string' ? v.split(token).join('[REDACTED]') : Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;
        return clean(sanitize(value));
    }
    async _get(path, params, allowError = false) {
        let data;
        try { ({ data } = await this._client.get(`/client/api${path}`, { params, maxRedirects: 0 })); }
        catch (_) { throw new Error('[MayaCard] Request failed'); }
        const code = Number(data?.code ?? data?.error_code);
        if (!allowError && ERRORS[code]) { const e = new Error(`[MayaCard] ${ERRORS[code]}`); e.code = `MAYA_${ERRORS[code]}`; throw e; }
        return data;
    }
    async getBalance() {
        const data = await this._get('/profile');
        numeric(data?.balance);
        return { balance: String(data.balance) };
    }
    async getContent(categoryId = 0) { return this._safe(await this._get(`/content/${encodeURIComponent(categoryId)}`)); }
    async getProducts({ productsId, base = false } = {}) {
        const data = await this._get('/products', { ...(productsId ? { products_id: productsId.map(String).join(',') } : {}), ...(base ? { base: 1 } : {}) });
        if (!Array.isArray(data)) throw new Error('[MayaCard] Invalid catalog');
        const code = this.provider.mayaCardConfig?.currency;
        if (!code || !this.provider.mayaCardConfig?.currencyVerified) throw new Error('[MayaCard] Account currency must be verified and configured before synchronization');
        const currency = await Currency.findOne({ code });
        const rate = new Decimal(currency?.platformRate ?? NaN);
        if (!currency?.isActive || !rate.isFinite() || !rate.gt(0) || (code === 'USD' && !rate.eq(1))) throw new Error('[MayaCard] Invalid platform currency rate');
        const seen = new Set();
        return data.map((p) => {
            if (!p || !['number', 'string'].includes(typeof p.id) || !String(p.id).trim() || typeof p.name !== 'string' || !p.name.trim() || seen.has(String(p.id))) throw new Error('[MayaCard] Invalid or duplicate product');
            seen.add(String(p.id));
            const price = numeric(p.price);
            if (price < 0) throw new Error('[MayaCard] Invalid price');
            return this._validateDTO({ externalProductId: String(p.id), rawName: p.name, rawPrice: toStr(new Decimal(p.price).div(rate)),
                ...quantityRules(p.qty_values), isActive: p.available !== false, rawPayload: this._safe(p) });
        });
    }
    _order(item) {
        if (!item || !['number', 'string'].includes(typeof item.id) || !String(item.id).trim()) return null;
        return { providerOrderId: String(item.id), providerStatus: statusOf(item.status), rawResponse: this._safe(item) };
    }
    async _check(params) {
        const data = await this._get('/check', params);
        const list = Array.isArray(data) ? data : data?.data ?? data?.orders;
        if (!Array.isArray(list)) throw new Error('[MayaCard] Invalid check result');
        return list;
    }
    async checkOrders(ids) {
        if (!ids?.length) return [];
        const requested = new Set(ids.map(String));
        const results = (await this._check({ orders: JSON.stringify(ids.map(String)) })).map((item) => this._order(item)).filter((r) => r && requested.has(r.providerOrderId));
        if (new Set(results.map((r) => r.providerOrderId)).size !== results.length) throw new Error('[MayaCard] Duplicate check results');
        return results;
    }
    async checkOrder(id) { return (await this.checkOrders([id]))[0] || null; }
    async checkOrderByReference(referenceId) {
        if (!uuidV4(referenceId)) throw new Error('[MayaCard] UUIDv4 required');
        const list = await this._check({ orders: JSON.stringify([referenceId]), uuid: 1 });
        // Maya may omit order_uuid even for a UUID lookup. Only a single
        // unambiguous result can be associated with this single requested UUID.
        if (list.length !== 1) return { found: false };
        const item = list[0];
        if (!item || typeof item !== 'object' || Array.isArray(item)) return { found: false };
        if (Object.prototype.hasOwnProperty.call(item, 'order_uuid') && item.order_uuid !== referenceId) {
            return { found: false };
        }
        const validId = typeof item.id === 'string' ? item.id.trim().length > 0
            : Number.isSafeInteger(item.id) && item.id > 0;
        const order = validId ? this._order(item) : null;
        return order ? { found: true, ...order } : { found: false };
    }
    async _recover(referenceId, errorCode) {
        try { const result = await this.checkOrderByReference(referenceId); if (result.found) return { success: true, ...result }; } catch (_) { /* The existing poller retries UUID lookup. */ }
        return { success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN', errorCode, rawResponse: { placement: 'uncertain', ...(errorCode ? { errorCode } : {}) } };
    }
    async placeOrder(params = {}) {
        const productId = params.externalProductId ?? params.providerProductId ?? params.productId;
        const referenceId = params.referenceId;
        let qty;
        try { qty = validateQuantity(params.quantity ?? params.amount); if (!productId || !uuidV4(referenceId)) throw new Error(); }
        catch (_) { return { success: false, providerStatus: 'Cancelled', errorMessage: '[MayaCard] Invalid product, integer quantity or UUIDv4', rawResponse: {} }; }
        const reserved = /^(qty|quantity|amount|order_uuid|referenceId|externalProductId|providerProductId|productId|product_id|providerFields|customerInput|providerMapping|__proto__|constructor|prototype)$/i;
        const fields = Object.fromEntries(Object.entries(params.providerFields ?? params).filter(([k, v]) => !reserved.test(k) && !/price|balance|wallet|currency|cost|markup|token|secret|order|reference/i.test(k) && v != null && ['string', 'number', 'boolean'].includes(typeof v)));
        try {
            const data = await this._get(`/newOrder/${encodeURIComponent(productId)}/params`, { ...fields, qty, order_uuid: referenceId }, true);
            const order = this._order(data?.order);
            if (order) return { success: true, ...order, rawResponse: this._safe({ ...data, order: { ...data.order } }) };
            const code = Number(data?.code ?? data?.error_code);
            if (ERRORS[code] && ![114, 500].includes(code)) return { success: false, providerStatus: 'Cancelled', errorCode: `MAYA_${ERRORS[code]}`, errorMessage: `[MayaCard] ${ERRORS[code]}`, rawResponse: { code } };
            return this._recover(referenceId, ERRORS[code] ? `MAYA_${ERRORS[code]}` : 'MAYA_AMBIGUOUS_RESPONSE');
        } catch (_) { return this._recover(referenceId, 'MAYA_TRANSPORT_ERROR'); }
    }
}
module.exports = { MayaCardAdapter, ERRORS, uuidV4 };
