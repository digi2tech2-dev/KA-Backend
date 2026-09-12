# Canonical B2B API v1

The public B2B base is `https://your-domain.example/client/api`. Each K&A
deployment changes only the domain and API token. Product and category IDs are
numeric compatibility IDs; do not use MongoDB IDs in B2B requests.

`/api/client/api` remains a legacy alias of the same API. Existing
`/api/v1/reseller` and `/api/client` integrations retain their own contracts.

## Authentication

Use `api-token: YOUR_API_TOKEN`. The legacy `x-api-key` and
`Authorization: Bearer YOUR_API_TOKEN` forms are also accepted. Accounts must
be active, API-enabled, non-deleted, and satisfy any configured exact IP list.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/profile` | Spendable balance, email, and currency. |
| GET | `/products` | Optional `products_id=1000,1001` and legacy `base=1`. |
| GET | `/content/0` | Root categories and uncategorized products. |
| GET | `/content/:parentId` | Numeric compatibility category ID. |
| POST | `/orders` | Canonical order placement. |
| GET | `/check?orders=ID_1,ID_2` | Lookup by compatibility order ID. |
| GET | `/check?orders=uuid1,uuid2&uuid=1` | Legacy UUID lookup. |
| GET | `/check?uuids=uuid1,uuid2` | Canonical UUID lookup. |
| GET | `/newOrder/:productId/params` | Permanently supported legacy placement route. |

## Products

Products retain compatibility price and quantity aliases. New consumers should
use canonical structured fields while legacy consumers may continue using
`params`:

```json
{
  "id": 1000,
  "name": "Example product",
  "price": 1.5,
  "currency": "USD",
  "params": ["Player ID"],
  "fields": [
    {
      "key": "player_id",
      "label": "Player ID",
      "type": "text",
      "required": true,
      "options": []
    }
  ]
}
```

## Create an order

```http
POST /orders
Content-Type: application/json
```

```json
{
  "product_id": 1000,
  "qty": 1,
  "order_uuid": "client-generated-idempotency-key",
  "params": {
    "player_id": "123456789"
  }
}
```

`order_uuid` is required and maps to the unique `(userId, idempotencyKey)`
constraint. Retrying it returns the original order without another debit.

```json
{
  "status": "OK",
  "data": {
    "order_id": "ID_0123456789abcdef",
    "order_uuid": "client-generated-idempotency-key",
    "status": "wait",
    "price": 1.5,
    "currency": "USD"
  }
}
```

Order checks include `order_uuid` additively. Creation and checking use
no-store response headers.

## Statuses and errors

| External status | Meaning |
| --- | --- |
| `accept` | Completed |
| `wait` | Pending, processing, partial, manual review, or in-flight |
| `reject` | Failed or cancelled |

Compatibility errors use `{ "status": "ERROR", "code": number, "message": string }`.

| Code | Meaning |
| --- | --- |
| 100 | Insufficient balance |
| 105–106 | Quantity unavailable / invalid quantity |
| 109–110 | Product not found / unavailable |
| 111 | Rate limited |
| 112–114 | Quantity/business order rules |
| 120–122 | Token required, invalid, or disabled/inactive account |
| 123 | IP not allowed |
| 124 | Validation error |
| 130 | Maintenance; placement only |
| 500 | Internal error |

When `maintenanceMode` is enabled, only the two placement routes return HTTP
503 / code 130. Catalogue, profile, and status routes remain available.

Run `node scripts/backfill-compat-ids.js` as a controlled deployment action
before exposing existing catalogue data that lacks compatibility IDs.
