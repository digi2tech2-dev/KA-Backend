# Security review addendum — 2026-11-27

Reviewed the backend at `f341419` and the local changes in this worktree.

## Fixes prepared locally

- Email 2FA is required for production sign-ins; access tokens without completed MFA are rejected. Disabling MFA is blocked by the platform policy. A one-time migration command enables the database flag and invalidates old sessions.
- Enabled OCR now uses a terminable worker, a per-process concurrency cap, and fails closed on timeout or runtime errors.
- Electronic-wallet deposit requests claim a normalized provider transaction ID atomically with the deposit, closing the concurrent duplicate-reference race.
- Admin wallet currency conversion uses compare-and-set on the stored currency and balance so a concurrent wallet transaction cannot be overwritten.

## Verification

- `npm audit --omit=dev`: no known vulnerable dependencies.
- Local unit suites: 19 suites, 136 tests passed.
- MongoDB-backed integration tests were not run because this environment has no local MongoDB server and the in-memory server binary could not be downloaded here. The new duplicate-transaction and currency-race integration tests need a replica-set test database before these financial changes are pushed.

## Still open before a production security sign-off

- SMTP delivery has not been verified. Required email OTP can block sign-in if the production mail configuration is broken.
- The project report still calls for a per-account cap on pending deposits and external financial alerts.
- Large manual wallet operations above the configured threshold are rejected; a separate second-approver workflow is not implemented.
- Production CORS/OAuth domains, proxy/trusted-origin settings, and the legacy order-field upload ownership migration require staging or database review.
- Key rotation and review of historical backups/logs require an operational response; this workspace has no production credentials.
