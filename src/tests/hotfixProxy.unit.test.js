'use strict';
const express = require('express');
const proxyTrust = require('../shared/middlewares/proxyTrust');
describe('Hot fix: spoofed forwarding headers', () => {
    test.each(['true', '1', '*', '0.0.0.0/0', '::/0', '127.0.0.1/99', 'loopback'])('rejects unsafe trust value %s', value => {
        expect(() => proxyTrust(value)).toThrow();
    });
    test('allows explicit proxy addresses', () => {
        expect(proxyTrust('10.10.0.5, 192.168.2.0/24')).toEqual(['10.10.0.5', '192.168.2.0/24']);
    });
    test('ignores forged headers on a direct connection', async () => {
        const app = express();
        app.set('trust proxy', proxyTrust(''));
        app.get('/', (req, res) => res.json({ ip: req.ip }));
        const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const result = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'X-Forwarded-For': '10.99.99.99' } });
            expect((await result.json()).ip).toBe('127.0.0.1');
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
});
