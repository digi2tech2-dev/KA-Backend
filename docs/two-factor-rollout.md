# Required two-factor login

Outside automated tests, password and Google sign-ins require an email OTP. Accounts with 2FA off are enabled after successful primary authentication; the OTP is then sent to the account email. Full access tokens require a verified OTP, and the account disable endpoints reject requests under the platform policy.

New accounts default to 2FA enabled. Existing accounts become enabled at first login. To mark every existing account enabled at once and invalidate sessions for accounts newly enabled, run this once on the backend server after pulling the release:

```bash
npm run security:enable-2fa
```

The command requires the server's `MONGO_URI` and `JWT_SECRET`. Confirm the server's SMTP credentials can deliver OTP messages before enabling the release: users must receive email to finish signing in. The migration prints only the number of updated accounts. Users whose sessions are invalidated must sign in again and enter the emailed code.
