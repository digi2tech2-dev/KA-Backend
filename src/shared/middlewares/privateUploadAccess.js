'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { AuthorizationError, NotFoundError } = require('../errors/AppError');
const mongoose = require('mongoose');
const UploadedAsset = mongoose.models.SecurityUploadAsset || mongoose.model('SecurityUploadAsset', new mongoose.Schema({ _id: String, userId: mongoose.Schema.Types.ObjectId }, { timestamps: true }));

const definitions = {
    deposits: ['deposits/deposit.model', 'DepositRequest', 'receiptImage', 'MANAGE_DEPOSITS'],
    targets: ['targets/target.model', 'TargetOrder', 'screenshotProof', 'MANAGE_TARGETS'],
    'sub-agent-proofs': ['subAgentRequests/subAgentRequest.model', 'SubAgentRequest', 'proofPath', 'MANAGE_USERS'],
    'referral-payout-receipts': ['referralPayouts/referralPayout.model', 'ReferralPayout', 'paymentProofPath', 'MANAGE_WALLET'],
    'order-fields': ['orders/order.model', 'Order', 'customerInput.values', 'MANAGE_ORDERS'],
};
module.exports = (kind) => async (req, res, next) => {
    try {
        if (!/^\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(req.path)) throw new NotFoundError('File');
        const def = definitions[kind];
        if (!def) throw new NotFoundError('File');
        const asset = `uploads/${kind}${req.path}`;
        const model = mongoose.models[def[1]];
        if (!model) throw new NotFoundError('File');
        let query = { [def[2]]: { $in: [asset, '/' + asset] } };
        let record;
        if (kind === 'order-fields') {
            // An order's arbitrary input is not proof that its author owns a file.
            // New uploads receive an immutable owner before their URL is returned.
            record = await UploadedAsset.findById('/' + asset).select('userId');
            if (!record && req.user.role === 'ADMIN') record = { userId: req.user._id };
        } else record = await model.findOne(query).select('userId');
        if (!record) throw new NotFoundError('File');
        if (String(record.userId) !== String(req.user._id) && req.user.role !== 'ADMIN'
            && !(req.user.role === 'SUPERVISOR' && req.user.permissions?.includes(def[3]))) throw new AuthorizationError();
        const root = path.resolve(__dirname, '../../../uploads', kind);
        const file = path.join(root, req.path.slice(1));
        const real = await fs.realpath(file).catch(() => { throw new NotFoundError('File'); });
        if (path.dirname(real) !== await fs.realpath(root)) throw new NotFoundError('File');
        res.set('Cache-Control', 'private, no-store');
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        res.set('X-Content-Type-Options', 'nosniff');
        if (/\.pdf$/i.test(file)) res.set('Content-Disposition', 'attachment');
        res.sendFile(real);
    } catch (error) { next(error); }
};
module.exports.recordUpload = async (assetPath, userId) => {
    await UploadedAsset.create({ _id: assetPath, userId });
};
