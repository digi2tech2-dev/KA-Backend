'use strict';

const { parseProviderCatalog } = require('../modules/providers/adapters/providerCatalogJson');
const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');
const { BrandOneCardAdapter } = require('../modules/providers/adapters/brandOneCard.adapter');
const { AlkasrVipAdapter } = require('../modules/providers/adapters/alkasr.adapter');
const { TorosfonAdapter } = require('../modules/providers/adapters/toros.adapter');
const { RoyalCrownAdapter } = require('../modules/providers/adapters/royalCrown.adapter');
const { IbraAdapter } = require('../modules/providers/adapters/ibra.adapter');
const { Currency } = require('../modules/currency/currency.model');
const { normalizeProviderDecimalPrice } = require('../shared/utils/decimalPrecision');
const { mapProduct } = require('../modules/clientCompat/clientCompat.mappers');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const priceCache = require('../modules/providers/providerPriceCache');

const longPrice = '1234567.12345678901234567890123456789012345678901234567890123456789';
const tinyPrice = '0.000000000000000000000000000000000000000000000000000000000123456789';

afterEach(() => {
    jest.restoreAllMocks();
    priceCache.clearAll();
});

test('parses numeric price aliases without changing IDs, quantities, flags or text', () => {
    const description = 'price: 1.23456789, "price": 2.345678901234567890, slash \\ and quote "';
    const text = `{"id":365,"name":${JSON.stringify(description)},"available":false,"qty_values":{"min":1,"max":100},"data":[{"price":${longPrice},"product_price":${tinyPrice},"rate":1.23456789e-12,"cost_per_unit":"1.000000001"}],"pr\\u0069ce":1.234567890123456789}`;
    expect(parseProviderCatalog(text)).toEqual({
        id: 365, name: description, available: false, qty_values: { min: 1, max: 100 },
        data: [{ price: longPrice, product_price: tinyPrice, rate: '1.23456789e-12', cost_per_unit: '1.000000001' }],
        price: '1.234567890123456789',
    });
});

test.each(['{"price":01}', '{"price":1.}', '{"price":1,', 'not json'])(
    'rejects malformed JSON: %s', (text) => expect(() => parseProviderCatalog(text)).toThrow(SyntaxError)
);

test.each([longPrice, tinyPrice, '0.123456789', '0', '1000000'])(
    'normalization does not cap source digits: %s', (price) => {
        expect(normalizeProviderDecimalPrice(price)).toBe(price);
    }
);

describe.each([
    ['B2B', CanonicalB2BAdapter, 'price'],
    ['Brand One Card', BrandOneCardAdapter, 'price'],
    ['Brand1 / Alkasr', AlkasrVipAdapter, 'price'],
    ['Toros', TorosfonAdapter, 'product_price'],
    ['Royal Crown', RoyalCrownAdapter, 'rate'],
    ['Ibra', IbraAdapter, 'cost'],
])('%s catalog HTTP decoding', (_name, Adapter, priceKey) => {
    test.each([longPrice, tinyPrice, '0.123456789', '0'])(
        'retains the complete numeric supplier price %s', async (price) => {
            jest.spyOn(Currency, 'findOne').mockResolvedValue({ isActive: true, platformRate: 1 });
            const adapter = new Adapter({ apiToken: 'test', baseUrl: 'https://supplier.example.test' });
            // Exercise real Axios response transformation with raw JSON, not an
            // already-decoded mock that could hide precision loss at the boundary.
            adapter._client.defaults.adapter = async (config) => ({
                config, status: 200, statusText: 'OK', headers: {},
                data: `[{"id":365,"name":"Test","currency":"USD","${priceKey}":${price},"qty_values":{"min":1,"max":100}}]`,
            });
            const [dto] = await adapter.getProducts();
            expect(dto.rawPrice).toBe(price);
            expect(dto.rawPayload[priceKey]).toBe(price);
            expect(normalizeProviderDecimalPrice(dto.rawPrice)).toBe(price);
            expect(dto.externalProductId).toBe('365');
        }
    );
});

test.each([false, true])('B2B price aliases survive JSON round trip (minimal=%s)', (minimal) => {
    const mapped = mapProduct({ product: { compatProductId: 365, name: 'Test' },
        price: longPrice, priceUsd: tinyPrice, minimal });
    const decoded = parseProviderCatalog(JSON.stringify(mapped));
    for (const key of ['price', 'cost', 'rate', 'api_price', 'provider_price']) {
        expect(decoded[key]).toBe(longPrice);
    }
    expect(normalizeProviderDecimalPrice(decoded.base_price)).toBe(tinyPrice);
    expect(normalizeProviderDecimalPrice(decoded.original_price)).toBe(tinyPrice);
});

test('ordinary B2B prices retain numeric compatibility without six-place rounding', () => {
    const mapped = mapProduct({ product: { compatProductId: 365, name: 'Test' }, price: '1.23456789' });
    expect(mapped.price).toBe(1.23456789);
    expect(parseProviderCatalog(JSON.stringify(mapped)).price).toBe('1.23456789');
});

test('accepts UTF-8 BOM, string prices and scientific numeric prices', () => {
    const result = parseProviderCatalog('\uFEFF{"price":"0.12345678901234567890123456789","cost":1.234567890123456789e-12}');
    expect(result.price).toBe('0.12345678901234567890123456789');
    expect(normalizeProviderDecimalPrice(result.cost)).toBe('0.000000000001234567890123456789');
});

test('Brand One conversion preserves original source digits and converts beyond six places', async () => {
    jest.spyOn(Currency, 'findOne').mockResolvedValue({ isActive: true, platformRate: 50 });
    const adapter = new BrandOneCardAdapter({ apiToken: 'test' });
    adapter._client.defaults.adapter = async (config) => ({ config, status: 200, headers: {},
        data: '[{"id":365,"name":"Test","currency":"EGP","price":0.123456789}]' });
    const [dto] = await adapter.getProducts();
    expect(dto.rawPrice).toBe('0.00246913578');
    expect(dto.rawPayload.sourcePrice).toBe('0.123456789');
});

test.each([
    ['canonical-b2b', CanonicalB2BAdapter],
    ['brand-one-card', BrandOneCardAdapter],
])('%s keeps all source digits in sync writes and live-price cache', async (slug, Adapter) => {
    const provider = { _id: `precision-${slug}`, slug, name: slug, isActive: true,
        apiToken: 'test', baseUrl: 'https://supplier.example.test' };
    jest.spyOn(Currency, 'findOne').mockResolvedValue({ isActive: true, platformRate: 1 });
    const adapter = new Adapter(provider);
    adapter._client.defaults.adapter = async (config) => ({ config, status: 200, headers: {},
        data: `[{"id":365,"name":"Test","currency":"USD","price":${longPrice}}]` });
    jest.spyOn(Provider, 'findById').mockResolvedValue(provider);
    const write = jest.spyOn(ProviderProduct, 'findOneAndUpdate').mockResolvedValue({ _id: 'pp-test' });
    jest.spyOn(ProviderProduct, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
    jest.spyOn(Product, 'find').mockReturnValue({ select: async () => [
        { _id: 'published', markupType: 'percentage', markupValue: 10 },
    ] });
    const publish = jest.spyOn(Product, 'findByIdAndUpdate').mockResolvedValue({});
    const result = await syncProviderProducts(provider._id, { httpClient: adapter._client });
    expect(result.errors).toEqual([]);
    expect(result.totalFetched).toBe(1);
    expect(write.mock.calls[0][1].$set.rawPrice).toBe(longPrice);
    expect(write.mock.calls[0][1].$set.rawPayload.price).toBe(longPrice);
    expect(publish.mock.calls[0][1].$set.providerPrice).toBe(longPrice);
    expect(await priceCache.getLivePrice(provider._id, '365', adapter)).toBe(longPrice);
});
