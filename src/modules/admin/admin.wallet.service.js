'use strict';

/**
 * admin.wallet.service.js
 *
 * Admin manual wallet adjustments.
 *
 * Uses sequential await operations — compatible with standalone MongoDB
 * instances (no replica set required).
 */

const { User } = require('../users/user.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../wallet/walletTransaction.model');
const { recalculateCreditUsed } = require('../wallet/wallet.service');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { buildPublicWalletSummary } = require('../../shared/utils/walletSummary');
const { notifyManualWalletCredit } = require('../notifications/notification.service');

const MAX_ADJUSTMENT = 100_000;  // guard against fat-finger typos

/**
 * Safe rounding via integer math — kills IEEE-754 dust like 5.684e-14.
 * Number.toFixed(2) still leaks because it returns a string that Number()
 * re-parses, preserving intermediate float imprecision.
 */
const safeRound = (value, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
};

// ─── List wallets (summary of all users) ─────────────────────────────────────

const listWallets = async ({ page = 1, limit = 20 } = {}) => {
    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
        User.find({ deletedAt: null })
            .select('name email walletBalance creditLimit creditUsed currency role status')
            .sort({ walletBalance: -1 })
            .skip(skip)
            .limit(limit),
        User.countDocuments({ deletedAt: null }),
    ]);

    return {
        wallets: users.map((user) => ({
            ...(user.toSafeObject ? user.toSafeObject() : user.toObject()),
            ...buildPublicWalletSummary(user),
        })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

// ─── Get one user's wallet ─────────────────────────────────────────────────────

const getWallet = async (userId) => {
    const user = await User.findById(userId)
        .select('name email walletBalance creditLimit creditUsed currency status');
    if (!user) throw new NotFoundError('User');

    // Fetch recent transactions WITH populated references so the frontend
    // store is never overwritten with unpopulated/missing transaction data.
    const recentTransactions = await WalletTransaction.find({ userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('reference', 'orderNumber customerInput status totalPrice');

    return {
        user: {
            ...(user.toSafeObject ? user.toSafeObject() : user.toObject()),
            ...buildPublicWalletSummary(user),
        },
        recentTransactions,
    };
};

// ─── Transaction history ───────────────────────────────────────────────────────

const getTransactionHistory = async (userId, { page = 1, limit = 20 } = {}) => {
    const user = await User.findById(userId).select('_id');
    if (!user) throw new NotFoundError('User');

    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
        WalletTransaction.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('reference', 'orderNumber customerInput status totalPrice'),
        WalletTransaction.countDocuments({ userId }),
    ]);

    return { transactions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ─── Manual Add ───────────────────────────────────────────────────────────────

/**
 * Admin: add funds to a user's wallet balance.
 *
 * IMPORTANT: The `amount` parameter is always in the USER'S LOCAL CURRENCY
 * (the same currency as their walletBalance). No USD conversion is applied.
 * The admin dashboard displays balances in local currency, so the input
 * is naturally in the same denomination.
 *
 * No MongoDB transactions — uses atomic findOneAndUpdate + sequential create.
 */
const addFunds = async (userId, amount, reason, adminId, idempotencyKey) => {
    return require('../../shared/utils/atomicAdminWallet').adjust('ADD', userId, amount, reason, adminId, idempotencyKey);
};

/**
 * Admin: deduct funds from a user's wallet balance.
 *
 * IMPORTANT: The `amount` parameter is always in the USER'S LOCAL CURRENCY
 * (the same currency as their walletBalance). No USD conversion is applied.
 *
 * CREDIT LIMIT ENFORCEMENT:
 *   available = walletBalance + creditLimit
 *   Deduction allowed only if: amount <= available
 *   newBalance = walletBalance - amount (can go negative up to -creditLimit)
 */
const deductFunds = async (userId, amount, reason, adminId, idempotencyKey) => {
    return require('../../shared/utils/atomicAdminWallet').adjust('DEDUCT', userId, amount, reason, adminId, idempotencyKey);
};

// ─── Admin Force Set Balance ──────────────────────────────────────────────────

/**
 * Admin: forcefully set a user's wallet balance to an exact value.
 *
 * This bypasses credit limit checks — it is an admin override.
 * The amount parameter IS the desired new balance (can be negative).
 * Credit usage is recalculated based on the new balance.
 */
const setBalance = async (userId, targetBalance, reason, adminId, idempotencyKey) => {
    return require('../../shared/utils/atomicAdminWallet').adjust('SET', userId, targetBalance, reason, adminId, idempotencyKey);
};

// ─── Bulk Debt Adjustment (Currency Devaluation) ─────────────────────────────

/**
 * Adjust all negative wallet balances by a percentage increase to account
 * for currency devaluation (debt pegging).
 *
 * For each user with walletBalance < 0:
 *   adjustment = |walletBalance| × (percentageIncrease / 100)
 *   newBalance = walletBalance - adjustment  (more negative)
 *
 * A DEBT_ADJUSTMENT transaction is created for each affected user
 * with a clear description so the user understands the deduction.
 *
 * @param {number} percentageIncrease - e.g. 5 for a 5% devaluation
 * @param {string|ObjectId} adminId       - the admin who triggered this action
 * @param {string}          [currencyCode] - ISO 4217 code to filter users by (e.g. 'EGP')
 * @returns {{ usersAdjusted, totalAdjustment, totalUsersInDebt, errors }}
 */
const adjustNegativeBalancesForInflation = async (percentageIncrease, adminId, currencyCode = null) => {
    if (percentageIncrease <= 0 || percentageIncrease > 100) {
        throw new BusinessRuleError(
            'Percentage must be between 0.01 and 100.',
            'INVALID_PERCENTAGE'
        );
    }

    const multiplier = percentageIncrease / 100;

    // Build query — filter by currency if provided
    const query = { walletBalance: { $lt: 0 }, deletedAt: null };
    if (currencyCode) {
        query.currency = currencyCode.toUpperCase();
    }

    const usersInDebt = await User.find(query).select('_id walletBalance creditLimit creditUsed currency');

    if (usersInDebt.length === 0) {
        return { usersAdjusted: 0, totalAdjustment: 0, totalUsersInDebt: 0, errors: [] };
    }

    let usersAdjusted = 0;
    let totalAdjustment = 0;
    const errors = [];

    for (const user of usersInDebt) {
        try {
            const balanceBefore = safeRound(user.walletBalance);
            const adjustment = safeRound(Math.abs(balanceBefore) * multiplier);

            // Skip negligible adjustments (less than 0.01)
            if (adjustment < 0.01) continue;

            const balanceAfter = safeRound(balanceBefore - adjustment);
            const creditUsedAfter = recalculateCreditUsed(balanceAfter, user.creditLimit);

            // Atomic balance update
            await User.findByIdAndUpdate(user._id, {
                $set: {
                    walletBalance: balanceAfter,
                    creditUsed: creditUsedAfter,
                },
            });

            // Create auditable wallet transaction
            await WalletTransaction.create({
                userId: user._id,
                type: TRANSACTION_TYPES.DEBT_ADJUSTMENT,
                amount: adjustment,
                balanceBefore,
                balanceAfter,
                reference: null,
                status: 'COMPLETED',
                description: `Debt adjustment due to ${currencyCode || 'currency'} rate increase (${percentageIncrease}%)`,
            });


            usersAdjusted++;
            totalAdjustment = safeRound(totalAdjustment + adjustment);
        } catch (err) {
            errors.push({ userId: user._id.toString(), error: err.message });
        }
    }

    // Single audit log for the bulk operation
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.DEBT_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: null,
        metadata: {
            type: 'BULK_DEBT_ADJUSTMENT',
            percentageIncrease,
            usersAdjusted,
            totalAdjustment,
            totalUsersInDebt: usersInDebt.length,
            errors: errors.length > 0 ? errors : undefined,
        },
    });
    return { usersAdjusted, totalAdjustment, totalUsersInDebt: usersInDebt.length, errors };
};

// ─── Bulk Debt Relief (Currency Appreciation) ────────────────────────────────

/**
 * Adjust all negative wallet balances by a percentage decrease to account
 * for currency appreciation (debt relief).
 *
 * For each user with walletBalance < 0:
 *   adjustment = |walletBalance| × (percentageDecrease / 100)
 *   newBalance = walletBalance + adjustment  (less negative)
 *
 * A DEBT_ADJUSTMENT transaction is created for each affected user
 * with a clear description so the user understands the credit.
 *
 * @param {number} percentageDecrease - e.g. 5 for a 5% appreciation
 * @param {string|ObjectId} adminId   - the admin who triggered this action
 * @param {string}          [currencyCode] - ISO 4217 code to filter users by
 * @returns {{ usersAdjusted, totalAdjustment, totalUsersInDebt, errors }}
 */
const adjustNegativeBalancesForDeflation = async (percentageDecrease, adminId, currencyCode = null) => {
    if (percentageDecrease <= 0 || percentageDecrease > 100) {
        throw new BusinessRuleError(
            'Percentage must be between 0.01 and 100.',
            'INVALID_PERCENTAGE'
        );
    }

    const multiplier = percentageDecrease / 100;

    // Build query — filter by currency if provided
    const query = { walletBalance: { $lt: 0 }, deletedAt: null };
    if (currencyCode) {
        query.currency = currencyCode.toUpperCase();
    }

    const usersInDebt = await User.find(query).select('_id walletBalance creditLimit creditUsed currency');

    if (usersInDebt.length === 0) {
        return { usersAdjusted: 0, totalAdjustment: 0, totalUsersInDebt: 0, errors: [] };
    }

    let usersAdjusted = 0;
    let totalAdjustment = 0;
    const errors = [];

    for (const user of usersInDebt) {
        try {
            const balanceBefore = safeRound(user.walletBalance);
            const adjustment = safeRound(Math.abs(balanceBefore) * multiplier);

            // Skip negligible adjustments (less than 0.01)
            if (adjustment < 0.01) continue;

            // ADD the adjustment (debt relief — balance moves toward 0)
            const balanceAfter = safeRound(balanceBefore + adjustment);
            const creditUsedAfter = recalculateCreditUsed(balanceAfter, user.creditLimit);

            // Atomic balance update
            await User.findByIdAndUpdate(user._id, {
                $set: {
                    walletBalance: balanceAfter,
                    creditUsed: creditUsedAfter,
                },
            });

            // Create auditable wallet transaction
            await WalletTransaction.create({
                userId: user._id,
                type: TRANSACTION_TYPES.DEBT_ADJUSTMENT,
                amount: adjustment,
                balanceBefore,
                balanceAfter,
                reference: null,
                status: 'COMPLETED',
                description: `Debt relief due to ${currencyCode || 'currency'} rate decrease (${percentageDecrease}%)`,
            });

            usersAdjusted++;
            totalAdjustment = safeRound(totalAdjustment + adjustment);
        } catch (err) {
            errors.push({ userId: user._id.toString(), error: err.message });
        }
    }

    // Single audit log for the bulk operation
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.DEBT_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: null,
        metadata: {
            type: 'BULK_DEBT_DEFLATION',
            percentageDecrease,
            usersAdjusted,
            totalAdjustment,
            totalUsersInDebt: usersInDebt.length,
            errors: errors.length > 0 ? errors : undefined,
        },
    });

    return { usersAdjusted, totalAdjustment, totalUsersInDebt: usersInDebt.length, errors };
};

module.exports = {
    listWallets,
    getWallet,
    getTransactionHistory,
    addFunds,
    deductFunds,
    setBalance,
    adjustNegativeBalancesForInflation,
    adjustNegativeBalancesForDeflation,
};
