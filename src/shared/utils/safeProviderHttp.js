'use strict';
const axios = require('axios');
const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const { BusinessRuleError } = require('../errors/AppError');
const denied = () => new BusinessRuleError('Outbound destination is not permitted.', 'OUTBOUND_DESTINATION_DENIED');
const blocked4 = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked4.addSubnet(address,prefix,'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::',3,'ipv6');
const blocked6 = new net.BlockList();
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked6.addSubnet(address,prefix,'ipv6');
const publicAddress = address => net.isIP(address) === 4 ? !blocked4.check(address,'ipv4')
    : net.isIP(address) === 6 && global6.check(address,'ipv6') && !blocked6.check(address,'ipv6');
const parseDestination = raw => {
    let url;
    try { url = new URL(raw); } catch { throw denied(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
        || net.isIP(url.hostname.replace(/^\[|\]$/g,'')) || url.hostname.endsWith('.') || !url.hostname.includes('.')
        || /\.(local|internal|localhost)$/i.test(url.hostname)) throw denied();
    return url;
};
const safeLookup = (hostname, options, callback) => {
    let finished = false;
    const done = (...args) => { if (!finished) { finished=true; clearTimeout(timer); callback(...args); } };
    const timer = setTimeout(() => done(denied()), 5000);
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error || !addresses?.length || addresses.some(value => !publicAddress(value.address))) return done(denied());
        const candidates = options?.family ? addresses.filter(value => value.family === options.family) : addresses;
        if (!candidates.length) return done(denied());
        return options?.all ? done(null,candidates) : done(null,candidates[0].address,candidates[0].family);
    });
};
const create = defaults => {
    const client = axios.create(defaults);
    client.interceptors.request.use(request => {
        const base = parseDestination(defaults.baseURL);
        const target = parseDestination(client.getUri(request));
        const allowed = String(process.env.SUPPLIER_TRUSTED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(value => parseDestination(value).origin);
        if (target.origin !== base.origin || (process.env.NODE_ENV === 'production' && !allowed.includes(target.origin))) throw denied();
        Object.assign(request, { proxy:false, maxRedirects:0, timeout:Math.min(Number(request.timeout)||20000,180000),
            httpsAgent:new https.Agent({ keepAlive:false, rejectUnauthorized:true, lookup:safeLookup }), lookup:safeLookup,
            maxContentLength:8*1024*1024, maxBodyLength:1024*1024, socketPath:undefined, transport:undefined, adapter:'http' });
        return request;
    });
    return client;
};
module.exports = { create, parseDestination, publicAddress, safeLookup };
