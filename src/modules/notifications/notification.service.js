'use strict';

/**
 * notification.service.js
 *
 * Core notification business logic.
 *
 * DESIGN PRINCIPLE — FIRE-AND-FORGET SAFETY:
 *   All public "notify*" methods are designed to be called without `await`
 *   (fire-and-forget). They catch their own errors and log them, ensuring
 *   that a notification failure NEVER crashes the parent transaction.
 *
 *   Example:
 *     notifyUser({ ... });         // ← no await, no .catch() needed
 *     notifyDepositApproved(dep);  // ← same — fully self-contained
 *
 * Service operations:
 *   ─ Low-level ─
 *   notifyUser()               — create a single user notification (safe)
 *   notifyBroadcast()          — create a broadcast notification (safe)
 *   notifyGroup()              — create notifications for all users in a group (safe)
 *
 *   ─ Business triggers ─
 *   notifyAccountApproved()    — user account approved
 *   notifyDepositApproved()    — deposit approved
 *   notifyDepositRejected()    — deposit rejected
 *   notifyTargetApproved()     — target order approved
 *   notifyTargetRejected()     — target order rejected
 *   notifyOrderCompleted()     — product order completed
 *   notifyOrderFailed()        — product order failed / refunded
 *
 *   ─ CRUD for endpoints ─
 *   getMyNotifications()       — paginated inbox (user + broadcasts)
 *   markAsRead()               — mark one notification as read
 *   markAllAsRead()            — mark all unread as read
 *   getUnreadCount()           — badge counter
 *   listAllNotifications()     — admin: paginated system-wide list
 *   adminSendNotification()    — admin: manual send (single / group / broadcast)
 */

const { Notification, NOTIFICATION_TYPE, NOTIFICATION_SCOPE } = require('./notification.model');
const { User } = require('../users/user.model');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { dispatchPushForNotification, dispatchBroadcastPush } = require('../../services/pushDelivery.service');
const whatsappService = require('../whatsapp/whatsapp.service');
const { WalletTransaction } = require('../wallet/walletTransaction.model');
const { Product } = require('../products/product.model');

const dispatchUserPushSafely = (notification) => {
    Promise.resolve(dispatchPushForNotification(notification)).catch((err) => {
        console.warn('[Notification] user push failed:', err.message);
    });
};

const dispatchBroadcastPushSafely = (notification) => {
    Promise.resolve(dispatchBroadcastPush(notification)).catch((err) => {
        console.warn('[Notification] broadcast push failed:', err.message);
    });
};

// =============================================================================
// INTERNAL SAFE WRAPPER
// =============================================================================

/**
 * Wraps an async operation so it NEVER throws.
 * Logs errors to stderr with a [Notification] prefix.
 * Returns null on failure.
 * @private
 */
const _safe = (label, fn) => {
    try {
        const result = fn();
        if (result && typeof result.catch === 'function') {
            result.catch((err) => {
                console.error(`[Notification] ${label} failed:`, err.message);
            });
        }
        return result;
    } catch (err) {
        console.error(`[Notification] ${label} sync error:`, err.message);
        return null;
    }
};

// Admin WhatsApp messages are best-effort and never affect financial commits.
const notifyAdminEvent = (event, record, details = {}) => _safe('admin WhatsApp', async () => {
    if (!record) return;
    const userId = record.userId?._id || record.userId;
    const user = userId ? await User.findById(userId).select('name email currency walletBalance').lean() : null;
    const lines = [`*${event}*`, `العميل: ${user?.name || record.userId?.name || 'غير متاح'}`,
        `معرّف العميل: ${userId || 'غير متاح'}`];
    if (user?.email) lines.push(`البريد: ${user.email}`);
    if (record.orderNumber || record._id) lines.push(`رقم العملية: ${record.orderNumber || record._id}`);
    if (record.productId) {
        const product = await Product.findById(record.productId?._id || record.productId).select('name').lean();
        if (product?.name) lines.push(`المنتج: ${typeof product.name === 'string' ? product.name : product.name.ar || product.name.en || ''}`);
    }
    if (record.appNameSnapshot) lines.push(`التطبيق: ${record.appNameSnapshot}`);
    if (record.quantity != null) lines.push(`الكمية: ${record.quantity}`);
    if (record.coinAmount != null) lines.push(`عدد العملات: ${record.coinAmount}`);
    if (record.requestedAmount != null) lines.push(`مبلغ التحويل: ${record.requestedAmount} ${record.currency || ''}`);
    else if (record.chargedAmount != null) lines.push(`مبلغ الطلب: ${record.chargedAmount} ${record.currency || ''}`);
    else if (record.totalPrice != null) lines.push(`المبلغ: ${record.totalPrice} ${record.currency || ''}`);
    if (details.creditedAmount != null) lines.push(`المبلغ المضاف للمحفظة: ${details.creditedAmount} ${details.walletCurrency || ''}`);
    if (details.balanceAfter != null) lines.push(`الرصيد بعد العملية: ${details.balanceAfter} ${details.walletCurrency || ''}`);
    else if (user?.walletBalance != null) lines.push(`الرصيد الحالي وقت الإشعار: ${user.walletBalance} ${user.currency || ''}`);
    if (details.refundAmount != null) lines.push(`المبلغ المسترد: ${details.refundAmount} ${record.currency || ''}`);
    if (details.reason) lines.push(`السبب: ${details.reason}`);
    await whatsappService.sendAdminNotification(lines.join('\n'));
});

/**
 * Send a notification to all admin-review actors.
 * Used for business events that require operational attention.
 * SAFE: catches its own errors.
 */
const notifyAdminsAndSupervisors = ({ title, message, type = NOTIFICATION_TYPE.INFO, link = null, source = 'SYSTEM' }) => {
    return _safe('notifyAdminsAndSupervisors', async () => {
        const recipients = await User.find({
            role: { $in: ['ADMIN', 'SUPERVISOR'] },
            deletedAt: null,
        }).select('_id').lean();

        if (!recipients.length) return [];

        const docs = recipients.map((user) => ({
            userId: user._id,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source,
        }));

        const notifications = await Notification.insertMany(docs, { ordered: false });
        notifications.forEach(dispatchUserPushSafely);
        return notifications;
    });
};

// =============================================================================
// LOW-LEVEL CREATORS (fire-and-forget safe)
// =============================================================================

/**
 * Create a notification for a single user.
 * SAFE: catches its own errors — will never crash the caller.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {string}          params.title
 * @param {string}          params.message
 * @param {string}          [params.type='INFO']
 * @param {string|null}     [params.link]
 * @param {string}          [params.source='SYSTEM']
 */
const notifyUser = ({ userId, title, message, type = NOTIFICATION_TYPE.INFO, link = null, source = 'SYSTEM' }) => {
    return _safe('notifyUser', async () => {
        const notification = await Notification.create({
            userId,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source,
        });
        dispatchUserPushSafely(notification);
        return notification;
    });
};

/**
 * Create a broadcast notification visible to all users.
 * SAFE: catches its own errors.
 */
const notifyBroadcast = ({ title, message, type = NOTIFICATION_TYPE.INFO, link = null, source = 'ADMIN' }) => {
    return _safe('notifyBroadcast', async () => {
        const notification = await Notification.create({
            userId: null,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.BROADCAST,
            link,
            source,
        });
        dispatchBroadcastPushSafely(notification);
        return notification;
    });
};

/**
 * Send a notification to all users in a specific group.
 * Uses insertMany for efficiency.
 * SAFE: catches its own errors.
 *
 * @param {string|ObjectId} groupId
 * @param {Object}          notification - { title, message, type?, link?, source? }
 */
const notifyGroup = (groupId, { title, message, type = NOTIFICATION_TYPE.INFO, link = null, source = 'ADMIN' }) => {
    return _safe('notifyGroup', async () => {
        const users = await User.find({ groupId, deletedAt: null }).select('_id').lean();
        if (!users.length) return [];

        const docs = users.map((u) => ({
            userId: u._id,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source,
        }));

        const notifications = await Notification.insertMany(docs, { ordered: false });
        notifications.forEach(dispatchUserPushSafely);
        return notifications;
    });
};

// =============================================================================
// BUSINESS TRIGGER HELPERS (fire-and-forget — no await needed)
// =============================================================================

/**
 * Notify user that their account has been approved.
 * @param {string|ObjectId} userId
 */
const notifyAccountApproved = (userId) => {
    return notifyUser({
        userId,
        title: 'تم تفعيل الحساب ✅',
        message: 'تم تفعيل حسابك بنجاح، ويمكنك الآن استخدام خدمات المنصة.',
        type: NOTIFICATION_TYPE.SUCCESS,
        source: 'ACCOUNT',
    });
};

/**
 * Notify user that their deposit has been approved.
 * @param {Object} deposit - DepositRequest document
 */
const notifyDepositApproved = (deposit, details = {}) => {
    notifyAdminEvent('تم قبول طلب إضافة الرصيد ✅', deposit, details);
    return notifyUser({
        userId: deposit.userId?._id ?? deposit.userId,
        title: 'تم قبول إضافة الرصيد ✅',
        message: `تم قبول تحويلك بقيمة ${deposit.requestedAmount} ${deposit.currency || ''} وإضافة ${details.creditedAmount ?? deposit.requestedAmount} ${details.walletCurrency || deposit.currency || ''} إلى محفظتك.${details.balanceAfter != null ? ` رصيدك بعد الإضافة: ${details.balanceAfter} ${details.walletCurrency || ''}.` : ''}`,
        type: NOTIFICATION_TYPE.SUCCESS,
        source: 'DEPOSIT',
    });
};

/**
 * Notify admins/supervisors that a new deposit requires review.
 * @param {Object} deposit - DepositRequest document
 */
const notifyNewDeposit = (deposit) => {
    const amount = `${deposit.requestedAmount} ${deposit.currency || 'USD'}`;
    const customer = deposit.userId?.name || deposit.userNameSnapshot || 'أحد العملاء';

    return notifyAdminsAndSupervisors({
        title: 'طلب إضافة رصيد جديد',
        message: `قدّم ${customer} طلب إضافة رصيد بقيمة ${amount}.`,
        type: NOTIFICATION_TYPE.WARNING,
        link: '/admin/payments',
        source: 'DEPOSIT',
    });
};

/**
 * Notify user that their deposit has been rejected.
 * @param {Object} deposit - DepositRequest document
 * @param {string|null} [adminNotes]
 */
const notifyDepositRejected = (deposit, adminNotes = null) => {
    notifyAdminEvent('تم رفض طلب إضافة الرصيد ❌', deposit, { reason: adminNotes });
    const reason = adminNotes ? ` السبب: ${adminNotes}` : '';
    return notifyUser({
        userId: deposit.userId?._id ?? deposit.userId,
        title: 'تم رفض إضافة الرصيد ❌',
        message: `تم رفض طلب إضافة الرصيد بقيمة ${deposit.requestedAmount} ${deposit.currency || ''}.${reason}`,
        type: NOTIFICATION_TYPE.ERROR,
        source: 'DEPOSIT',
    });
};

const notifyManualWalletCredit = (transaction, currency) => {
    if (!transaction) return null;
    const details = { creditedAmount: transaction.amount, balanceAfter: transaction.balanceAfter, walletCurrency: currency };
    notifyAdminEvent('تمت إضافة رصيد للعميل ✅', transaction, details);
    return notifyUser({ userId: transaction.userId, title: 'تمت إضافة رصيد لمحفظتك ✅',
        message: `تمت إضافة ${transaction.amount} ${currency || ''} إلى محفظتك. رصيدك بعد الإضافة: ${transaction.balanceAfter} ${currency || ''}.`,
        type: NOTIFICATION_TYPE.SUCCESS, source: 'DEPOSIT' });
};

/**
 * Notify user that their target order has been approved.
 * @param {Object} order - TargetOrder document
 */
const notifyTargetApproved = (order) => {
    notifyAdminEvent('تم قبول طلب التارجت ✅', order);
    return notifyUser({
        userId: order.userId?._id ?? order.userId,
        title: 'تم قبول طلب التارجت ✅',
        message: `تم قبول طلب التارجت الخاص بك لعدد ${order.coinAmount} عملة.`,
        type: NOTIFICATION_TYPE.SUCCESS,
        source: 'TARGET',
    });
};

/**
 * Notify user that their target order has been rejected.
 * @param {Object} order - TargetOrder document
 * @param {string|null} [adminNotes]
 */
const notifyTargetRejected = (order, adminNotes = null) => {
    notifyAdminEvent('تم رفض طلب التارجت ❌', order, { reason: adminNotes });
    const reason = adminNotes ? ` السبب: ${adminNotes}` : '';
    return notifyUser({
        userId: order.userId?._id ?? order.userId,
        title: 'تم رفض طلب التارجت ❌',
        message: `تم رفض طلب التارجت الخاص بك لعدد ${order.coinAmount} عملة.${reason}`,
        type: NOTIFICATION_TYPE.ERROR,
        source: 'TARGET',
    });
};

/**
 * Notify admins/supervisors that a new target order requires review.
 * @param {Object} order - TargetOrder document
 */
const notifyNewTargetOrder = (order) => {
    const customer = order.userId?.name || order.userNameSnapshot || 'أحد العملاء';
    const appName = order.appNameSnapshot || order.appId?.name || 'تطبيق التارجت';
    const amount = order.coinAmount ?? 'المطلوبة';

    return notifyAdminsAndSupervisors({
        title: 'طلب تارجت جديد',
        message: `قدّم ${customer} طلب تارجت لعدد ${amount} عملة على ${appName}.`,
        type: NOTIFICATION_TYPE.WARNING,
        link: '/admin/target-requests',
        source: 'TARGET',
    });
};

/**
 * Notify user that their product order was completed.
 * @param {Object} order - Order document
 */
const notifyOrderCompleted = (order) => {
    if (!order) return null;
    notifyAdminEvent('اكتمل شحن الطلب ✅', order);
    const label = order.orderNumber ? `#${order.orderNumber}` : '';
    return notifyUser({
        userId: order.userId?._id ?? order.userId,
        title: 'اكتمل شحن الطلب ✅',
        message: `تم شحن طلبك ${label} بنجاح.`,
        type: NOTIFICATION_TYPE.SUCCESS,
        source: 'ORDER',
    });
};

/**
 * Notify user that their product order failed (with refund).
 * @param {Object} order - Order document
 */
const notifyOrderFailed = (order) => _safe('notifyOrderFailed', async () => {
    if (!order) return null;
    const label = order.orderNumber ? `#${order.orderNumber}` : '';
    const refund = await WalletTransaction.findOne({ userId: order.userId?._id ?? order.userId, reference: order._id, type: 'REFUND', status: 'COMPLETED' }).sort({ createdAt: -1 }).lean();
    const partial = order.status === 'PARTIAL';
    const title = partial ? 'اكتمل شحن الطلب جزئيًا' : 'تعذر شحن الطلب ❌';
    notifyAdminEvent(title, order, { refundAmount: refund?.amount, balanceAfter: refund?.balanceAfter, walletCurrency: order.currency });
    return notifyUser({ userId: order.userId?._id ?? order.userId, title,
        message: `${partial ? 'اكتمل شحن طلبك جزئيًا' : 'تعذر شحن طلبك'} ${label}.${refund ? ` تم تسجيل استرداد ${refund.amount} ${order.currency || ''} في محفظتك.` : ' يرجى مراجعة حالة الاسترداد أو التواصل مع الدعم.'}`,
        type: NOTIFICATION_TYPE.WARNING, source: 'ORDER' });
});

/**
 * Notify admins/supervisors that a manual product order requires fulfillment.
 * @param {Object} order - Order document
 */
const notifyNewManualOrder = (order) => {
    const label = order.orderNumber ? `#${order.orderNumber}` : '';
    const customer = order.userId?.name || order.userNameSnapshot || 'أحد العملاء';
    const productName = order.productId?.name || order.productNameSnapshot || 'منتج يدوي';

    return notifyAdminsAndSupervisors({
        title: 'طلب يدوي جديد',
        message: `قدّم ${customer} الطلب اليدوي ${label} لمنتج ${productName}.`,
        type: NOTIFICATION_TYPE.WARNING,
        link: '/admin/orders',
        source: 'ORDER',
    });
};

// =============================================================================
// CRUD — CUSTOMER ENDPOINTS
// =============================================================================

/**
 * Get notifications for a user (own + broadcasts), paginated.
 * Sorted newest-first. Includes unread badge count.
 */
const getMyNotifications = async (userId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;

    // Query: notifications targeted at this user OR broadcasts
    const filter = {
        $or: [
            { userId, scope: NOTIFICATION_SCOPE.USER },
            { scope: NOTIFICATION_SCOPE.BROADCAST },
        ],
    };

    const [notifications, total, unreadCount] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Notification.countDocuments(filter),
        Notification.countDocuments({
            $or: [
                { userId, scope: NOTIFICATION_SCOPE.USER, isRead: false },
                { scope: NOTIFICATION_SCOPE.BROADCAST, isRead: false },
            ],
        }),
    ]);

    return {
        notifications,
        unreadCount,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Mark a single notification as read.
 * Only the owner (or any user for broadcasts) can mark it.
 */
const markAsRead = async (notificationId, userId) => {
    const notification = await Notification.findById(notificationId);
    if (!notification) throw new NotFoundError('Notification');

    // Ownership check for user-scoped notifications
    if (
        notification.scope === NOTIFICATION_SCOPE.USER &&
        notification.userId?.toString() !== userId.toString()
    ) {
        throw new BusinessRuleError(
            'You can only mark your own notifications as read.',
            'NOT_YOUR_NOTIFICATION'
        );
    }

    if (notification.isRead) return notification;

    notification.isRead = true;
    await notification.save();
    return notification;
};

/**
 * Mark ALL unread notifications for a user as read.
 * Includes user-scoped and broadcast notifications.
 */
const markAllAsRead = async (userId) => {
    const result = await Notification.updateMany(
        {
            $or: [
                { userId, scope: NOTIFICATION_SCOPE.USER, isRead: false },
                { scope: NOTIFICATION_SCOPE.BROADCAST, isRead: false },
            ],
        },
        { $set: { isRead: true } }
    );
    return { modifiedCount: result.modifiedCount };
};

/**
 * Get unread count for badge display.
 */
const getUnreadCount = async (userId) => {
    const count = await Notification.countDocuments({
        $or: [
            { userId, scope: NOTIFICATION_SCOPE.USER, isRead: false },
            { scope: NOTIFICATION_SCOPE.BROADCAST, isRead: false },
        ],
    });
    return count;
};

// =============================================================================
// CRUD — ADMIN ENDPOINTS
// =============================================================================

/**
 * Admin: list all notifications system-wide, paginated.
 */
const listAllNotifications = async ({ page = 1, limit = 20, scope, type } = {}) => {
    const filter = {};
    if (scope) filter.scope = scope;
    if (type) filter.type = type;

    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email')
            .lean(),
        Notification.countDocuments(filter),
    ]);

    return {
        notifications,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Admin: send a manual notification.
 *
 * Modes:
 *   - userId   → single user
 *   - groupId  → all users in a group (insertMany)
 *   - broadcast → all users (broadcast scope, single doc)
 *
 * @param {Object} params
 * @param {string|ObjectId|null} params.userId
 * @param {string|ObjectId|null} params.groupId
 * @param {boolean}              params.broadcast
 * @param {string}               params.title
 * @param {string}               params.message
 * @param {string}               [params.type='INFO']
 * @param {string|null}          [params.link]
 */
const adminSendNotification = async ({
    userId = null,
    groupId = null,
    broadcast = false,
    title,
    message,
    type = NOTIFICATION_TYPE.INFO,
    link = null,
}) => {
    // ── Broadcast ────────────────────────────────────────────────────────────
    if (broadcast) {
        const notification = await Notification.create({
            userId: null,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.BROADCAST,
            link,
            source: 'ADMIN',
        });
        dispatchBroadcastPushSafely(notification);
        return { sent: 1, mode: 'broadcast', notification };
    }

    // ── Group ────────────────────────────────────────────────────────────────
    if (groupId) {
        const users = await User.find({ groupId, deletedAt: null }).select('_id').lean();
        if (!users.length) {
            throw new BusinessRuleError(
                'No active users found in this group.',
                'GROUP_EMPTY'
            );
        }

        const docs = users.map((u) => ({
            userId: u._id,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source: 'ADMIN',
        }));

        const result = await Notification.insertMany(docs, { ordered: false });
        result.forEach(dispatchUserPushSafely);
        return { sent: result.length, mode: 'group', groupId };
    }

    // ── Single user ──────────────────────────────────────────────────────────
    if (userId) {
        const user = await User.findById(userId).select('_id');
        if (!user) throw new NotFoundError('User');

        const notification = await Notification.create({
            userId,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source: 'ADMIN',
        });
        dispatchUserPushSafely(notification);
        return { sent: 1, mode: 'user', notification };
    }

    throw new BusinessRuleError(
        'You must specify a userId, groupId, or broadcast: true.',
        'MISSING_TARGET'
    );
};

module.exports = {
    // Low-level (fire-and-forget safe)
    notifyUser,
    notifyBroadcast,
    notifyGroup,

    // Business triggers (fire-and-forget safe)
    notifyAccountApproved,
    notifyNewDeposit,
    notifyDepositApproved,
    notifyDepositRejected,
    notifyManualWalletCredit,
    notifyNewTargetOrder,
    notifyTargetApproved,
    notifyTargetRejected,
    notifyNewManualOrder,
    notifyOrderCompleted,
    notifyOrderFailed,

    // CRUD — customer
    getMyNotifications,
    markAsRead,
    markAllAsRead,
    getUnreadCount,

    // CRUD — admin
    listAllNotifications,
    adminSendNotification,
};
