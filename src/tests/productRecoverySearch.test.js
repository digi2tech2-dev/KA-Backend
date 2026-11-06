'use strict';
jest.mock('../modules/providers/adapters/adapter.factory', () => ({ getProviderAdapter: jest.fn() }));
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { Provider } = require('../modules/providers/provider.model');
const jwt = require('jsonwebtoken');
const { connectTestDB, disconnectTestDB, clearCollections, createAdmin, createCustomerWithGroup } = require('./testHelpers');
const recovery = require('../modules/admin/productRecovery.service');
beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); getProviderAdapter.mockReset(); });
test('searches every active provider and sorts USD prices without merging duplicate names', async () => {
    const first = await Provider.create({ name:'First', slug:'first', baseUrl:'https://example.invalid', isActive:true });
    const second = await Provider.create({ name:'Second', slug:'second', baseUrl:'https://example.invalid', isActive:true });
    getProviderAdapter.mockImplementation((provider) => ({ fetchProducts: async () => [{ externalProductId:'a', rawName:'Test product', rawPrice: String(provider._id.equals(first._id) ? 9 : 3), minQty:1, maxQty:5, isActive:true, rawPayload:{ currency:'USD', available:true, price:provider._id.equals(first._id) ? 9 : 3, min:1, max:5 } }] }));
    const result = await recovery.search({ search:'test' });
    expect(result.total).toBe(2);
    expect(result.items.map((p) => p.providerName)).toEqual(['Second','First']);
    expect(result.items.map((p) => p.price)).toEqual(['3','9']);
    expect(result.items[0].limitsVerified).toBe(true);
    expect(getProviderAdapter).toHaveBeenCalledTimes(2);
    expect(second._id).toBeDefined();
});
test('reports unavailable provider separately and does not invent currency or verified limits', async () => {
    await Provider.create({ name:'Offline', slug:'offline', baseUrl:'https://example.invalid', isActive:true });
    await Provider.create({ name:'Incomplete', slug:'incomplete', baseUrl:'https://example.invalid', isActive:true });
    getProviderAdapter.mockImplementation((provider) => ({ fetchProducts: async () => {
        if (provider.name === 'Offline') throw new Error('credential-bearing internal error');
        return [{ externalProductId:'x', rawName:'Test', rawPrice:'4', minQty:1, maxQty:9999, rawPayload:{} }];
    } }));
    const result = await recovery.search({});
    expect(result.failures).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('credential-bearing');
    expect(result.items[0]).toMatchObject({ price:null, currency:null, available:null, limitsVerified:false });
    expect((await recovery.search({ availability:'unavailable' })).items).toHaveLength(0);
});
test('deduplicates repeated IDs from one provider without merging other providers', async () => {
    await Provider.create({ name:'Repeated', slug:'repeated', baseUrl:'https://example.invalid', isActive:true });
    getProviderAdapter.mockImplementation(() => ({ fetchProducts: async () => [
        { externalProductId:'same', rawName:'A', rawPrice:'2', rawPayload:{ price:2, currency:'USD', min:1, max:1 } },
        { externalProductId:'same', rawName:'A', rawPrice:'2', rawPayload:{ price:2, currency:'USD', min:1, max:1 } },
    ] }));
    const result = await recovery.search({ search:'A' });
    expect(result.total).toBe(1);
    expect(result.items[0].minQty).toBe(1);
});
test('does not present invalid supplier quantity bounds as verified', async () => {
    await Provider.create({ name:'Invalid Limits', slug:'invalid-limits', baseUrl:'https://example.invalid', isActive:true });
    getProviderAdapter.mockImplementation(() => ({ fetchProducts: async () => [
        { externalProductId:'bad', rawName:'Invalid range', rawPrice:'2', minQty:1, maxQty:9999, rawPayload:{ price:2, currency:'USD', min:10, max:2 } },
    ] }));
    const result = await recovery.search({});
    expect(result.items[0]).toMatchObject({ limitsVerified:false, minQty:null, maxQty:null });
});
test('reuses a recent supplier response across consecutive search keystrokes', async () => {
    await Provider.create({ name:'Cached', slug:'cached', baseUrl:'https://example.invalid', isActive:true });
    const fetchProducts = jest.fn(async () => [
        { externalProductId:'one', rawName:'Alpha', rawPrice:'2', rawPayload:{ price:2, currency:'USD', min:1, max:2 } },
        { externalProductId:'two', rawName:'Beta', rawPrice:'3', rawPayload:{ price:3, currency:'USD', min:1, max:2 } },
    ]);
    getProviderAdapter.mockImplementation(() => ({ fetchProducts }));
    expect((await recovery.search({ search:'Al' })).items).toHaveLength(1);
    expect((await recovery.search({ search:'Be' })).items).toHaveLength(1);
    expect(fetchProducts).toHaveBeenCalledTimes(1);
});
test('search HTTP endpoint requires product management authorization', async () => {
    const app = require('../app');
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}/api/admin/product-recovery/search`;
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup();
        const auth = (user) => ({ Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}` });
        expect((await fetch(base)).status).toBe(401);
        expect((await fetch(base, { headers: auth(customer) })).status).toBe(403);
        expect((await fetch(base, { headers: auth(admin) })).status).toBe(200);
        expect((await fetch(`${base}?page=0`, { headers: auth(admin) })).status).toBe(400);
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
