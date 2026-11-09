'use strict';
const { randomUUID } = require('crypto');
const axios = require('axios');
const { MayaCardAdapter, ERRORS } = require('../modules/providers/adapters/mayaCard.adapter');
const { quantityRules } = require('../modules/providers/mayaCard.rules');
const { Currency } = require('../modules/currency/currency.model');
const { getAdapter } = require('../modules/providers/adapters/adapter.factory');
const config = { name: 'Maya Card', slug: 'maya-card', baseUrl: 'https://maya-card.com', apiToken: 'dummy-private-token', mayaCardConfig: { currency: 'USD', currencyVerified: true } };
const product = (changes = {}) => ({ id: 365, name: 'UC 60', price: 0.104, base_price: 0.10, params: ['playerId'], qty_values: { min: 1, max: '15000.75' }, ...changes });
const make = () => { const client = { get: jest.fn() }; return { client, adapter: new MayaCardAdapter(config, { httpClient: client }) }; };
beforeEach(() => jest.spyOn(Currency, 'findOne').mockResolvedValue({ isActive: true, platformRate: '1' }));
afterEach(() => jest.restoreAllMocks());
test.each(['maya-card', 'maya card', 'mayacard'])('registers independent adapter %s', (slug) => expect(getAdapter({ ...config, slug })).toBeInstanceOf(MayaCardAdapter));
test('secure transport header, origin, timeout and redirects', () => {
    const create = jest.spyOn(axios, 'create').mockReturnValue({ get: jest.fn() });
    new MayaCardAdapter(config);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://maya-card.com', maxRedirects: 0, timeout: 30000, headers: { 'api-token': config.apiToken, Accept: 'application/json' } }));
    expect(JSON.stringify(create.mock.calls[0][0].baseURL)).not.toContain(config.apiToken);
});
test.each(['http://maya-card.com', 'https://evil.test', 'https://maya-card.com/?api-token=x', 'https://x@maya-card.com'])('rejects unsafe origin %s', (baseUrl) => expect(() => new MayaCardAdapter({ ...config, baseUrl })).toThrow());
test('profile returns balance only', async () => { const { client, adapter } = make(); client.get.mockResolvedValue({ data: { balance: '8788.683', email: 'private', name: 'private' } }); expect(await adapter.getBalance()).toEqual({ balance: '8788.683' }); expect(client.get).toHaveBeenCalledWith('/client/api/profile', expect.anything()); });
test.each([undefined, '', ' ', true, NaN, Infinity, 'Infinity'])('rejects bad balance %s', async (balance) => { const { client, adapter } = make(); client.get.mockResolvedValue({ data: { balance } }); await expect(adapter.getBalance()).rejects.toThrow(); });
test('catalog keeps raw fields, price, decimal limit and explicit false only', async () => {
    const { client, adapter } = make(); client.get.mockResolvedValue({ data: [product({ available: 0 }), product({ id: 366, available: false })] });
    const items = await adapter.getProducts({ productsId: [365, 366], base: true });
    expect(items[0]).toMatchObject({ externalProductId: '365', rawPrice: '0.104', minQty: 1, maxQty: 15000.75, isActive: true, rawPayload: product({ available: 0 }) });
    expect(items[1].isActive).toBe(false);
    expect(client.get).toHaveBeenCalledWith('/client/api/products', { params: { products_id: '365,366', base: 1 }, maxRedirects: 0 });
});
test('missing or unverified currency blocks catalog', async () => { const { client } = make(); client.get.mockResolvedValue({ data: [product()] }); await expect(new MayaCardAdapter({ ...config, mayaCardConfig: {} }, { httpClient: client }).getProducts()).rejects.toThrow(/currency/); });
test('converts verified source price using platform rate', async () => { const { client } = make(); Currency.findOne.mockResolvedValue({ isActive: true, platformRate: '50' }); client.get.mockResolvedValue({ data: [product({ price: '50' })] }); expect((await new MayaCardAdapter({ ...config, mayaCardConfig: { currency: 'EGP', currencyVerified: true } }, { httpClient: client }).getProducts())[0].rawPrice).toBe('1'); });
test.each([0, 18])('content category %s', async (id) => { const { client, adapter } = make(); client.get.mockResolvedValue({ data: [] }); await adapter.getContent(id); expect(client.get.mock.calls[0][0]).toBe(`/client/api/content/${id}`); });
test.each([[null, 1, 1], [undefined, 1, 9999], [['110','150','210'], 110, 210], [{ min: '500', max: '500000.75' }, 500, 500000.75]])('quantity rules %j', (value, minQty, maxQty) => expect(quantityRules(value)).toMatchObject({ minQty, maxQty }));
test.each([[], [''], [true], ['NaN'], [1.5], { min: 1.5, max: 4 }, { min: true, max: 4 }, { min: '', max: 4 }, { min: 5, max: 4 }, { min: 1, max: Infinity }, { min: 1, max: '' }, { min: 1, max: true }, { nope: 1 }, '5', 5, false])('rejects quantity structure %j', (value) => expect(() => quantityRules(value)).toThrow());
test.each([[' accept ', 'Completed'], ['WAIT', 'Pending'], [' reject ', 'Cancelled'], ['unknown','Pending'], [undefined,'Pending']])('order status %s', async (status, expected) => {
    const { client, adapter } = make(); const uuid = randomUUID(); client.get.mockResolvedValue({ data: { status: 'accept', order: { id: 'ID_a', status, code: 'DELIVERY' } } });
    const result = await adapter.placeOrder({ externalProductId: '365', quantity: 1, referenceId: uuid, providerFields: { playerId: 'a&b', qty: 99, order_uuid: 'bad', price: 0, product_id: 99, referenceId: 'bad' } });
    expect(result).toMatchObject({ success: true, providerOrderId: 'ID_a', providerStatus: expected, rawResponse: { order: { code: 'DELIVERY' } } });
    expect(client.get).toHaveBeenCalledWith('/client/api/newOrder/365/params', { params: { playerId: 'a&b', qty: 1, order_uuid: uuid }, maxRedirects: 0 });
});
test.each([1.5, '1.5', 0, true, '', Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects order quantity %s before HTTP', async (quantity) => { const { client, adapter } = make(); expect((await adapter.placeOrder({ externalProductId: 365, referenceId: randomUUID(), quantity })).success).toBe(false); expect(client.get).not.toHaveBeenCalled(); });
test.each(Object.keys(ERRORS))('body error %s', async (code) => {
    const { client, adapter } = make(); client.get.mockResolvedValueOnce({ data: { status: 'ERROR', code } }).mockResolvedValue({ data: { data: [] } });
    const result = await adapter.placeOrder({ externalProductId: 365, referenceId: randomUUID(), quantity: 1 });
    if (['114','500'].includes(code)) expect(result.providerStatus).toBe('PLACEMENT_UNCERTAIN');
    else expect(result).toMatchObject({ success: false, errorCode: `MAYA_${ERRORS[code]}` });
});
test('timeout checks same UUID and never re-purchases; recreation uses persisted reference', async () => {
    const { client, adapter } = make(); const uuid = randomUUID();
    client.get.mockRejectedValueOnce(new Error(`timeout ${config.apiToken}`)).mockResolvedValue({ data: { data: [{ id: 'ID_a', order_uuid: uuid, status: 'wait', code: 'SECRET_DELIVERY' }] } });
    expect(await adapter.placeOrder({ externalProductId: 365, quantity: 1, referenceId: uuid })).toMatchObject({ providerOrderId: 'ID_a', providerStatus: 'Pending' });
    await new MayaCardAdapter(config, { httpClient: client }).checkOrderByReference(uuid);
    expect(client.get.mock.calls.filter(([url]) => url.includes('newOrder'))).toHaveLength(1);
    expect(client.get.mock.calls.slice(1).every(([, opt]) => opt.params.orders === JSON.stringify([uuid]) && opt.params.uuid === 1)).toBe(true);
});
test('batch association rejects unsolicited IDs and UUID mismatch', async () => { const { client, adapter } = make(); client.get.mockResolvedValue({ data: [{ id: 'ID_a', status: 'accept', code: 'DELIVERY' }, { id: 'ID_other', status: 'accept' }] }); expect(await adapter.checkOrders(['ID_a'])).toEqual([expect.objectContaining({ providerOrderId: 'ID_a', rawResponse: expect.objectContaining({ code: 'DELIVERY' }) })]); expect(await adapter.checkOrderByReference(randomUUID())).toEqual({ found: false }); });
test('sanitizes echoed token and transport errors', async () => { const { client, adapter } = make(); client.get.mockResolvedValue({ data: { order: { id: 'ID_a', status: 'wait', message: config.apiToken, 'api-token': config.apiToken } } }); const result = await adapter.placeOrder({ externalProductId: 365, referenceId: randomUUID(), quantity: 1 }); expect(JSON.stringify(result)).not.toContain(config.apiToken); client.get.mockRejectedValue(new Error(config.apiToken)); await expect(adapter.getBalance()).rejects.toThrow('[MayaCard] Request failed'); });

test('base adapter contract aliases and optional playerId remain supported', async () => {
    const { client, adapter } = make(); const uuid = randomUUID();
    client.get.mockResolvedValue({ data: { order: { id: 'ID_a', status: 'wait' } } });
    await adapter.placeOrder({ productId: '365', amount: 1, playerId: 'player', referenceId: uuid });
    expect(client.get.mock.calls[0][1].params).toEqual({ playerId: 'player', qty: 1, order_uuid: uuid });
});

describe('single UUID lookup association', () => {
    test.each([
        ['omitted UUID', (uuid) => [{ id: 'ID_recovered', status: 'accept', code: 'DELIVERED_CODE' }], true],
        ['matching UUID', (uuid) => [{ id: 'ID_recovered', order_uuid: uuid, status: 'accept', code: 'DELIVERED_CODE' }], true],
        ['different UUID', () => [{ id: 'ID_recovered', order_uuid: randomUUID(), status: 'accept' }], false],
        ['multiple results with one matching UUID', (uuid) => [{ id: 'ID_recovered', order_uuid: uuid }, { id: 'ID_other' }], false],
        ['duplicate matching results', (uuid) => [{ id: 'ID_recovered', order_uuid: uuid }, { id: 'ID_recovered', order_uuid: uuid }], false],
        ['missing ID', () => [{ status: 'accept' }], false],
        ['empty ID', () => [{ id: '  ', status: 'accept' }], false],
        ['null ID', () => [{ id: null }], false],
        ['boolean ID', () => [{ id: true }], false],
        ['nonfinite ID', () => [{ id: Infinity }], false],
        ['NaN ID', () => [{ id: NaN }], false],
        ['zero ID', () => [{ id: 0 }], false],
        ['decimal numeric ID', () => [{ id: 1.5 }], false],
        ['object ID', () => [{ id: {} }], false],
        ['explicit null UUID', () => [{ id: 'ID_recovered', order_uuid: null }], false],
        ['explicit empty UUID', () => [{ id: 'ID_recovered', order_uuid: '' }], false],
        ['no results', () => [], false],
        ['null result', () => [null], false],
    ])('%s', async (_label, items, found) => {
        const { client, adapter } = make();
        const uuid = randomUUID();
        client.get.mockResolvedValue({ data: { orders: items(uuid) } });
        const result = await adapter.checkOrderByReference(uuid);
        if (found) {
            expect(result).toMatchObject({ found: true, providerOrderId: 'ID_recovered', providerStatus: 'Completed', rawResponse: { code: 'DELIVERED_CODE' } });
        } else {
            expect(result).toEqual({ found: false });
        }
        expect(client.get.mock.calls).toEqual([['/client/api/check', { params: { orders: JSON.stringify([uuid]), uuid: 1 }, maxRedirects: 0 }]]);
    });
});
