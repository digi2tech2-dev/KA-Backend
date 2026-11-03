# Coin Recharge in AD

The adapter was copied from MS and integrated with AD's existing supplier,
product, verification, fulfillment, and admin review flows. MS is unchanged.

## Setup

1. Create or edit a supplier and select **Coin Recharge** as its integration
   type (`adapterType: coin-recharge`). A custom supplier name/code is supported.
2. Set the supplier base URL and use its `secretKey` as the API key/token.
   Do not include `/dealer/sale` in the base URL.
3. From the supplier list, open **إعداد شحن العملات**, set the USD price per
   coin and minimum/maximum quantity, and save.
4. Publish the generated `coin-recharge-dynamic` product from the supplier
   catalog. AD automatically supplies a verifiable `target_uid` text field,
   maps it to `toUserId`, and enables automatic fulfillment.

Optional: `COIN_RECHARGE_API_TIMEOUT_MS` controls the HTTP timeout (default
20,000 ms). No additional npm dependencies are required.

## Behavior

- The existing customer **Verify** button calls AD's `/products/:id/verify-field`
  endpoint. The server verifies the target again before charging the customer.
- Coin quantities must be positive safe integers and remain within both the
  published product bounds and the current supplier configuration.
- A durable `providerSaleAttemptedAt` claim prevents concurrent execution or
  restart from sending another sale. This timestamp must never be cleared to
  retry an order.
- Only a confirmed supplier `code: 200` sale completes an order automatically.
  Timeouts, malformed responses, and other sale results go to `MANUAL_REVIEW`
  without an automatic refund or another supplier request.
- The existing processing-order scheduler moves interrupted attempts older
  than two minutes to manual review. It never polls this supplier for status.
- For manual review, check delivery with the supplier, enter a reason in order
  details, then choose completion or refund. Resolution uses a dedicated endpoint;
  generic retry/refund/status actions cannot bypass this workflow.

## Added admin endpoints

- `PATCH /admin/providers/:id/coin-recharge/product-config`
  (`name`, `unitPrice`, `minCoins`, `maxCoins`, `isActive`).
- `GET /admin/providers/:id/coin-recharge/history?page=1`: evidence for human
  review only; history is never used to infer delivery automatically.
- `POST /admin/orders/:id/coin-recharge/resolve`
  (`resolution: delivered|refund`, `reason`).

Supplier endpoints require `MANAGE_SUPPLIERS`; order resolution requires
`CONFIRM_ORDERS`.

## Validation

`coinRecharge.adapter.test.js` covers supplier API translation and uncertain
outcomes. `coinRecharge.integration.test.js` uses mocked persistence and covers
AD schema compatibility, target/quantity constraints, concurrent execution,
interrupted sales, local failures, and manual resolution. These tests do not
send real supplier requests or move real balances.

## Frontend route review

| Flow | Frontend | Backend route |
| --- | --- | --- |
| Supplier integration | `AdminSuppliers.jsx`, `realApi.suppliers.create/update` | `POST/PATCH /admin/providers[/id]` |
| Coin configuration | `CoinRechargePricingModal.jsx` | `PATCH /admin/providers/:id/coin-recharge/product-config` |
| Publish catalog product | Existing supplier catalog and product editor | `/admin/catalog` and product publication services |
| Verify target | `ProductPurchaseDialog.jsx`, `realApi.products.verifyField` | `POST /products/:id/verify-field` |
| Checkout | `ProductPurchaseDialog.jsx`, `realApi.orders.create` | `POST /me/orders` |
| Supplier balance | Supplier tools and admin dashboard | `GET /admin/providers/:id/balance` |
| History | `CoinRechargeHistory.jsx` | `GET /admin/providers/:id/coin-recharge/history` |
| Manual decision | `ManualReviewActions.jsx`, `realApi.orders.updateStatus` | `POST /admin/orders/:id/coin-recharge/resolve` |

Coin checkout renders only `target_uid`, requires verification matching the
current value, ignores stale verification responses, and preserves its
idempotency key on retry. It never falls back to a second creation endpoint
after a timeout. Legacy admin order routes also reject direct changes to coin
orders awaiting manual review.

Review validation: 41 backend tests and 9 frontend tests passed, and the Vite
production build completed. Run frontend tests from `KA-Frontend` with:

```sh
node --test src/utils/coinRecharge.test.js scripts/test-coin-recharge-api.mjs
```

Live supplier calls and database-backed end-to-end tests are separate from
these mocked contract tests and have not been performed.
