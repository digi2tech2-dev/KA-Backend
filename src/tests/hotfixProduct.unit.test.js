'use strict';
const sanitize = require('../shared/utils/customerProduct');
test('customer catalog strips provider costs and credentials without changing the source', () => {
    const product = { name: 'Card', basePrice: 5, finalPrice: 7, costPrice: 3, providerPrice: 3, provider: { apiKey: 'secret' }, providerMapping: { key: 'private' }, rawPayload: { token: 'private' }, showAccountNumber: false, displayAccountNumber: 'hidden' };
    const result = sanitize(product, 9);
    expect(result).toEqual({ name: 'Card', basePrice: 9, finalPrice: 9, showAccountNumber: false, displayAccountNumber: null });
    expect(product.provider.apiKey).toBe('secret');
    expect(product.basePrice).toBe(5);
});
