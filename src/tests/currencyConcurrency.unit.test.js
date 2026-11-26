'use strict';

jest.mock('../shared/utils/accountTarget', () => jest.fn(async () => {}));

const { User } = require('../modules/users/user.model');
const { Currency } = require('../modules/currency/currency.model');
const adminUsers = require('../modules/admin/admin.users.service');

afterEach(() => jest.restoreAllMocks());

test('currency conversion refuses to overwrite a wallet changed after its balance read', async () => {
    const userId = '507f1f77bcf86cd799439011';
    const user = { _id: userId, currency: 'USD', walletBalance: 100 };
    jest.spyOn(User, 'findById').mockReturnValue({ populate: jest.fn().mockResolvedValue(user) });
    jest.spyOn(Currency, 'findOne').mockResolvedValue({ platformRate: 50, isActive: true });
    const populate = jest.fn().mockResolvedValue(null);
    const update = jest.spyOn(User, 'findOneAndUpdate').mockReturnValue({ populate });

    await expect(adminUsers.updateUserCurrency(userId, 'EGP', '507f1f77bcf86cd799439012'))
        .rejects.toMatchObject({ message: 'Wallet changed during currency conversion. Refresh the account and retry.' });
    expect(update).toHaveBeenCalledWith(
        { _id: userId, currency: { $in: ['USD', null] }, walletBalance: 100 },
        { $set: { currency: 'EGP', walletBalance: 5000 } },
        { new: true }
    );
});
