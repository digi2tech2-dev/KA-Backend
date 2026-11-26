'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-unit-test-secret-only-2026';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/never-connect-unit-tests';
const { User } = require('../modules/users/user.model');
const auth = require('../shared/middlewares/resellerAuth');
const { digest } = require('../shared/utils/apiTokenIndex');
afterEach(() => jest.restoreAllMocks());
test('unknown API tokens trigger a single indexed lookup and no bcrypt account scan', async () => {
    const scan = jest.spyOn(User, 'find');
    const lookup = jest.spyOn(User, 'findOne').mockReturnValue({ select: () => ({ populate: async () => null }) });
    const req = { get: key => key === 'x-api-key' ? 'unknown-token' : undefined };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await auth(req, res, jest.fn());
    expect(scan).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ apiTokenLookupHash: digest('unknown-token') }));
    expect(res.status).toHaveBeenCalledWith(401);
});
