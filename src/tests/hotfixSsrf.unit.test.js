'use strict';
const dns = require('node:dns');
const policy = require('../shared/utils/safeProviderHttp');
afterEach(() => jest.restoreAllMocks());
test.each(['http://example.com','https://127.0.0.1','https://0x7f000001','https://[::1]','https://user:pass@example.com','https://localhost','https://host.internal','https://example.com:8443'])('blocks forbidden destination %s', value => expect(() => policy.parseDestination(value)).toThrow());
test.each(['127.0.0.1','10.1.2.3','169.254.169.254','100.64.1.1','198.18.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])('blocks private or reserved address %s', value => expect(policy.publicAddress(value)).toBe(false));
test('accepts public service addresses', () => {
    expect(policy.publicAddress('8.8.8.8')).toBe(true);
    expect(policy.publicAddress('2606:4700:4700::1111')).toBe(true);
});
test('rejects mixed DNS answers at connection time', async () => {
    jest.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => callback(null,[{ address:'8.8.8.8',family:4 },{address:'127.0.0.1',family:4}]));
    await expect(new Promise((resolve,reject) => policy.safeLookup('example.com',{},(error,value) => error?reject(error):resolve(value)))).rejects.toMatchObject({ code:'OUTBOUND_DESTINATION_DENIED' });
});
