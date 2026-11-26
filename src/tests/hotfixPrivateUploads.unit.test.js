'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-unit-test-secret-only-2026';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/never-connect-unit-tests';
const fs = require('node:fs/promises');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const express = require('express');
const { User } = require('../modules/users/user.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');
const authenticate = require('../shared/middlewares/authenticate');
const access = require('../shared/middlewares/privateUploadAccess');
describe('Hot fix: private receipt ownership over HTTP', () => {
    let server, url, file;
    beforeAll(async () => {
        file = path.resolve(__dirname, '../../uploads/deposits/hotfix-test-receipt.txt');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, 'private financial evidence');
        const app = express();
        app.use('/uploads/deposits', authenticate, access('deposits'));
        app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ code: err.code }));
        server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        url = `http://127.0.0.1:${server.address().port}/uploads/deposits/hotfix-test-receipt.txt`;
    });
    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
        await fs.unlink(file);
    });
    afterEach(() => jest.restoreAllMocks());
    const request = async (id, role = 'CUSTOMER', permissions = []) => {
        jest.spyOn(User, 'findById').mockResolvedValue({ _id: id, role, permissions, status: 'ACTIVE' });
        jest.spyOn(DepositRequest, 'findOne').mockReturnValue({ select: async () => ({ userId: 'owner' }) });
        const token = jwt.sign({ id, purpose: 'access', sv: '0' }, process.env.JWT_SECRET);
        return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    };
    test('anonymous requests fail before reading evidence', async () => expect((await fetch(url)).status).toBe(401));
    test('another customer cannot read the receipt', async () => expect((await request('other')).status).toBe(403));
    test('the owner can view evidence', async () => {
        const response = await request('owner');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(await response.text()).toBe('private financial evidence');
    });
    test('a supervisor without deposit permission is rejected', async () => expect((await request('staff', 'SUPERVISOR')).status).toBe(403));
    test('an authorized reviewer can view the receipt', async () => expect((await request('staff', 'SUPERVISOR', ['MANAGE_DEPOSITS'])).status).toBe(200));
});
