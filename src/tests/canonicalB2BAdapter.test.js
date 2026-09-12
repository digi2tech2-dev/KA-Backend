'use strict';

const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');

const provider = {
    name: 'Canonical upstream',
    adapterType: 'canonical-b2b',
    baseUrl: 'https://upstream.example/client/api/',
    apiToken: 'test-provider-token',
};

const makeClient = () => ({ get: jest.fn(), post: jest.fn() });
const makeAdapter = () => {
    const client = makeClient();
    return { client, adapter: new CanonicalB2BAdapter(provider, { httpClient: client }) };
};

describe('CanonicalB2BAdapter', () => {
    test('uses the complete base URL unchanged apart from its trailing slash and api-token auth', () => {
        const adapter = new CanonicalB2BAdapter(provider);
        expect(adapter._client.defaults.baseURL).toBe('https://upstream.example/client/api');
        expect(adapter._client.defaults.headers['api-token']).toBe('test-provider-token');
    });

    test('maps profile, products, and preserves structured fields in raw payload', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValueOnce({ data: { balance: '5', currency: 'USD', email: 'a@example.com' } });
        await expect(adapter.getBalance()).resolves.toMatchObject({ balance: '5', currency: 'USD' });
        client.get.mockResolvedValueOnce({ data: [{ id: 1000, name: 'UC', price: 1.5, available: true, fields: [{ key: 'player_id' }] }] });
        const [product] = await adapter.getProducts();
        expect(product).toMatchObject({ externalProductId: '1000', rawName: 'UC', rawPrice: '1.5', isActive: true });
        expect(product.rawPayload.fields).toEqual([{ key: 'player_id' }]);
    });

    test('rejects explicit non-USD upstream product currency', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'x', price: 1, currency: 'EGP' }] });
        await expect(adapter.getProducts()).rejects.toThrow(/EGP/);
    });

    test('places with the stable reference and checks normal and reference statuses', async () => {
        const { adapter, client } = makeAdapter();
        client.post.mockResolvedValueOnce({ data: { status: 'OK', data: { order_id: 'ID-1', status: 'wait' } } });
        await expect(adapter.placeOrder({ externalProductId: '1000', quantity: 1, referenceId: 'LOCAL-1', player_id: '123' })).resolves.toMatchObject({ success: true, providerOrderId: 'ID-1' });
        expect(client.post).toHaveBeenCalledWith('/orders', expect.objectContaining({ order_uuid: 'LOCAL-1', params: { player_id: '123' } }));

        client.get.mockResolvedValueOnce({ data: { status: 'OK', data: [{ order_id: 'ID-1', status: 'wait' }] } });
        await expect(adapter.checkOrder('ID-1')).resolves.toMatchObject({ providerOrderId: 'ID-1' });
        client.get.mockResolvedValueOnce({ data: { status: 'OK', data: [{ order_id: 'ID-1', order_uuid: 'LOCAL-1', status: 'wait' }] } });
        await expect(adapter.checkOrderByReference('LOCAL-1')).resolves.toMatchObject({ found: true, providerOrderId: 'ID-1' });
    });

    test('recovers an ambiguous placement by stable reference without creating a new UUID', async () => {
        const { adapter, client } = makeAdapter();
        const error = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        client.post.mockRejectedValueOnce(error);
        client.get.mockResolvedValueOnce({ data: { status: 'OK', data: [{ order_id: 'ID-2', order_uuid: 'LOCAL-2', status: 'wait' }] } });
        await expect(adapter.placeOrder({ externalProductId: '1000', quantity: 1, referenceId: 'LOCAL-2' })).resolves.toMatchObject({ success: true, providerOrderId: 'ID-2' });
        expect(client.get).toHaveBeenCalledWith('/check', { params: { uuids: 'LOCAL-2' } });
    });
});
