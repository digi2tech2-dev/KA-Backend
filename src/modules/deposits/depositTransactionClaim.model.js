'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    depositId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

module.exports = mongoose.models.DepositTransactionClaim
    || mongoose.model('DepositTransactionClaim', schema);
