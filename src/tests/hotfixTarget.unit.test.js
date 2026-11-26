'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-unit-test-secret-only-2026';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/never-connect-unit-tests';
const { User } = require('../modules/users/user.model');
const guard = require('../shared/utils/accountTarget');
describe('Hot fix: supervisors cannot take over privileged accounts', () => {
    afterEach(() => jest.restoreAllMocks());
    const actor = role => jest.spyOn(User, 'findById').mockReturnValue({ select: async () => ({ role, status: 'ACTIVE' }) });
    test.each(['ADMIN', 'SUPERVISOR'])('rejects a supervisor managing %s', async role => {
        actor('SUPERVISOR');
        await expect(guard('actor', { role })).rejects.toMatchObject({ statusCode: 403 });
    });
    test('preserves customer management by supervisors', async () => {
        actor('SUPERVISOR');
        await expect(guard('actor', { role: 'CUSTOMER' })).resolves.toBeUndefined();
    });
    test('preserves administrator management', async () => {
        actor('ADMIN');
        await expect(guard('actor', { role: 'ADMIN' })).resolves.toBeUndefined();
    });
    test('rejects a customer attempting privileged operations', async () => {
        actor('CUSTOMER');
        await expect(guard('actor', { role: 'CUSTOMER' })).rejects.toMatchObject({ statusCode: 403 });
    });
});
