'use strict';

// This supplier is intentionally independent from Xena.  Do not share its
// connection, polling, or idempotency contracts with any other provider.
const COIN_RECHARGE_PROVIDER_SLUG = 'coin-recharge';
const COIN_RECHARGE_DYNAMIC_PRODUCT_ID = 'coin-recharge-dynamic';
const COIN_RECHARGE_TARGET_FIELD_KEY = 'target_uid';

module.exports = {
    COIN_RECHARGE_PROVIDER_SLUG,
    COIN_RECHARGE_DYNAMIC_PRODUCT_ID,
    COIN_RECHARGE_TARGET_FIELD_KEY,
};
