'use strict';

jest.mock('../services/pushDelivery.service', () => ({
    dispatchPushForNotification: jest.fn().mockResolvedValue({ sent: 1 }),
    dispatchBroadcastPush: jest.fn().mockResolvedValue({ sent: 1 }),
}));

const { Notification } = require('../modules/notifications/notification.model');
const notificationService = require('../modules/notifications/notification.service');
const pushDelivery = require('../services/pushDelivery.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    jest.clearAllMocks();
});

describe('notification persistence with push dispatch', () => {
    it('persists a single-user notification even when asynchronous push delivery fails', async () => {
        pushDelivery.dispatchPushForNotification.mockRejectedValueOnce(new Error('FCM unavailable'));
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });

        await notificationService.notifyUser({ userId: user._id, title: 'Title', message: 'Body', link: '/orders' });
        expect(await Notification.countDocuments({ userId: user._id })).toBe(1);
        expect(pushDelivery.dispatchPushForNotification).toHaveBeenCalledTimes(1);
    });

    it('dispatches persisted operational, group, and manual notification recipients', async () => {
        const group = await createGroup();
        const customer = await createCustomer({ groupId: group._id });
        await createAdmin({ groupId: group._id });

        await notificationService.notifyNewDeposit({
            userId: { name: customer.name },
            userNameSnapshot: customer.name,
            requestedAmount: 10,
            currency: 'USD',
        });
        const groupNotifications = await notificationService.notifyGroup(group._id, {
            title: 'Group', message: 'Message', link: '/orders',
        });
        await notificationService.adminSendNotification({
            userId: customer._id,
            title: 'Manual', message: 'Message', link: '/orders',
        });

        expect(groupNotifications).toHaveLength(2);
        expect(pushDelivery.dispatchPushForNotification.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('keeps a broadcast as one inbox document while dispatching a broadcast push', async () => {
        const result = await notificationService.adminSendNotification({
            broadcast: true,
            title: 'Broadcast',
            message: 'Message',
            link: '/dashboard',
        });

        expect(result.sent).toBe(1);
        expect(await Notification.countDocuments({ scope: 'BROADCAST' })).toBe(1);
        expect(pushDelivery.dispatchBroadcastPush).toHaveBeenCalledTimes(1);
    });
});
