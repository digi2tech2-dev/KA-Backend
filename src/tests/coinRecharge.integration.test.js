'use strict';

process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/coin-test-not-connected';
process.env.JWT_SECRET = 'coin-recharge-test-only-secret';

jest.mock('../modules/notifications/notification.service', () => ({
    notifyOrderCompleted: jest.fn(), notifyOrderFailed: jest.fn(),
}));
jest.mock('../modules/audit/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('../modules/wallet/wallet.service', () => ({ refundWalletAtomic: jest.fn() }));

const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { Provider } = require('../modules/providers/provider.model');
const { Product } = require('../modules/products/product.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { refundWalletAtomic } = require('../modules/wallet/wallet.service');
const { executeOrder, pollProcessingOrders } = require('../modules/orders/orderFulfillment.service');
const { mergeCoinRechargeProductBehavior, verifyTargetForProduct } = require('../modules/providers/coinRecharge.service');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { CoinRechargeAdapter } = require('../modules/providers/adapters/coinRecharge.adapter');
const adminOrders = require('../modules/admin/admin.orders.service');
const mongoose = require('mongoose');

const query = (value) => {
    const result = Promise.resolve(value);
    result.populate = result.select = result.lean = result.sort = result.limit = result.session = () => result;
    return result;
};

let order;
beforeEach(() => {
    order = {
        _id: 'coin-order', userId: 'customer', productId: { _id: 'product', providerMapping: { target_uid: 'toUserId' } },
        providerCode: 'coin-recharge', status: ORDER_STATUS.PROCESSING, quantity: 100,
        customerInput: { values: { target_uid: '123' } }, providerSaleAttemptedAt: null,
    };
    jest.spyOn(Order, 'findById').mockImplementation(() => query({ ...order }));
    jest.spyOn(ProviderProduct, 'findOne').mockImplementation(() => query(null));
    jest.spyOn(Product, 'findById').mockImplementation(() => query(null));
    jest.spyOn(Order, 'findByIdAndUpdate').mockImplementation((_id, update) => {
        Object.assign(order, update.$set);
        return query({ ...order });
    });
    jest.spyOn(Order, 'findOneAndUpdate').mockImplementation((filter, update) => {
        if (Object.hasOwn(filter, 'providerSaleAttemptedAt') && order.providerSaleAttemptedAt) return query(null);
        if (filter.status && order.status !== filter.status) return query(null);
        Object.assign(order, update.$set);
        return query({ ...order });
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

describe('Coin recharge fulfillment in AD', () => {
    it('completes a confirmed sale once and maps the target to AD provider parameters', async () => {
        const adapter = { placeOrder: jest.fn().mockResolvedValue({ success: true, providerStatus: 'Completed', providerOrderId: null }) };
        expect((await executeOrder(order._id, adapter)).placed).toBe(true);
        expect(order.status).toBe(ORDER_STATUS.COMPLETED);
        await executeOrder(order._id, adapter);
        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
        expect(adapter.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ toUserId: '123', quantity: 100 }));
        expect(refundWalletAtomic).not.toHaveBeenCalled();
    });

    it.each([
        { success: false, outcomeUncertain: true, errorCode: 'ECONNRESET' },
        { success: true, providerStatus: 'Pending' },
        null,
    ])('holds ambiguous supplier responses for manual review without refunding', async (result) => {
        const adapter = { placeOrder: jest.fn().mockResolvedValue(result) };
        await expect(executeOrder(order._id, adapter)).resolves.toMatchObject({ manualReview: true, refunded: false });
        expect(order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(order.providerOutcome).toBe('uncertain');
        expect(refundWalletAtomic).not.toHaveBeenCalled();
    });

    it('does not replay an existing attempt even if provider resolution would now fail', async () => {
        order.providerSaleAttemptedAt = new Date();
        const resolve = jest.spyOn(Provider, 'findById').mockRejectedValue(new Error('inactive supplier'));
        await expect(executeOrder(order._id)).resolves.toMatchObject({ placed: false, refunded: false });
        expect(resolve).not.toHaveBeenCalled();
        expect(Order.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('allows only the atomic claim winner to send a sale', async () => {
        const adapter = { placeOrder: jest.fn().mockResolvedValue({ success: true, providerStatus: 'Completed' }) };
        await Promise.all([executeOrder(order._id, adapter), executeOrder(order._id, adapter)]);
        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    });

    it('handles unexpected adapter throws as manual review without refund', async () => {
        const adapter = { placeOrder: jest.fn().mockRejectedValue(new Error('connection closed')) };
        await expect(executeOrder(order._id, adapter)).resolves.toMatchObject({ manualReview: true, refunded: false });
        expect(order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(refundWalletAtomic).not.toHaveBeenCalled();
    });

    it('keeps a confirmed sale in manual review if saving completion fails', async () => {
        Order.findByIdAndUpdate.mockRejectedValueOnce(new Error('database unavailable'));
        const adapter = { placeOrder: jest.fn().mockResolvedValue({ success: true, providerStatus: 'Completed' }) };
        await expect(executeOrder(order._id, adapter)).resolves.toMatchObject({ manualReview: true, refunded: false });
        expect(order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(refundWalletAtomic).not.toHaveBeenCalled();
    });

    it('recovers interrupted attempts through local manual review without polling the supplier', async () => {
        jest.spyOn(Order, 'updateMany').mockResolvedValue({ modifiedCount: 1 });
        jest.spyOn(Order, 'find').mockImplementation(() => query([]));
        const adapter = { checkOrder: jest.fn(), placeOrder: jest.fn() };
        await expect(pollProcessingOrders(adapter)).resolves.toMatchObject({ manualReview: 1 });
        expect(Order.find).toHaveBeenCalledWith(expect.objectContaining({ providerCode: { $ne: 'coin-recharge' } }));
        expect(adapter.checkOrder).not.toHaveBeenCalled();
        expect(adapter.placeOrder).not.toHaveBeenCalled();
    });
});

describe('AD product and provider compatibility', () => {
    it('selects coin recharge by explicit adapterType with a custom supplier slug', () => {
        expect(getProviderAdapter({ adapterType: 'coin-recharge', slug: 'custom-coins', baseUrl: 'https://supplier.example' }, { strict: true })).toBeInstanceOf(CoinRechargeAdapter);
    });

    it('persists the synthetic config and AD verifiable field and mapping', () => {
        const provider = new Provider({ name: 'Coins', baseUrl: 'https://supplier.example', coinRechargeConfig: { product: { unitPrice: '0.00001', minCoins: 1, maxCoins: 1000, isActive: true } } });
        expect(provider.validateSync()).toBeUndefined();
        expect(provider.coinRechargeConfig.product.unitPrice).toBe('0.00001');
        const data = { name: 'Coins', basePrice: '0.01', minQty: 1, maxQty: 1000 };
        mergeCoinRechargeProductBehavior(data);
        const product = new Product(data);
        expect(product.validateSync()).toBeUndefined();
        expect(product.orderFields[0]).toMatchObject({ key: 'target_uid', isVerifiable: true });
        expect(product.executionType).toBe('automatic');
        expect(product.providerMapping.get('target_uid')).toBe('toUserId');
    });

    it('rejects disabled coin products and out-of-range quantities before supplier verification', async () => {
        const provider = { isActive: true, coinRechargeConfig: { product: { isActive: false } } };
        await expect(verifyTargetForProduct({ provider, targetUid: '123' })).rejects.toMatchObject({ code: 'COIN_RECHARGE_PRODUCT_INACTIVE' });
        provider.coinRechargeConfig.product = { isActive: true, minCoins: 10, maxCoins: 100 };
        await expect(verifyTargetForProduct({ provider, targetUid: '123', quantity: 101 })).rejects.toMatchObject({ code: 'INVALID_COIN_RECHARGE_QUANTITY' });
    });
});

describe('Coin recharge admin resolution', () => {
    beforeEach(() => { order.status = ORDER_STATUS.MANUAL_REVIEW; });

    it('records confirmed delivery once without sending a sale or refund', async () => {
        await expect(adminOrders.resolveCoinRechargeManualReview(order._id, 'admin', { resolution: 'delivered', reason: 'Verified with supplier' })).resolves.toMatchObject({ status: ORDER_STATUS.COMPLETED });
        await expect(adminOrders.resolveCoinRechargeManualReview(order._id, 'admin', { resolution: 'delivered', reason: 'Verified with supplier' })).rejects.toMatchObject({ code: 'COIN_RECHARGE_MANUAL_REVIEW_ALREADY_RESOLVED' });
        expect(refundWalletAtomic).not.toHaveBeenCalled();
    });

    it.each(['completeOrder', 'refundOrder', 'retryOrder', 'syncOrderProviderStatus'])('blocks generic %s for an uncertain sale', async (method) => {
        await expect(adminOrders[method](order._id, 'admin')).rejects.toMatchObject({ code: 'COIN_RECHARGE_MANUAL_REVIEW_REQUIRES_RESOLUTION' });
    });

    it('blocks generic status updates and rejects missing evidence', async () => {
        await expect(adminOrders.updateOrderStatus(order._id, 'completed', 'admin')).rejects.toMatchObject({ code: 'COIN_RECHARGE_MANUAL_REVIEW_REQUIRES_RESOLUTION' });
        await expect(adminOrders.resolveCoinRechargeManualReview(order._id, 'admin', { resolution: 'refund', reason: '' })).rejects.toMatchObject({ code: 'MANUAL_REVIEW_REASON_REQUIRED' });
    });

    it.each(['markOrderAsFailed', 'processOrderRefund', 'markOrderAsCompleted'])('blocks legacy order route %s from bypassing review', async (method) => {
        const session = { startTransaction: jest.fn(), abortTransaction: jest.fn(), endSession: jest.fn(), inTransaction: () => true };
        jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
        const service = require('../modules/orders/order.service');
        await expect(service[method](order._id)).rejects.toMatchObject({ code: 'COIN_RECHARGE_MANUAL_REVIEW_REQUIRES_RESOLUTION' });
    });

    it('restores manual review if the database session cannot start for a refund', async () => {
        Object.assign(order, { walletDeducted: 100, chargedAmount: 100, refunded: false });
        jest.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('session unavailable'));
        await expect(adminOrders.resolveCoinRechargeManualReview(order._id, 'admin', { resolution: 'refund', reason: 'Supplier checked' })).rejects.toThrow('session unavailable');
        expect(order.refunded).toBe(false);
        expect(order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
    });

    it.each([false, true])('resolves a refund safely when wallet failure is %s', async (fail) => {
        Object.assign(order, { walletDeducted: 100, chargedAmount: 100, refunded: false });
        const session = { startTransaction: jest.fn(), commitTransaction: jest.fn(), abortTransaction: jest.fn(), endSession: jest.fn(), inTransaction: () => true };
        jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
        if (fail) refundWalletAtomic.mockRejectedValueOnce(new Error('wallet write failed'));
        else refundWalletAtomic.mockResolvedValueOnce({});
        const resolution = adminOrders.resolveCoinRechargeManualReview(order._id, 'admin', { resolution: 'refund', reason: 'Supplier confirmed no delivery' });
        if (fail) {
            await expect(resolution).rejects.toThrow('wallet write failed');
            expect(order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
            expect(order.refunded).toBe(false);
        } else {
            await expect(resolution).resolves.toMatchObject({ status: ORDER_STATUS.FAILED, refunded: true });
            expect(refundWalletAtomic).toHaveBeenCalledWith(expect.objectContaining({ walletDeducted: 100, reference: order._id }));
        }
    });
});
