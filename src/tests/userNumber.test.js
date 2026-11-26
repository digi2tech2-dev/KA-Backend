'use strict';

jest.mock('../modules/groups/group.service', () => ({
    getHighestPercentageGroup: jest.fn(async () => ({ _id: '507f1f77bcf86cd799439011' })),
}));
jest.mock('../modules/audit/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('../services/email.service', () => ({ sendVerificationEmail: jest.fn(async () => {}) }));

const { User, ROLES } = require('../modules/users/user.model');
const { Counter } = require('../modules/orders/counter.model');
const resolveUserNumber = require('../shared/middlewares/resolveUserNumber');

let sequence;
let persisted;
beforeEach(() => {
    sequence = 99;
    persisted = [];
    jest.spyOn(Counter, 'findById').mockResolvedValue({ _id: 'customerUserNumber' });
    jest.spyOn(Counter, 'findByIdAndUpdate').mockImplementation(async (name, update) => {
        expect(name).toBe('customerUserNumber');
        expect(update).toEqual({ $inc: { seq: 1 } });
        return { seq: ++sequence };
    });
    jest.spyOn(User.collection, 'insertOne').mockImplementation(async (doc) => {
        persisted.push(doc);
        return { acknowledged: true, insertedId: doc._id };
    });
    jest.spyOn(User.collection, 'updateOne').mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
});
afterEach(() => jest.restoreAllMocks());

let serial = 0;
const customer = (extra = {}) => new User({ name: 'Test Customer', email: `number-${++serial}@example.com`, groupId: '507f1f77bcf86cd799439011', ...extra });

test('new customer IDs start at 100, with no numbers consumed by staff', async () => {
    await customer({ role: ROLES.ADMIN }).save();
    await customer({ role: ROLES.SUPERVISOR }).save();
    const first = await customer().save();
    const second = await customer().save();
    expect([first.userNumber, second.userNumber]).toEqual([100, 101]);
    expect(first.toJSON().id).toBe(100);
    expect(first.toSafeObject().id).toBe(100);
    expect(first.toJSON()._id.toString()).toBe(first._id.toString());
    expect(first.id).toBe(first._id.toString()); // Internal code keeps ObjectId identity.
    expect(persisted.slice(0, 2).every(doc => doc.userNumber === undefined)).toBe(true);
});

test('initializes the sequence at 99, returning 100 for its first allocation', async () => {
    Counter.findById.mockResolvedValue(null);
    const create = jest.spyOn(Counter, 'create').mockResolvedValue({ _id: 'customerUserNumber', seq: 99 });
    const first = await customer().save();
    expect(create).toHaveBeenCalledWith({ _id: 'customerUserNumber', seq: 99 });
    expect(first.userNumber).toBe(100);
});

test('concurrent registrations use the shared atomic increment', async () => {
    const customers = await Promise.all(Array.from({ length: 40 }, () => customer().save()));
    const numbers = customers.map(user => user.userNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 40 }, (_, i) => 100 + i));
    expect(new Set(numbers).size).toBe(40);
});

test('validation failures do not allocate an ID', async () => {
    await expect(customer({ email: 'invalid' }).save()).rejects.toThrow();
    expect(Counter.findByIdAndUpdate).not.toHaveBeenCalled();
});

test('numbers are assigned by the server rather than provided by a client', async () => {
    const user = await customer({ userNumber: 999 }).save();
    expect(user.userNumber).toBe(100);
});

test('profile changes and attempted renumbering do not change an allocated ID', async () => {
    const user = await customer().save();
    user.name = 'Updated Customer';
    user.userNumber = 500;
    await user.save();
    expect(user.userNumber).toBe(100);
    expect(Counter.findByIdAndUpdate).toHaveBeenCalledTimes(1);
});

test('deactivating a customer does not recycle their ID', async () => {
    const first = await customer().save();
    first.deletedAt = new Date();
    await first.save();
    expect((await customer().save()).userNumber).toBe(101);
});

test('the number index is unique and sparse, allowing multiple staff without numbers', () => {
    expect(User.schema.indexes()).toEqual(expect.arrayContaining([
        [expect.objectContaining({ userNumber: 1 }), expect.objectContaining({ unique: true, sparse: true })],
    ]));
});

test('bulk inserts allocate customer numbers and skip staff', async () => {
    jest.spyOn(User.collection, 'insertMany').mockImplementation(async (docs) => {
        persisted.push(...docs);
        return { acknowledged: true, insertedCount: docs.length, insertedIds: docs.map(doc => doc._id) };
    });
    const users = await User.insertMany([
        { groupId: '507f1f77bcf86cd799439011', name: 'Bulk Admin', email: 'bulk-admin@example.com', role: ROLES.ADMIN },
        { groupId: '507f1f77bcf86cd799439011', name: 'Bulk One', email: 'bulk-one@example.com' },
        { groupId: '507f1f77bcf86cd799439011', name: 'Bulk Two', email: 'bulk-two@example.com' },
    ]);
    expect(users.map(user => user.userNumber)).toEqual([undefined, 100, 101]);
});

test('numeric route ID resolves to the original ObjectId before service calls', async () => {
    const _id = customer()._id;
    const find = jest.spyOn(User, 'findOne').mockReturnValue({ select: async () => ({ _id }) });
    const req = { params: { id: '100' } };
    const next = jest.fn();
    await resolveUserNumber()(req, {}, next);
    expect(find).toHaveBeenCalledWith({ userNumber: 100 });
    expect(req.params.id).toBe(_id.toString());
    expect(next).toHaveBeenCalledWith();
});

test.each(['abcdef1234567890abcdef12', '123456789012345678901234'])(
    'legacy ObjectId route stays supported: %s', async (id) => {
        const find = jest.spyOn(User, 'findOne');
        const req = { params: { id } };
        const next = jest.fn();
        await resolveUserNumber()(req, {}, next);
        expect(req.params.id).toBe(id);
        expect(find).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith();
    }
);

test.each(['99', '99999999999999999', '999'])(
    'unknown or invalid customer number returns a controlled 404: %s', async (id) => {
        jest.spyOn(User, 'findOne').mockReturnValue({ select: async () => null });
        const next = jest.fn();
        await resolveUserNumber()({ params: { id } }, {}, next);
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
    }
);

test('email and Google registrations share the customer sequence', async () => {
    jest.spyOn(User, 'findOne').mockResolvedValue(null);
    const { register } = require('../modules/auth/auth.service');
    const { resolveGoogleUser } = require('../modules/auth/googleOAuth.service');
    const emailResult = await register({ name: 'Email Customer', email: 'email@example.com', password: 'Test-password-123' });
    const googleResult = await resolveGoogleUser({ id: 'google-test-id', email: 'google@example.com', displayName: 'Google Customer' });
    expect(emailResult.user.id).toBe(100);
    expect(googleResult.user.toSafeObject().id).toBe(101);
    expect(persisted.map(doc => doc.userNumber)).toEqual([100, 101]);
});

test('admin search finds customers by number and allows numeric ordering', async () => {
    const { schemas } = require('../modules/admin/admin.validation');
    expect(schemas.listUsersQuery.validate({ search: '100', sortBy: 'userNumber', sortOrder: 'asc' }).error).toBeUndefined();
    const query = {};
    for (const method of ['select', 'populate', 'sort', 'skip']) query[method] = jest.fn(() => query);
    query.limit = jest.fn(async () => []);
    const find = jest.spyOn(User, 'find').mockReturnValue(query);
    jest.spyOn(User, 'countDocuments').mockResolvedValue(0);
    await require('../modules/admin/admin.users.service').listUsers({ search: '100', sortBy: 'userNumber', sortOrder: 'asc' });
    expect(find.mock.calls[0][0].$or).toContainEqual({ userNumber: 100 });
    expect(query.sort).toHaveBeenCalledWith({ userNumber: 1 });
});

test.each(['query', 'body'])('numeric userId in %s resolves without changing unrelated fields', async (source) => {
    const _id = customer()._id;
    jest.spyOn(User, 'findOne').mockReturnValue({ select: async () => ({ _id }) });
    const req = { [source]: { userId: 100, otherId: 'unchanged' } };
    const next = jest.fn();
    await resolveUserNumber('userId', source)(req, {}, next);
    expect(req[source]).toEqual({ userId: _id.toString(), otherId: 'unchanged' });
    expect(next).toHaveBeenCalledWith();
});

test('user routes accept numeric IDs and retain authentication and permission checks', async () => {
    const express = require('express');
    const http = require('http');
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const admin = customer({ role: ROLES.ADMIN, status: 'ACTIVE', verified: true });
    const target = customer({ userNumber: 100, status: 'ACTIVE', verified: true });
    jest.spyOn(User, 'findById').mockImplementation((id) => String(id) === admin._id.toString()
        ? Promise.resolve(admin)
        : { select: () => ({ populate: async () => target }) });
    const find = jest.spyOn(User, 'findOne').mockReturnValue({ select: async () => ({ _id: target._id }) });
    const app = express();
    app.use('/api/users', require('../modules/users/user.routes'));
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const get = (token) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/users/100',
            headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
    });
    try {
        expect((await get()).status).toBe(401);
        expect(find).not.toHaveBeenCalled();
        const token = jwt.sign({ id: admin._id.toString(), role: 'ADMIN' }, config.jwt.secret);
        const result = await get(token);
        expect(result.status).toBe(200);
        expect(result.body.data.id).toBe(100);
        expect(result.body.data._id).toBe(target._id.toString());
        expect(find).toHaveBeenCalledWith({ userNumber: 100 });
        find.mockClear();
        const customerToken = jwt.sign({ id: target._id.toString(), role: 'CUSTOMER' }, config.jwt.secret);
        User.findById.mockResolvedValueOnce(target);
        expect((await get(customerToken)).status).toBe(403);
        expect(find).not.toHaveBeenCalled();
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
