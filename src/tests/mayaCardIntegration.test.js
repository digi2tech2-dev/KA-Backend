'use strict';
jest.mock('../modules/whatsapp/whatsapp.service', () => ({ sendAdminNotification: jest.fn().mockResolvedValue() }));
jest.mock('../modules/notifications/notification.service', () => ({ notifyNewManualOrder: jest.fn(), notifyOrderCompleted: jest.fn(), notifyOrderFailed: jest.fn() }));
const { randomUUID } = require('crypto');
const { MayaCardAdapter } = require('../modules/providers/adapters/mayaCard.adapter');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { Currency } = require('../modules/currency/currency.model');
const { Order, MAX_RETRY_COUNT } = require('../modules/orders/order.model');
const { createOrder } = require('../modules/orders/order.service');
const { executeOrder, pollProcessingOrders, processOrderStatusResult } = require('../modules/orders/orderFulfillment.service');
const { pollPendingOrders } = require('../modules/orders/orderPolling.service');
const { syncProviderProducts, syncAllProviders, isSyncRunning } = require('../modules/providers/providerProductSync.service');
const providerService = require('../modules/providers/provider.service');
const adminService = require('../modules/admin/admin.providers.service');
const { redactProvider, validateCatalogMax } = require('../modules/providers/providerSafety');
const { connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup, createProduct, freshUser, countTransactions } = require('./testHelpers');
const providerData = { name: 'Maya Card', slug: 'maya-card', adapterType: 'maya-card', baseUrl: 'https://maya-card.com', apiToken: 'dummy-private-token', isActive: true, syncInterval: 0, mayaCardConfig: { currency: 'USD', currencyVerified: true } };
const raw = (overrides = {}) => ({ id: 365, name: 'UC 60', price: 1, qty_values: { min: 1, max: 5.75 }, ...overrides });
beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); await Currency.create({ code: 'USD', name: 'Dollar', symbol: '$', platformRate: 1 }); });
afterEach(() => jest.restoreAllMocks());
const fixture = async (payload = raw()) => {
    const provider = await Provider.create(providerData);
    const client = { get: jest.fn().mockResolvedValue({ data: [payload] }) };
    await syncProviderProducts(provider.id, { httpClient: client });
    const pp = await ProviderProduct.findOne({ provider: provider.id });
    const product = await createProduct({ provider: provider.id, providerProduct: pp.id, basePrice: '1', minQty: pp.minQty, maxQty: pp.maxQty });
    const { customer } = await createCustomerWithGroup({ walletBalance: 100 }, { percentage: 0 });
    return { provider, pp, product, customer, client, adapter: new MayaCardAdapter(provider, { httpClient: client }) };
};
const paidOrder = async (f) => {
    const { order } = await createOrder({ userId: f.customer.id, productId: f.product.id, quantity: f.pp.minQty, idempotencyKey: randomUUID() });
    await Order.findByIdAndUpdate(order.id, { status: 'PROCESSING', executionType: 'automatic' });
    return Order.findById(order.id);
};
test('Maya defaults are inactive and manual-only; unrelated defaults retained', async () => {
    const { isActive, syncInterval, ...data } = providerData;
    expect(await Provider.create(data)).toMatchObject({ isActive: false, syncInterval: 0 });
    expect(await Provider.create({ name: 'Other', baseUrl: 'https://example.invalid' })).toMatchObject({ isActive: true, syncInterval: 60 });
    const { schemas } = require('../modules/admin/admin.validation');
    expect(schemas.createProvider.validate(data).value).toMatchObject({ isActive: false, syncInterval: 0 });
    expect(schemas.createProvider.validate({ name: 'Other', baseUrl: 'https://example.invalid' }).value).toMatchObject({ isActive: true, syncInterval: 60 });
});
test('catalog absence, empty response, invalid catalog and explicit unavailable remain supplier scoped', async () => {
    const f = await fixture();
    await ProviderProduct.updateOne({ _id: f.pp.id }, { translatedName: 'Manual name' });
    const other = await Provider.create({ name: 'Other', baseUrl: 'https://example.invalid' });
    const otherProduct = await ProviderProduct.create({ provider: other.id, externalProductId: '365', rawName: 'Other', rawPrice: '9' });
    const manual = await createProduct({ provider: f.provider.id, providerProduct: f.pp.id, basePrice: '9', pricingMode: 'manual' });
    f.client.get.mockResolvedValue({ data: [raw({ id: 366 })] });
    await syncProviderProducts(f.provider.id, { httpClient: f.client });
    expect(await ProviderProduct.findById(f.pp.id)).toMatchObject({ isActive: true, translatedName: 'Manual name' });
    f.client.get.mockResolvedValue({ data: [] }); await syncProviderProducts(f.provider.id, { httpClient: f.client });
    f.client.get.mockResolvedValue({ data: [raw({ price: 5 }), raw({ id: 999, qty_values: [] })] });
    await expect(syncProviderProducts(f.provider.id, { httpClient: f.client })).rejects.toThrow();
    expect(isSyncRunning(f.provider.id)).toBe(false);
    expect((await ProviderProduct.findById(f.pp.id)).rawPrice).toBe('1');
    f.client.get.mockResolvedValue({ data: [raw({ available: false })] }); await syncProviderProducts(f.provider.id, { httpClient: f.client });
    expect((await ProviderProduct.findById(f.pp.id)).isActive).toBe(false);
    expect((await ProviderProduct.findById(otherProduct.id)).rawPrice).toBe('9');
    expect((await Product.findById(manual.id)).basePrice).toBe('9');
});
test.each([1.5, '1.5', true, '', Number.MAX_SAFE_INTEGER + 1])('invalid order quantity %s costs nothing', async (quantity) => {
    const f = await fixture(); f.client.get.mockClear();
    await expect(createOrder({ userId: f.customer.id, productId: f.product.id, quantity })).rejects.toMatchObject({ code: 'MAYA_QUANTITY_INVALID' });
    expect((await freshUser(f.customer.id)).walletBalance).toBe(100);
    expect(await countTransactions(f.customer.id)).toBe(0);
    expect(f.client.get).not.toHaveBeenCalled();
});
test('discrete values reject interior integers before debit even with published range override', async () => {
    const f = await fixture(raw({ qty_values: ['1','3','5'] }));
    await expect(createOrder({ userId: f.customer.id, productId: f.product.id, quantity: 2 })).rejects.toMatchObject({ code: 'MAYA_QUANTITY_INVALID' });
    expect(await countTransactions(f.customer.id)).toBe(0);
});
test('decimal catalog maximum passes publish validators and schemas only for Maya', async () => {
    const f = await fixture();
    expect((await Product.findById(f.product.id)).maxQty).toBe(5.75);
    await expect(validateCatalogMax(5.75, { req: { body: { providerProductId: f.pp.id }, params: {} } })).resolves.toBe(true);
    await expect(validateCatalogMax(5.75, { req: { body: {}, params: {} } })).rejects.toThrow();
    const { publishFromProviderProduct } = require('../modules/products/product.service');
    await Product.deleteOne({ _id: f.product.id });
    expect(await publishFromProviderProduct({ providerProductId: f.pp.id, name: 'Published', pricingMode: 'sync' })).toMatchObject({ maxQty: 5.75 });
});
test('timeout persists UUID, keeps debit, concurrent dispatch buys once, then UUID poll completes', async () => {
    const f = await fixture(); const order = await paidOrder(f);
    expect(order.providerOrderUuid).toMatch(/^[0-9a-f-]{36}$/);
    f.client.get.mockRejectedValue(new Error('timeout'));
    await Promise.all([executeOrder(order.id, f.adapter), executeOrder(order.id, f.adapter)]);
    let saved = await Order.findById(order.id);
    expect(saved).toMatchObject({ status: 'PROCESSING', providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN', refunded: false });
    expect((await freshUser(f.customer.id)).walletBalance).toBe(99);
    expect(f.client.get.mock.calls.filter(([url]) => url.includes('newOrder'))).toHaveLength(1);
    f.client.get.mockClear().mockResolvedValue({ data: [{ id: 'ID_a', order_uuid: order.providerOrderUuid, status: 'accept', code: 'DELIVERED' }] });
    await pollProcessingOrders(new MayaCardAdapter(f.provider, { httpClient: f.client }));
    saved = await Order.findById(order.id);
    expect(saved).toMatchObject({ status: 'COMPLETED', providerOrderId: 'ID_a', refunded: false, providerRawResponse: { code: 'DELIVERED' } });
    expect(f.client.get.mock.calls[0][1].params).toEqual({ orders: JSON.stringify([order.providerOrderUuid]), uuid: 1 });
    expect(await countTransactions(f.customer.id)).toBe(1);
});
test('second polling job finds uncertain orders without provider IDs and moves exhausted cases to review without refund', async () => {
    const f = await fixture(); const order = await paidOrder(f);
    await Order.findByIdAndUpdate(order.id, { providerStatus: 'PLACEMENT_UNCERTAIN', retryCount: MAX_RETRY_COUNT - 1 });
    f.client.get.mockResolvedValue({ data: [] });
    await pollPendingOrders({ adapterOverrides: { [f.provider.id]: f.adapter } });
    expect(await Order.findById(order.id)).toMatchObject({ status: 'MANUAL_REVIEW', refunded: false });
    expect((await freshUser(f.customer.id)).walletBalance).toBe(99);
});
test('pending supplier ID also reaches manual review without refund at retry limit', async () => {
    const f = await fixture(); const order = await paidOrder(f);
    await Order.findByIdAndUpdate(order.id, { providerOrderId: 'ID_a', retryCount: MAX_RETRY_COUNT - 1 });
    await processOrderStatusResult(await Order.findById(order.id), { providerStatus: 'Pending', rawResponse: {} });
    expect(await Order.findById(order.id)).toMatchObject({ status: 'MANUAL_REVIEW', refunded: false });
    expect(await countTransactions(f.customer.id)).toBe(1);
});
test('confirmed rejection uses existing refund once', async () => {
    const f = await fixture(); const order = await paidOrder(f);
    f.client.get.mockResolvedValue({ data: { order: { id: 'ID_a', status: 'reject' } } });
    await executeOrder(order.id, f.adapter); await executeOrder(order.id, f.adapter);
    expect(await Order.findById(order.id)).toMatchObject({ refunded: true });
    expect((await freshUser(f.customer.id)).walletBalance).toBe(100);
    expect(await countTransactions(f.customer.id)).toBe(2);
});
test('safe CRUD DTOs and omitted or placeholder credentials preserve token', async () => {
    const f = await fixture();
    const updated = await providerService.updateProvider(f.provider.id, { name: 'Maya renamed', apiToken: '' });
    expect(updated.apiToken).toBe(providerData.apiToken);
    const dto = redactProvider(updated);
    expect(dto).toMatchObject({ hasApiToken: true }); expect(JSON.stringify(dto)).not.toContain(providerData.apiToken);
    expect(await adminService.updateProvider(f.provider.id, { apiToken: '[REDACTED]', mayaCardConfig: { currency: 'USD', currencyVerified: true } })).toMatchObject({ hasApiToken: true });
    expect(JSON.stringify(await adminService.listProviders())).not.toContain(providerData.apiToken);
    expect((await Provider.findById(f.provider.id)).apiToken).toBe(providerData.apiToken);
});
test('manual-only Maya is skipped by background bulk synchronization', async () => {
    const f = await fixture(); f.client.get.mockClear();
    expect(await syncAllProviders({ httpClient: f.client })).toEqual([]);
    expect(f.client.get).not.toHaveBeenCalled();
});

test('idempotent customer retry keeps UUID and debit stable', async () => {
    const f = await fixture(); const params = { userId: f.customer.id, productId: f.product.id, quantity: 1, idempotencyKey: 'same-request' };
    const first = await createOrder(params); const second = await createOrder(params);
    expect(second.idempotent).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(second.order.providerOrderUuid).toBe(first.order.providerOrderUuid);
    expect(await countTransactions(f.customer.id)).toBe(1);
});
test('second quantity check blocks a corrupted stored quantity before supplier submission', async () => {
    const f = await fixture(); const order = await paidOrder(f);
    await Order.findByIdAndUpdate(order.id, { quantity: 1.5 }); f.client.get.mockClear();
    await executeOrder(order.id, f.adapter);
    expect(f.client.get).not.toHaveBeenCalled();
});
test('UUID recovery remains on the original provider when the product is relinked', async () => {
    const f = await fixture(); const order = await paidOrder(f);
    const other = await Provider.create({ name: 'Other', slug: 'mock', baseUrl: 'https://example.invalid', isActive: true });
    const otherProduct = await ProviderProduct.create({ provider: other.id, externalProductId: '365', rawName: 'Other', rawPrice: '9' });
    await Product.findByIdAndUpdate(f.product.id, { provider: other.id, providerProduct: otherProduct.id });
    await Order.findByIdAndUpdate(order.id, { providerStatus: 'PLACEMENT_UNCERTAIN' });
    f.client.get.mockResolvedValue({ data: [{ id: 'ID_original', order_uuid: order.providerOrderUuid, status: 'accept' }] });
    await pollPendingOrders({ adapterOverrides: { [f.provider.id]: f.adapter } });
    expect(await Order.findById(order.id)).toMatchObject({ status: 'COMPLETED', providerOrderId: 'ID_original' });
    expect(f.client.get.mock.calls.at(-1)[1].params.uuid).toBe(1);
});
test.each(['/api/providers', '/api/admin/providers'])('HTTP CRUD never exposes credential via %s', async (path) => {
    const { createAdmin } = require('./testHelpers');
    const admin = await createAdmin();
    const jwt = require('jsonwebtoken');
    const server = require('../app').listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: admin.id }, process.env.JWT_SECRET)}` };
    const call = async (suffix = '', method = 'GET', body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}${suffix}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const json = await response.json();
        expect(JSON.stringify(json)).not.toContain(providerData.apiToken);
        expect(response.status).toBeLessThan(400);
        return json;
    };
    try {
        const created = await call('', 'POST', providerData);
        const dto = created.data.provider || created.data;
        const id = dto._id;
        expect(dto.hasApiToken).toBe(true);
        await call(); await call(`/${id}`); await call(`/${id}`, 'PATCH', { apiToken: '', syncInterval: 0 });
        expect((await Provider.findById(id)).apiToken).toBe(providerData.apiToken);
        await call(`/${id}`, 'DELETE');
    } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('fulfillment mapping cannot overwrite UUID, external ID or quantity', async () => {
    const f = await fixture();
    await Product.findByIdAndUpdate(f.product.id, { providerMapping: { account: 'playerId', attack: 'order_uuid', requested: 'qty' } });
    const { order } = await createOrder({ userId: f.customer.id, productId: f.product.id, quantity: 1,
        orderFieldsValues: { account: 'player', attack: 'not-a-uuid', requested: 999, referenceId: 'internal-attack' } });
    await Order.findByIdAndUpdate(order.id, { status: 'PROCESSING', executionType: 'automatic' });
    f.client.get.mockClear().mockResolvedValue({ data: { order: { id: 'ID_a', status: 'wait' } } });
    await executeOrder(order.id, f.adapter);
    expect(f.client.get.mock.calls[0]).toEqual(['/client/api/newOrder/365/params', { params: { playerId: 'player', qty: 1, order_uuid: order.providerOrderUuid }, maxRedirects: 0 }]);
});

test('Maya catalog failure does not stop another supplier sync', async () => {
    const f = await fixture(); await Provider.findByIdAndUpdate(f.provider.id, { syncInterval: 1 });
    const other = await Provider.create({ name: 'Other mock', slug: 'mock', baseUrl: 'https://example.invalid' });
    f.client.get.mockRejectedValue(new Error('timeout'));
    const results = await syncAllProviders({ httpClient: f.client, products: [{ externalProductId: '365', rawName: 'Other product', rawPrice: '8' }] });
    expect(results.find((result) => result.providerId.equals(f.provider._id)).error).toBe('[MayaCard] Request failed');
    expect(results.find((result) => result.providerId.equals(other._id)).result.totalFetched).toBe(1);
    expect((await ProviderProduct.findOne({ provider: other.id })).rawPrice).toBe('8');
});

test.each([['completed', 'COMPLETED', 99], ['rejected', 'FAILED', 100]])('admin manually sets Maya order to %s and later polling leaves the decision intact', async (target, expected, balance) => {
    const f = await fixture(); const order = await paidOrder(f);
    const { createAdmin } = require('./testHelpers'); const admin = await createAdmin();
    const server = require('../app').listen(0); await new Promise((resolve) => server.once('listening', resolve));
    const token = require('jsonwebtoken').sign({ id: admin.id }, process.env.JWT_SECRET);
    f.client.get.mockClear();
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/orders/${order.id}/status`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: target, rejectionReason: 'Manual Maya decision' }),
        });
        expect(response.status).toBe(200);
        expect((await Order.findById(order.id)).status).toBe(expected);
        await pollProcessingOrders(f.adapter);
        expect((await Order.findById(order.id)).status).toBe(expected);
        expect((await freshUser(f.customer.id)).walletBalance).toBe(balance);
        expect(f.client.get).not.toHaveBeenCalled();
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
test('admin resumes review without purchasing and the scheduled five-minute job recovers Maya automatically', async () => {
    const f = await fixture(); const order = await paidOrder(f);
    await Order.findByIdAndUpdate(order.id, { status: 'MANUAL_REVIEW', providerStatus: 'PLACEMENT_UNCERTAIN', providerSaleAttemptedAt: new Date(), retryCount: MAX_RETRY_COUNT });
    const { updateOrderStatus } = require('../modules/admin/admin.orders.service');
    expect(await updateOrderStatus(order.id, 'processing', f.customer.id)).toMatchObject({ status: 'PROCESSING', retryCount: 0, providerOrderUuid: order.providerOrderUuid });
    f.client.get.mockClear().mockResolvedValue({ data: [{ id: 'ID_cron', order_uuid: order.providerOrderUuid, status: 'accept', code: 'AUTO_DELIVERY' }] });
    const job = require('../modules/orders/fulfillmentJob'); const cron = require('node-cron');
    let tick; const scheduled = { stop: jest.fn() };
    jest.spyOn(cron, 'schedule').mockImplementation((schedule, callback) => { expect(schedule).toBe('*/5 * * * *'); tick = callback; return scheduled; });
    const originalEnv = process.env.NODE_ENV;
    try { process.env.NODE_ENV = 'development'; job.start(undefined, f.adapter); } finally { process.env.NODE_ENV = originalEnv; }
    try {
        await tick();
        expect(await Order.findById(order.id)).toMatchObject({ status: 'COMPLETED', providerOrderId: 'ID_cron', providerRawResponse: { code: 'AUTO_DELIVERY' } });
        expect(f.client.get.mock.calls.every(([url]) => url === '/client/api/check')).toBe(true);
        expect(await countTransactions(f.customer.id)).toBe(1);
    } finally { job.stop(); }
});

test('the existing admin retry action resumes Maya lookup with the same UUID', async () => {
    const f = await fixture(); const order = await paidOrder(f);
    await Order.findByIdAndUpdate(order.id, { status: 'MANUAL_REVIEW', providerStatus: 'PLACEMENT_UNCERTAIN', providerSaleAttemptedAt: new Date(), retryCount: MAX_RETRY_COUNT });
    f.client.get.mockClear();
    const { retryOrder } = require('../modules/admin/admin.orders.service');
    expect(await retryOrder(order.id, f.customer.id)).toMatchObject({ status: 'PROCESSING', retryCount: 0, providerOrderUuid: order.providerOrderUuid });
    expect(f.client.get).not.toHaveBeenCalled();
    expect(await countTransactions(f.customer.id)).toBe(1);
});

describe.each(['creation timeout', 'fulfillment poller', 'order status poller'])('UUID recovery through %s', (path) => {
    test.each([
        ['single result without UUID', () => [{ id: 'ID_recovered', status: 'accept', code: 'DELIVERED_CODE' }], true],
        ['single result with matching UUID', (uuid) => [{ id: 'ID_recovered', order_uuid: uuid, status: 'accept', code: 'DELIVERED_CODE' }], true],
        ['mismatching UUID', () => [{ id: 'ID_recovered', order_uuid: randomUUID(), status: 'accept' }], false],
        ['multiple results including matching UUID', (uuid) => [{ id: 'ID_recovered', order_uuid: uuid, status: 'accept' }, { id: 'ID_other', status: 'accept' }], false],
        ['missing supplier ID', () => [{ status: 'accept' }], false],
        ['invalid supplier ID', () => [{ id: true, status: 'accept' }], false],
    ])('%s', async (_label, items, recovered) => {
        const f = await fixture();
        const order = await paidOrder(f);
        const uuid = order.providerOrderUuid;
        const response = { data: { orders: items(uuid) } };
        f.client.get.mockClear();
        if (path === 'creation timeout') {
            f.client.get.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(response);
            await executeOrder(order.id, f.adapter);
            // Re-entering fulfillment cannot issue a second purchase.
            await executeOrder(order.id, new MayaCardAdapter(f.provider, { httpClient: f.client }));
            expect(f.client.get.mock.calls.filter(([url]) => url.includes('/newOrder/'))).toHaveLength(1);
        } else {
            await Order.findByIdAndUpdate(order.id, { providerStatus: 'PLACEMENT_UNCERTAIN', providerSaleAttemptedAt: new Date() });
            // Relinking a product must not change the original account used for recovery.
            const other = await Provider.create({ name: 'Other recovery provider', slug: 'mock', baseUrl: 'https://example.invalid' });
            const otherProduct = await ProviderProduct.create({ provider: other.id, externalProductId: '365', rawName: 'Other', rawPrice: '9' });
            await Product.findByIdAndUpdate(f.product.id, { provider: other.id, providerProduct: otherProduct.id });
            f.client.get.mockResolvedValue(response);
            const create = jest.spyOn(require('axios'), 'create').mockReturnValue(f.client);
            if (path === 'fulfillment poller') await pollProcessingOrders();
            else await pollPendingOrders();
            expect(create).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://maya-card.com', headers: expect.objectContaining({ 'api-token': providerData.apiToken }) }));
            expect(f.client.get.mock.calls.every(([url]) => url === '/client/api/check')).toBe(true);
        }
        const saved = await Order.findById(order.id);
        expect(saved.providerOrderUuid).toBe(uuid);
        expect(String(saved.mayaProviderId)).toBe(f.provider.id);
        expect(saved.refunded).toBe(false);
        if (recovered) {
            expect(saved).toMatchObject({ status: 'COMPLETED', providerOrderId: 'ID_recovered', providerRawResponse: { code: 'DELIVERED_CODE' } });
        } else {
            expect(saved).toMatchObject({ status: 'PROCESSING', providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN' });
        }
        const checks = f.client.get.mock.calls.filter(([url]) => url === '/client/api/check');
        expect(checks).toHaveLength(1);
        expect(checks[0][1].params).toEqual({ orders: JSON.stringify([uuid]), uuid: 1 });
        expect((await freshUser(f.customer.id)).walletBalance).toBe(99);
        expect(await countTransactions(f.customer.id)).toBe(1);
    });
});
