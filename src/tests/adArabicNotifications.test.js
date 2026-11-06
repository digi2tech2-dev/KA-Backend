'use strict';
jest.mock('../services/pushDelivery.service', () => ({ dispatchPushForNotification: jest.fn(), dispatchBroadcastPush: jest.fn() }));
const mongoose = require('mongoose');
const { connectTestDB, disconnectTestDB, clearCollections, createAdmin, createCustomerWithGroup } = require('./testHelpers');
const { DepositRequest } = require('../modules/deposits/deposit.model');
const { Notification } = require('../modules/notifications/notification.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const whatsapp = require('../modules/whatsapp/whatsapp.service');
const notifications = require('../modules/notifications/notification.service');
const deposits = require('../modules/deposits/deposit.service');
const walletAdmin = require('../modules/admin/admin.wallet.service');
let send;
const waitFor = async (predicate) => { for (let i = 0; i < 40; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error('Notification was not produced'); };
beforeAll(async () => { await connectTestDB(); send = jest.spyOn(whatsapp, 'sendAdminNotification').mockResolvedValue({}); });
afterAll(async () => { send.mockRestore(); await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); send.mockClear(); });

test('deposit approval reports credited amount and exact post-credit balance without sending WhatsApp', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup({ name: 'Test Customer', walletBalance: 10, currency: 'USD' });
    const deposit = await DepositRequest.create({ userId: customer._id, paymentMethodId: new mongoose.Types.ObjectId(), requestedAmount: 20,
        currency: 'USD', exchangeRate: 1, amountUsd: 20, receiptImage: 'uploads/deposits/test.jpg' });
    await deposits.approveDeposit(deposit._id, admin._id);
    await waitFor(async () => send.mock.calls.length && await Notification.exists({ userId: customer._id, source: 'DEPOSIT' }));
    const message = send.mock.calls[0][0];
    expect(message).toContain('تم قبول طلب إضافة الرصيد');
    expect(message).toContain('Test Customer');
    expect(message).toContain('المبلغ المضاف للمحفظة: 20 USD');
    expect(message).toContain('الرصيد بعد العملية: 30 USD');
    const note = await Notification.findOne({ userId: customer._id, source: 'DEPOSIT' }).lean();
    expect(note.message).toContain('رصيدك بعد الإضافة: 30 USD');
    expect((await WalletTransaction.findOne({ reference: deposit._id }).lean()).balanceAfter).toBe(30);
});

test('failed orders report refund only when a wallet transaction proves it', async () => {
    const { customer } = await createCustomerWithGroup({ walletBalance: 50, currency: 'USD' });
    const order = { _id: new mongoose.Types.ObjectId(), userId: customer._id, orderNumber: 'TEST123', chargedAmount: 10, currency: 'USD' };
    await notifications.notifyOrderFailed(order);
    let note = await Notification.findOne({ userId: customer._id }).lean();
    expect(note.message).toContain('يرجى مراجعة حالة الاسترداد');
    await WalletTransaction.create({ userId: customer._id, reference: order._id, type: 'REFUND', amount: 10, balanceBefore: 40, balanceAfter: 50 });
    await notifications.notifyOrderFailed(order);
    await waitFor(() => send.mock.calls.length >= 2);
    note = await Notification.findOne({ userId: customer._id }).sort({ createdAt: -1 }).lean();
    expect(note.message).toContain('تم تسجيل استرداد 10 USD');
    expect(send.mock.calls[1][0]).toContain('الرصيد بعد العملية: 50 USD');
});

test('manual wallet credit creates Arabic notice and admin message', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup({ walletBalance: 5, currency: 'USD' });
    await walletAdmin.addFunds(customer._id, 12, 'test', admin._id);
    await waitFor(async () => send.mock.calls.length && await Notification.exists({ userId: customer._id }));
    expect(send.mock.calls[0][0]).toContain('الرصيد بعد العملية: 17 USD');
    expect((await Notification.findOne({ userId: customer._id }).lean()).message).toContain('تمت إضافة 12 USD');
});

test('rejection and completion notifications are Arabic', async () => {
    const { customer } = await createCustomerWithGroup();
    await notifications.notifyDepositRejected({ _id: new mongoose.Types.ObjectId(), userId: customer._id, requestedAmount: 5, currency: 'USD' }, 'إيصال غير واضح');
    await notifications.notifyOrderCompleted({ _id: new mongoose.Types.ObjectId(), userId: customer._id, orderNumber: 'XYZ' });
    await waitFor(() => send.mock.calls.length >= 2);
    const notes = await Notification.find({ userId: customer._id }).lean();
    expect(notes.some((n) => n.message.includes('إيصال غير واضح'))).toBe(true);
    expect(notes.some((n) => n.message.includes('تم شحن طلبك'))).toBe(true);
});

test('unavailable WhatsApp does not prevent the customer notification', async () => {
    const { customer } = await createCustomerWithGroup();
    send.mockRejectedValueOnce(new Error('disconnected'));
    await notifications.notifyOrderCompleted({ _id: new mongoose.Types.ObjectId(), userId: customer._id, orderNumber: 'XYZ' });
    await waitFor(() => send.mock.calls.length > 0);
    expect(await Notification.exists({ userId: customer._id, source: 'ORDER' })).toBeTruthy();
});
