# Maya Card integration

Maya Card is an independent adapter (`maya-card`; display name `Maya Card`). It uses the existing Provider → ProviderProduct → Product catalog, order fulfillment, wallet debit/refund, sync lock, and recovery services. No seed, migration, environment change, deployment, or real supplier call is part of this change.

## Configuration and later activation

1. Complete an approved operational verification with Maya Card. Confirm the account currency, API access, IP allowlist, response formats for ID and UUID checks, and pricing semantics for each product type. The supplied specification does not state a currency. The documentation page could not be retrieved during implementation; no live account has been verified.
2. In the existing admin provider interface/API create a provider with `name: "Maya Card"`, `slug: "maya-card"`, `adapterType: "maya-card"`, `baseUrl: "https://maya-card.com"`, `isActive: false`, and `syncInterval: 0`. Set `apiToken` server-side using the existing provider credential mechanism. Never put the credential into a URL, checked-in file, or client configuration. The existing mechanism stores provider tokens in the server database; this change does not introduce a separate secret store or encryption mechanism.
3. Use the existing admin connection check (allowed for inactive providers) after approval. It calls `/client/api/profile`; the adapter validates and returns the balance only. Do not log profile data.
4. Verify the real account currency with the supplier, configure its existing active Currency record and `platformRate`, then set `mayaCardConfig: { currency: "<verified ISO code>", currencyVerified: true }`. This flag is an operator attestation, not an automated claim of verification. Catalog prices use `price`, converted to platform USD by the existing currency rate convention; `base_price` stays in the raw payload. USD requires a rate of one.
5. After approval, activate the provider and manually synchronize using the existing provider sync action. Keep all published Maya products inactive until catalog and quantity checks are complete. `syncInterval: 0` excludes Maya from bulk/background synchronization; manual per-provider synchronization remains available.
6. Inspect raw products, translations, availability, quantities, price conversion, and required parameters. Publish selected products using the existing flow. Configure `providerMapping` from internal field names to supplier parameter names. Do not assume every product needs `playerId`. Confirm `price × quantity` billing with the supplier before enabling each product, particularly packages. This implementation preserves the platform's existing per-unit billing contract.
7. Only after explicit approval perform a controlled operational order verification, including timeout/UUID recovery and code delivery through the authorized order flow. Enable customer products after reconciliation. There has been no real purchase or supplier account verification in development.

## Behavior

- HTTP: fixed HTTPS origin, `api-token` header, 30-second timeout, redirects disabled. All calls use GET and Axios parameter serialization. Supplier text and errors never expose an echoed API token. Profile private account fields are not returned.
- Catalog: direct array; optional `productsId` filter and `base` option on `getProducts`; content lookup via `getContent(categoryId = 0)`. Every row is validated before sync writes begin. Compound provider/external ID upserts and existing locks are reused. Missing rows and empty responses never deactivate Maya products. Only literal `available: false` means unavailable. Translations and manual prices remain controlled by admins.
- Quantities: null means one; missing uses existing 1–9999 fallback; arrays retain the complete discrete list in raw payload; ranges accept numeric strings. Minimum is a positive safe integer. Maximum can be any finite number >= minimum, including decimals, without rounding. Unknown structures, booleans, empty strings/arrays, nonfinite values, and inverted ranges fail validation. Customer order quantities must be positive safe integers and satisfy both published bounds and raw supplier rules, before debit and before dispatch.
- Orders: `providerOrderUuid` is persisted with each Maya order as UUIDv4. The immutable `mayaProviderId` snapshot keeps recovery scoped to the original supplier account even after a product is relinked. Atomic dispatch claiming prevents concurrent purchases. Mapped customer fields are nested separately and cannot overwrite quantity, UUID, external product ID, financial fields, or internal references. The adapter requires the external ID and persisted UUID.
- Responses: inner `order.id` is preserved with raw delivery information. Trimmed lowercase `accept`, `wait`, and `reject` map to Completed, Pending, and Cancelled. Missing/unknown statuses stay Pending. HTTP success alone never means completion.
- Recovery: creation timeout, broken connection, missing order, unknown errors, and codes 114/500 trigger lookup using the same UUID. No purchase retry is issued by recovery. If lookup is inconclusive, status remains `PLACEMENT_UNCERTAIN` without a supplier ID or refund. Both polling paths can discover these orders. Unresolved/pending Maya orders reach `MANUAL_REVIEW` at the existing retry limit without automatic refund. A confirmed supplier rejection uses the existing refund mechanism.
- Batch checks serialize `orders` as JSON. ID checks discard unsolicited results and reject duplicate results. A single-UUID lookup accepts exactly one result with a valid supplier order ID when `order_uuid` is omitted. If `order_uuid` is present, it must equal the original UUID. Multiple results (even if only one matches), missing/invalid IDs, and conflicting UUIDs remain unresolved.
- All provider CRUD HTTP responses remove credentials and expose `hasApiToken`; omitted, empty, or masked update credentials preserve the stored token.

## API error mapping

Body `code` / `error_code` is recognized independently of HTTP status:

| Code | Internal suffix (`MAYA_...`) | Creation handling without order ID |
| --- | --- | --- |
| 120 | TOKEN_REQUIRED | confirmed rejection |
| 121 | INVALID_TOKEN | confirmed rejection |
| 122 | API_NOT_ALLOWED | confirmed rejection |
| 123 | IP_NOT_ALLOWED | confirmed rejection |
| 130 | MAINTENANCE | confirmed rejection |
| 100 | INSUFFICIENT_BALANCE | confirmed rejection |
| 105 | QUANTITY_UNAVAILABLE | confirmed rejection |
| 106 | QUANTITY_NOT_ALLOWED | confirmed rejection |
| 107 | PLAYER_BLOCKED | confirmed rejection |
| 108 | TWO_FACTOR_REQUIRED | confirmed rejection |
| 109 | PRODUCT_NOT_FOUND | confirmed rejection |
| 110 | PRODUCT_UNAVAILABLE | confirmed rejection |
| 111 | RETRY_LATER | confirmed rejection; no automatic purchase retry |
| 112 | QUANTITY_TOO_SMALL | confirmed rejection |
| 113 | QUANTITY_TOO_LARGE | confirmed rejection |
| 114 | UNKNOWN_ORDER_ERROR | UUID recovery; uncertain if unresolved |
| 500 | SERVER_ERROR | UUID recovery; uncertain if unresolved |

An order object with an ID is preserved before considering a top-level error code. Transport and unrecognized errors remain uncertain. Supplier IDs remain strings.

## Verification

See the final validation report below for commands and exact results. All Maya HTTP is mocked. Database tests use the project's MongoMemoryReplSet global setup and do not use production MongoDB. Operational verification remains outstanding.

## File inventory

Created:

- `src/modules/providers/adapters/mayaCard.adapter.js`
- `src/modules/providers/mayaCard.rules.js`
- `src/modules/providers/providerSafety.js`
- `src/tests/mayaCardAdapter.test.js`
- `src/tests/mayaCardIntegration.test.js`
- `docs/maya-card-integration.md`

Modified:

- `.gitignore`
- `src/modules/admin/admin.orders.service.js`
- `src/modules/admin/admin.providers.service.js`
- `src/modules/admin/admin.validation.js`
- `src/modules/orders/order.model.js`
- `src/modules/orders/order.service.js`
- `src/modules/orders/orderFulfillment.service.js`
- `src/modules/orders/orderPolling.service.js`
- `src/modules/products/product.validation.js`
- `src/modules/providers/adapters/adapter.factory.js`
- `src/modules/providers/provider.controller.js`
- `src/modules/providers/provider.model.js`
- `src/modules/providers/provider.service.js`
- `src/modules/providers/provider.validation.js`
- `src/modules/providers/providerProductSync.service.js`

## Automatic order tracking and manual admin decisions

Catalog `syncInterval: 0` affects catalog synchronization only. Maya order status is polled automatically by the existing `fulfillmentJob`, scheduled every five minutes (`*/5 * * * *`). Server startup starts that job under the existing startup controls. Verify that `BACKGROUND_JOBS_ENABLED` is not explicitly `false` and `SAFE_LOCAL_PRODUCTION_MODE` is not `true` during an approved activation; no startup settings were changed here.

The existing authorized endpoint `PATCH /api/admin/orders/:id/status` (permission `CONFIRM_ORDERS`) supports manual completion or rejection for Maya, including orders in manual review. Rejection/refund and completion of a previously refunded order retain the existing accounting rules. Terminal manual decisions are excluded from subsequent polling. For Maya only, `processing`, `pending`, or `retry` resumes tracking the original attempted purchase, resets the retry counter, and reuses the saved UUID. The existing admin retry action uses that same Maya path. It never submits a new purchase. Refunded or never-dispatched orders cannot resume tracking; an admin may instead make an explicit completion/refund decision through the existing actions.

Tests exercise the actual scheduled callback with mocked supplier HTTP, manual completion and rejection through the authenticated admin HTTP route, and subsequent polling. Other supplier adapters were not edited.

## Existing API actions for approved configuration

- Create: `POST /api/admin/providers` with the configuration above, inactive and manual-only.
- Update token/configuration: `PATCH /api/admin/providers/:id`; omitted/empty/masked credentials are preserved.
- Test credentials without activation: `POST /api/admin/providers/:id/test-connection`.
- Activate/deactivate: `PATCH /api/admin/providers/:id` with `{ "isActive": true }` or `{ "isActive": false }`.
- Fetch balance after activation: `GET /api/admin/providers/:id/balance`.
- Manually sync catalog after approval: `POST /api/providers/:id/sync`.
- Publish selected products: `POST /api/providers/products/publish` using the existing product form and mapping settings.
- Manually complete/reject an order: `PATCH /api/admin/orders/:id/status` with `{ "status": "completed" }` or `{ "status": "rejected", "rejectionReason": "Operator decision" }`.
- Resume tracking an unrefunded attempted Maya order: the same status endpoint with `{ "status": "processing" }`, or the existing retry action. Neither generates a UUID or another purchase.

These are later operator steps, not actions performed during implementation.
## Initial integration validation results

All Maya supplier requests were mocked; all database runs used MongoMemoryReplSet on loopback with a newly created temporary data directory. No production MongoDB, real API credential, real purchase, real catalog synchronization, deployment, PM2 restart, or production environment edit was used.

| Run | Exact result |
| --- | --- |
| Final Maya adapter + integration tests | **2 suites passed; 100 tests passed; 0 failed**, 14.354 seconds |
| Adapter regression (Maya plus existing adapter unit suites) | **5 suites passed; 247 tests passed; 0 failed**, 8.756 seconds |
| Order/admin/polling regression run, including original baseline copies | **8 suites passed; 305 tests passed; 0 failed**, 54.207 seconds |
| Full project safe suite | **44 suites passed; 2 failed; 1078 tests passed; 2 failed; 1080 total**, 177.272 seconds |
| Original HEAD `8a5d4bd` baseline check of the two failing suites | **26 tests passed; the same 2 tests failed**, 18.014 seconds |
| JavaScript syntax | **19 changed/new JavaScript files passed** `node --check` |
| Whitespace/conflict check | `git diff --check` passed |

Final Maya command:

```powershell
$env:MONGOMS_DOWNLOAD_DIR = Join-Path (Get-Location) '.tmp/mongodb-binaries'
node node_modules/jest/bin/jest.js --runInBand --forceExit --runTestsByPath src/tests/mayaCardAdapter.test.js src/tests/mayaCardIntegration.test.js
```

Full suite command with that same isolated binary cache:

```powershell
node node_modules/jest/bin/jest.js --runInBand --forceExit
```

The last admin-retry regression was added after the full run loaded the Maya integration module; it is included in the final 100-test Maya run. The full-run counts above are reported as actually executed.

The two remaining project failures reproduce on the unchanged original commit:

1. `src/tests/clientCompat.test.js` — `uses code 130 only to block compatibility placement during maintenance`: existing maintenance middleware returns the standard `MAINTENANCE_MODE` envelope while the test expects the compatibility numeric `130` envelope.
2. `src/tests/paymentEvent.test.js` — `marks multiple exact candidate deposits as AMBIGUOUS`: its fixture attempts to reuse a deposit transaction ID that the existing deposit service prohibits.

These unrelated maintenance/deposit behaviors were left unchanged. An earlier full run also encountered temporary MongoDB monitor/test timeouts; the final full rerun above had only the two baseline failures. The suite is therefore not fully green, and this report does not claim production readiness. Supplier account/currency verification and approved operational verification remain required before activation.

## UUID recovery correction

`checkOrderByReference` now accepts the documented `{ "orders": [{ "id": "ID_a37aaa06", "status": "accept", "code": "DELIVERED_CODE" }] }` response for a single requested UUID without requiring an echoed `order_uuid`. Exactly one row and a nonempty string ID or positive safe-integer numeric ID are required. An explicitly returned UUID must match exactly; null/empty/mismatching UUIDs, invalid IDs, and every multi-row response are rejected as unresolved.

The creation-time recovery, fulfillment cron, and order-status poller already delegate to this adapter method, so those services and wallet/refund code needed no changes. Recovery keeps the persisted UUID and original `mayaProviderId`; it only performs status checks. Tests cover all three paths, including a product relinked to another provider, unchanged wallet debit, delivery-code preservation, and no additional purchase.

Files changed for this correction: `src/modules/providers/adapters/mayaCard.adapter.js`, `src/tests/mayaCardAdapter.test.js`, `src/tests/mayaCardIntegration.test.js`, and this document. Validation results follow below.

Validation for the UUID correction:

- Regression tests reproduced both original defects before the adapter change: a single result without an echoed UUID was rejected, and multiple results were accepted when only one echoed the requested UUID.
- After the correction: **6 suites passed, 261 tests passed, 0 failed**, in **48.05 seconds**. This includes **136 Maya tests** (92 adapter tests and 44 integration tests) and 125 related order, fulfillment, polling, and admin tests.
- `node --check` passed for the three changed JavaScript files; `git diff --check` passed.
- All supplier HTTP was mocked. MongoMemoryReplSet used a fresh loopback test database. No supplier, wallet/refund implementation, production data, deployment, or restart was changed by this correction.

```powershell
$env:MONGOMS_DOWNLOAD_DIR = Join-Path (Get-Location) '.tmp/mongodb-binaries'
node node_modules/jest/bin/jest.js --runInBand --forceExit --runTestsByPath src/tests/mayaCardAdapter.test.js src/tests/mayaCardIntegration.test.js src/tests/order.test.js src/tests/fulfillment.test.js src/tests/orderPolling.test.js src/tests/admin.test.js
```
