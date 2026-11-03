'use strict';

jest.mock('axios');
const axios = require('axios');
const { CoinRechargeAdapter } = require('../modules/providers/adapters/coinRecharge.adapter');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { Provider } = require('../modules/providers/provider.model');

const provider = {
    isActive: true, name: 'Coin Recharge', slug: 'coin-recharge', baseUrl: 'https://supplier.example', apiToken: 'test-secret',
    coinRechargeConfig: { product: { name: 'Coins', unitPrice: '0.02', minCoins: 10, maxCoins: 100000, isActive: true } },
};

const makeClient = () => ({ get: jest.fn(), post: jest.fn() });
const makeAdapter = () => {
    const http = makeClient();
    axios.create.mockReturnValueOnce(http);
    return { adapter: new CoinRechargeAdapter(provider), http };
};

beforeEach(() => jest.clearAllMocks());

describe('CoinRechargeAdapter', () => {
    it('is registered strictly and exposes one deterministic synthetic product', async () => {
        expect(getProviderAdapter(provider, { strict: true })).toBeInstanceOf(CoinRechargeAdapter);
        const { adapter } = makeAdapter();
        await expect(adapter.getProducts()).resolves.toEqual([expect.objectContaining({ externalProductId: 'coin-recharge-dynamic', rawPrice: '0.02', minQty: 10, maxQty: 100000, isActive: true })]);
    });

    it('uses query parameters for balance, verification, and exactly one sale POST', async () => {
        const { adapter, http } = makeAdapter();
        http.get.mockResolvedValueOnce({ status: 200, data: { code: 200, data: { coinBalance: 7145989 } } });
        await expect(adapter.getBalance()).resolves.toMatchObject({ balance: '7145989', unit: 'coins', currency: null });
        expect(http.get).toHaveBeenCalledWith('/dealer/account', { params: { secretKey: 'test-secret' } });

        http.get.mockResolvedValueOnce({ status: 200, data: { code: 200, data: { userId: 2222, nickName: 'safe', avatar: 'https://img.example/a.png' } } });
        await expect(adapter.verifyTargetUser({ targetUid: '2222' })).resolves.toEqual({ valid: true, user: { userId: '2222', nickName: 'safe', avatar: 'https://img.example/a.png' } });

        http.post.mockResolvedValueOnce({ status: 200, data: { code: 200, message: 'Success' } });
        await expect(adapter.placeOrder({ toUserId: '2222', quantity: 100 })).resolves.toMatchObject({ success: true, providerStatus: 'Completed', providerOrderId: null });
        expect(http.post).toHaveBeenCalledTimes(1);
        expect(http.post).toHaveBeenCalledWith('/dealer/sale', null, { params: { secretKey: 'test-secret', toUserId: '2222', coins: 100 } });
    });

    it('accepts precision-safe equivalent supplier user IDs without Number coercion', async () => {
        const { adapter, http } = makeAdapter();
        const targetUid = '00123456789012345678901234567890';
        http.get.mockResolvedValueOnce({ status: 200, data: { code: 200, data: { userId: '123456789012345678901234567890', nickName: 'safe' } } });
        await expect(adapter.verifyTargetUser({ targetUid })).resolves.toMatchObject({ valid: true, user: { userId: '123456789012345678901234567890' } });
    });

    it('rejects a supplier response for a different user ID', async () => {
        const { adapter, http } = makeAdapter();
        http.get.mockResolvedValueOnce({ status: 200, data: { code: 200, data: { userId: '124', nickName: 'wrong account' } } });
        await expect(adapter.verifyTargetUser({ targetUid: '123' })).rejects.toMatchObject({ code: 'COIN_RECHARGE_TARGET_MISMATCH' });
    });

    it.each([
        ['timeout', Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })],
        ['connection reset', Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
        ['HTTP 5xx', Object.assign(new Error('upstream error'), { response: { status: 503 } })],
    ])('moves %s to an indeterminate result without retrying', async (_name, error) => {
        const { adapter, http } = makeAdapter();
        http.post.mockRejectedValueOnce(error);
        const result = await adapter.placeOrder({ toUserId: '2222', quantity: 100 });
        expect(result).toMatchObject({ success: false, requiresManualReview: true, outcomeUncertain: true, providerOrderId: null });
        expect(http.post).toHaveBeenCalledTimes(1);
    });

    it.each([131, 132, 133, 134, 135, 136, 137, 138, 400])('treats documented sale code %i as indeterminate after an attempt', async (code) => {
        const { adapter, http } = makeAdapter();
        http.post.mockResolvedValueOnce({ status: 200, data: { code, message: 'supplier response' } });
        await expect(adapter.placeOrder({ toUserId: '2222', quantity: 100 })).resolves.toMatchObject({ requiresManualReview: true, outcomeUncertain: true, errorCode: String(code) });
    });

    it('supports AD field verification and rejects inactive suppliers', async () => {
        const { adapter, http } = makeAdapter();
        http.get.mockResolvedValueOnce({ status: 200, data: { code: 200, data: { userId: '123', nickName: 'User' } } });
        await expect(adapter.validateUser('123')).resolves.toMatchObject({ uid: '123', nickName: 'User' });
        adapter.provider = { ...provider, isActive: false };
        await expect(adapter.validateUser('123')).rejects.toMatchObject({ code: 'PROVIDER_INACTIVE' });
    });
});
