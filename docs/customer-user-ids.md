# Customer IDs

On a new database, customers receive `100`, `101`, `102`, and so on. Admins
and supervisors do not consume customer numbers. Email registration, Google
registration, `User.create/save`, and `User.insertMany` share the same counter.

Customer account responses expose a numeric `id` and `userNumber`:

```json
{ "id": 100, "userNumber": 100, "_id": "507f1f77bcf86cd799439011" }
```

Display `id` or `userNumber` in the frontend. `_id`, JWT identity, database
references and the internal Mongoose `user.id` remain ObjectIds so existing
orders, wallets and permissions keep their relationships.

Customer-number lookup is supported on `/api/users/:id`,
`/api/admin/users/:id` (including account actions),
`/api/admin/wallets/:userId`, `/api/wallet/users/:userId/transactions`, and
`/api/admin/referrals/agents/:userId/commission`. Existing ObjectId URLs remain
valid. Admin order filtering by `?userId=100` and notification targeting with
`{ "userId": 100 }` are also supported.

Admin customer search accepts the number via `search=100`. Customer lists can
sort by `sortBy=userNumber&sortOrder=asc`.

Numbers are allocated using an atomic MongoDB counter named
`customerUserNumber`, initialized to 99. A unique sparse index on
`User.userNumber` prevents duplicates. The number is immutable and is not
reused after deletion. Do not reset this counter or assign numbers through
raw updates/bulkWrite/upserts, which bypass user creation hooks.

The sequence increases monotonically but can have gaps after failed writes,
aborted transactions or failed bulk imports. IDs represent stable identity,
not the current customer count or approval order.

This release targets the new database. It does not renumber legacy users or
change staff IDs. Existing customers without `userNumber` keep their previous
ID until an explicit migration is performed.
