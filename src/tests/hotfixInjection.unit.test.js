'use strict';
const literal = require('../shared/utils/literalSearch');
const html = require('../shared/utils/escapeHtml');
test('regular expressions supplied in searches are literal and bounded', () => {
    const attack = '(a+)+$';
    expect(new RegExp(literal(attack)).test(attack)).toBe(true);
    expect(new RegExp(literal(attack)).test('aaaaa')).toBe(false);
    expect(literal('a'.repeat(10000))).toHaveLength(128);
});
test('email display names cannot create markup', () => {
    expect(html('<img src=x onerror="steal()">&')).toBe('&lt;img src=x onerror=&quot;steal()&quot;&gt;&amp;');
});
