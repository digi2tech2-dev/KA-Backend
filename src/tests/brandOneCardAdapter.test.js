'use strict';

const { BrandOneCardAdapter } = require('../modules/providers/adapters/brandOneCard.adapter');
const axios = require('axios');
const { AlkasrVipAdapter } = require('../modules/providers/adapters/alkasr.adapter');
const { getAdapter } = require('../modules/providers/adapters/adapter.factory');
const { Currency } = require('../modules/currency/currency.model');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const cache = require('../modules/providers/providerPriceCache');
const { applyProviderMapping } = require('../modules/orders/orderFields.validator');

const providerData = { name: 'Brand One Card', slug: 'brand-one-card', apiToken: 'test-token', baseUrl: 'https://api.brand-one-card.com' };
const product = (overrides = {}) => ({ id: 365, name: 'UC', price: '50', currency: 'EGP', available: true,
    qty_values: { min: 1, max: 100 }, product_type: 'amount', params: ['playerId'],
    params_info: [{ key: 'playerId', required: true }], ...overrides });
const make = (products = [product()]) => {
    const client = { get: jest.fn(async (url) => {
        if (url.endsWith('/products')) return { data: products };
        if (url.endsWith('/profile')) return { data: { balance: '8788.68', currency: 'EGP' } };
        throw new Error(`Unexpected URL ${url}`);
    }) };
    return { client, adapter: new BrandOneCardAdapter(providerData, { httpClient: client }) };
};

beforeEach(() => {
    cache.clearAll();
    jest.spyOn(Currency, 'findOne').mockImplementation(async ({ code }) =>
        ['USD', 'EGP'].includes(code) ? { isActive: true, platformRate: code === 'USD' ? 1 : 50, marketRate: 999 } : null);
});
afterEach(() => jest.restoreAllMocks());

test.each(['brand-one-card', 'brand one card', 'brandonecard'])('factory registers %s independently', (slug) => {
    expect(getAdapter({ ...providerData, slug })).toBeInstanceOf(BrandOneCardAdapter);
});
test.each(['brand1-card', 'brand1 card', 'brand1card'])('factory preserves %s', (slug) => {
    expect(getAdapter({ ...providerData, slug })).toBeInstanceOf(AlkasrVipAdapter);
});
test('HTTP client uses documented base URL and api-token authentication', () => {
    const spy = jest.spyOn(axios, 'create').mockReturnValue({ get: jest.fn() });
    new BrandOneCardAdapter({ apiToken: 'test-token' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://api.brand-one-card.com',
        headers: expect.objectContaining({ 'api-token': 'test-token' }) }));
});

test('mixed currencies use platformRate once per currency and preserve original metadata', async () => {
    const { adapter } = make([product(), product({ id: 2, price: '5', currency: 'USD' }), product({ id: 3, price: '100' })]);
    const spy = jest.spyOn(Currency, 'findOne');
    const items = await adapter.getProducts();
    expect(items.map((item) => item.rawPrice)).toEqual(['1', '5', '2']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(items[0].rawPayload).toMatchObject({ price: '50', currency: 'EGP', sourcePrice: '50', sourceCurrency: 'EGP', params: ['playerId'], product_type: 'amount' });
});
test('preserves tiny prices through conversion', async () => {
    const { adapter } = make([product({ price: '0.00000000000000000000000005' })]);
    expect((await adapter.getProducts())[0].rawPrice).toBe('0.000000000000000000000000001');
});
test('missing product currency reads profile once and balance stays in original currency', async () => {
    const { adapter, client } = make([product({ currency: null }), product({ id: 2, currency: '' })]);
    expect((await adapter.getProducts()).map((item) => item.rawPrice)).toEqual(['1', '1']);
    expect(client.get.mock.calls.filter(([url]) => url.endsWith('/profile'))).toHaveLength(1);
    expect(await adapter.getBalance()).toMatchObject({ balance: '8788.68', currency: 'EGP' });
});
test('missing account and product currencies raises a business error', async () => {
    const { adapter, client } = make();
    client.get.mockResolvedValueOnce({ data: [product({ currency: null })] }).mockResolvedValueOnce({ data: { balance: 10 } });
    await expect(adapter.getProducts()).rejects.toMatchObject({ code: 'PROVIDER_CURRENCY_MISSING' });
});
test.each([null, { isActive: false, platformRate: 50 }, ...[0, -1, null, 'invalid', NaN, Infinity].map((platformRate) => ({ isActive: true, platformRate }))])(
    'rejects absent, disabled or invalid exchange configuration %j', async (rate) => {
        jest.spyOn(Currency, 'findOne').mockResolvedValue(rate);
        await expect(make().adapter.getProducts()).rejects.toMatchObject({ code: 'PROVIDER_CURRENCY_RATE_INVALID', statusCode: 422 });
    }
);
test('qty null is exactly one; ranges and unavailable products are preserved', async () => {
    const { adapter } = make([product({ qty_values: null, product_type: 'package' }), product({ id: 2, available: false, qty_values: { min: 5, max: 20 } })]);
    const items = await adapter.getProducts();
    expect(items[0]).toMatchObject({ minQty: 1, maxQty: 1, rawPayload: { product_type: 'package' } });
    expect(items[1]).toMatchObject({ minQty: 5, maxQty: 20, isActive: false });
});
test('fixed-price packages allow one only without changing platform quantity billing', async () => {
    const { adapter } = make([product({ product_type: 'package', qty_values: { min: 1, max: 50 } })]);
    expect((await adapter.getProducts())[0]).toMatchObject({ minQty: 1, maxQty: 1,
        rawPrice: '1', rawPayload: { qty_values: { min: 1, max: 50 } } });
});
test('unsupported package range aborts the catalog before any prices can be synced', async () => {
    const { adapter } = make([product({ product_type: 'package', qty_values: { min: 2, max: 50 } })]);
    await expect(adapter.getProducts()).rejects.toMatchObject({ code: 'PROVIDER_PACKAGE_QUANTITY_UNSUPPORTED' });
});
test('catalog conversion only reads currencies and never updates their configuration', async () => {
    const update = jest.spyOn(Currency, 'updateOne');
    const save = jest.spyOn(Currency.prototype, 'save');
    await make().adapter.getProducts();
    expect(update).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
});
test.each(['accept', 'wait', 'reject', 'unknown', 'OK', undefined])('placement maps inner status %s safely', async (status) => {
    const { adapter, client } = make();
    client.get.mockResolvedValueOnce({ data: { status: 'OK', data: { order_id: '482913', status } } });
    expect(await adapter.placeOrder({ externalProductId: '365', quantity: 1, referenceId: 'LOCAL-1' })).toMatchObject({
        success: true, providerStatus: status === 'accept' ? 'Completed' : status === 'reject' ? 'Cancelled' : 'Pending',
    });
});
test('HTTP 200 ERROR rejects placement and errors in checks throw instead of refunding', async () => {
    const { adapter, client } = make();
    client.get.mockResolvedValue({ data: { status: 'ERROR', code: 100, msg: 'Insufficient balance' } });
    await expect(adapter.placeOrder({ externalProductId: '365', quantity: 1, referenceId: 'R' })).resolves.toMatchObject({ success: false, errorMessage: expect.stringContaining('Insufficient balance') });
    await expect(adapter.checkOrder('482913')).rejects.toMatchObject({ code: 'BRAND_ONE_CARD_API_ERROR' });
    await expect(adapter.getProducts()).rejects.toMatchObject({ code: 'BRAND_ONE_CARD_API_ERROR' });
});
test('mapped fields are sent without requiring playerId or leaking internal financial params; uuid is stable', async () => {
    const { adapter, client } = make();
    client.get.mockResolvedValue({ data: { status: 'OK', data: { order_id: 482913, status: 'wait' } } });
    const fields = applyProviderMapping({ account: 'abc', zone: 'EU' }, { account: 'account_id', zone: 'server' });
    const args = { externalProductId: 365, quantity: 3, referenceId: 'R', price: 100, walletBalance: 500, ...fields };
    await adapter.placeOrder(args);
    await adapter.placeOrder(args);
    for (const call of client.get.mock.calls) expect(call).toEqual(['/client/api/newOrder/365/params', {
        params: { qty: 3, order_uuid: 'R', account_id: 'abc', server: 'EU' },
    }]);
});
test('timeout recovers order by stable reference', async () => {
    const { adapter, client } = make();
    client.get.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))
        .mockResolvedValueOnce({ data: { status: 'OK', data: [{ order_id: 482913, order_uuid: 'R', status: 'accept' }] } });
    await expect(adapter.placeOrder({ externalProductId: 365, quantity: 1, referenceId: 'R' })).resolves.toMatchObject({ success: true, providerOrderId: '482913', providerStatus: 'Completed' });
    expect(client.get).toHaveBeenLastCalledWith('/client/api/check', { params: { uuid: 1, orders: JSON.stringify(['R']) } });
});
test.each(['not_found', 'lookup_error', 'malformed'])('uncertain creation remains uncertain after %s', async (recovery) => {
    const { adapter, client } = make();
    client.get.mockRejectedValueOnce(new Error('connection lost'));
    if (recovery === 'lookup_error') client.get.mockRejectedValueOnce(new Error('network'));
    else client.get.mockResolvedValueOnce({ data: recovery === 'malformed' ? { status: 'OK' } : { status: 'OK', data: [] } });
    await expect(adapter.placeOrder({ externalProductId: 365, quantity: 1, referenceId: 'R' })).resolves.toMatchObject({ success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN' });
});
test('single and batch checks serialize orders as JSON and unknown status stays pending', async () => {
    const { adapter, client } = make();
    client.get.mockResolvedValue({ data: { status: 'OK', data: [{ order_id: 1, status: 'unknown' }, { order_id: 2, status: 'reject' }] } });
    expect(await adapter.checkOrder(1)).toMatchObject({ providerStatus: 'Pending' });
    expect(client.get).toHaveBeenLastCalledWith('/client/api/check', { params: { orders: '[1]' } });
    expect(await adapter.checkOrders([1, 2])).toHaveLength(2);
    expect(client.get).toHaveBeenLastCalledWith('/client/api/check', { params: { orders: '[1,2]' } });
});
test('malformed placement without order id triggers reference recovery', async () => {
    const { adapter, client } = make();
    client.get.mockResolvedValueOnce({ data: { status: 'OK' } })
        .mockResolvedValueOnce({ data: { status: 'OK', data: [] } });
    await expect(adapter.placeOrder({ externalProductId: 365, quantity: 1, referenceId: 'R' }))
        .resolves.toMatchObject({ success: true, providerStatus: 'PLACEMENT_UNCERTAIN' });
});
test('sync engine persists converted USD and propagates USD plus markup to published products', async () => {
    const provider = { ...providerData, _id: 'provider-test', isActive: true };
    jest.spyOn(Provider, 'findById').mockResolvedValue(provider);
    const upsert = jest.spyOn(ProviderProduct, 'findOneAndUpdate').mockResolvedValue({ _id: 'pp-test' });
    jest.spyOn(ProviderProduct, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
    jest.spyOn(Product, 'find').mockReturnValue({ select: async () => [{ _id: 'published-test', markupType: 'percentage', markupValue: 10 }] });
    const publish = jest.spyOn(Product, 'findByIdAndUpdate').mockResolvedValue({});
    const { client } = make();
    expect(await syncProviderProducts(provider._id, { httpClient: client })).toMatchObject({ totalFetched: 1, pricesSynced: 1, errors: [] });
    expect(upsert.mock.calls[0][1].$set).toMatchObject({ rawPrice: '1', rawPayload: { sourcePrice: '50', sourceCurrency: 'EGP' } });
    expect(publish).toHaveBeenCalledWith('published-test', { $set: { providerPrice: '1', finalPrice: '1.1', basePrice: '1.1' } });
});
test('sync engine performs no price writes or deactivation when currency setup is invalid', async () => {
    jest.spyOn(Provider, 'findById').mockResolvedValue({ ...providerData, _id: 'provider-test', isActive: true });
    jest.spyOn(Currency, 'findOne').mockResolvedValue({ isActive: false, platformRate: 50 });
    const upsert = jest.spyOn(ProviderProduct, 'findOneAndUpdate');
    const deactivate = jest.spyOn(ProviderProduct, 'updateMany');
    const publish = jest.spyOn(Product, 'findByIdAndUpdate');
    await expect(syncProviderProducts('provider-test', { httpClient: make().client }))
        .rejects.toMatchObject({ code: 'PROVIDER_CURRENCY_RATE_INVALID' });
    expect(upsert).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
});
