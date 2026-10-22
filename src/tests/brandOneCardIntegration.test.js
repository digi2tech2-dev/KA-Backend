'use strict';

const { BrandOneCardAdapter } = require('../modules/providers/adapters/brandOneCard.adapter');
const { Currency } = require('../modules/currency/currency.model');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const cache = require('../modules/providers/providerPriceCache');
const { createOrder } = require('../modules/orders/order.service');
const { connectTestDB, disconnectTestDB, clearCollections, createProduct, createCustomerWithGroup } = require('./testHelpers');

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
const currency = (code, platformRate) => Currency.create({ code, name: code, symbol: code, platformRate, marketRate: 999 });

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); cache.clearAll(); await currency('USD', 1); await currency('EGP', 50); });
afterEach(() => jest.restoreAllMocks());

test('sync and published price updates use USD, live lookup also uses USD', async () => {
    const provider = await Provider.create(providerData);
    const { client, adapter } = make();
    await syncProviderProducts(provider.id, { httpClient: client });
    const pp = await ProviderProduct.findOne({ provider: provider.id });
    const published = await createProduct({ provider: provider.id, providerProduct: pp.id, pricingMode: 'sync', markupType: 'percentage', markupValue: 10 });
    await syncProviderProducts(provider.id, { httpClient: client });
    expect(await Product.findById(published.id)).toMatchObject({ providerPrice: '1', finalPrice: '1.1', basePrice: '1.1' });
    expect(await cache.getLivePrice(provider.id, '365', adapter)).toBe('1');
});
test('bad currency aborts sync without overwriting or deactivating existing products', async () => {
    const provider = await Provider.create(providerData);
    const { client } = make();
    await syncProviderProducts(provider.id, { httpClient: client });
    await Currency.updateOne({ code: 'EGP' }, { isActive: false });
    await expect(syncProviderProducts(provider.id, { httpClient: client })).rejects.toMatchObject({ code: 'PROVIDER_CURRENCY_RATE_INVALID' });
    expect(await ProviderProduct.findOne({ provider: provider.id })).toMatchObject({ rawPrice: '1', isActive: true });
});
test('live price increase compares converted USD and updates published prices', async () => {
    const provider = await Provider.create(providerData);
    const { client, adapter } = make();
    await syncProviderProducts(provider.id, { httpClient: client });
    const pp = await ProviderProduct.findOne({ provider: provider.id });
    const published = await createProduct({ provider: provider.id, providerProduct: pp.id, basePrice: '1', providerPrice: '1', markupType: 'percentage', markupValue: 10 });
    const { customer } = await createCustomerWithGroup({}, { percentage: 0 });
    client.get.mockResolvedValue({ data: [product({ price: '100' })] });
    await expect(createOrder({ userId: customer.id, productId: published.id, quantity: 1, idempotencyKey: 'jit', provider: adapter }))
        .rejects.toMatchObject({ code: 'PROVIDER_PRICE_INCREASED' });
    // Price propagation deliberately runs outside the order transaction.
    for (let attempt = 0; attempt < 20; attempt++) {
        const updated = await Product.findById(published.id);
        if (updated.providerPrice === '2') {
            expect(updated.basePrice).toBe('2.2');
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Published price was not refreshed');
});
test.each([['amount', 3, '6'], ['package', 1, '2']])('%s bills correctly through unchanged platform pricing', async (type, quantity, total) => {
    const provider = await Provider.create(providerData);
    const { client } = make([product({ price: '100', product_type: type })]);
    await syncProviderProducts(provider.id, { httpClient: client });
    const pp = await ProviderProduct.findOne({ provider: provider.id });
    const published = await createProduct({ provider: provider.id, providerProduct: pp.id, basePrice: '2', providerPrice: '2', minQty: pp.minQty, maxQty: pp.maxQty });
    const { customer } = await createCustomerWithGroup({ walletBalance: 100 }, { percentage: 0 });
    const { order } = await createOrder({ userId: customer.id, productId: published.id, quantity, idempotencyKey: `type-${type}` });
    expect(String(order.totalPrice)).toBe(total);
    expect(order.quantity).toBe(quantity);
});
