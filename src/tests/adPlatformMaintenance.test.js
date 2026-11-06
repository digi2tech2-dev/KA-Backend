'use strict';

const jwt = require('jsonwebtoken');
const { connectTestDB, disconnectTestDB, clearCollections, createAdmin, createCustomerWithGroup } = require('./testHelpers');
const { Setting } = require('../modules/admin/setting.model');
const theme = require('../modules/theme/theme.validation');
let server;
let url;
beforeAll(async () => { await connectTestDB(); server = require('../app').listen(0); await new Promise((resolve) => server.once('listening', resolve)); url = `http://127.0.0.1:${server.address().port}`; });
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); await disconnectTestDB(); });
beforeEach(clearCollections);
const request = async (path, user, method = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`;
    const response = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
};
test('maintenance persists and protects customer API while active admin can disable it', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup();
    expect((await request('/api/maintenance/status', null, 'PATCH', { enabled: true })).status).toBe(401);
    expect((await request('/api/maintenance/status', customer, 'PATCH', { enabled: true })).status).toBe(403);
    expect((await request('/api/maintenance/status', admin, 'PATCH', { enabled: 'true' })).status).toBe(400);
    expect((await request('/api/maintenance/status', admin, 'PATCH', { enabled: true })).status).toBe(200);
    expect((await Setting.findOne({ key: 'maintenanceMode' }).lean()).value).toBe(true);
    expect((await request('/api/maintenance/status', customer)).body.data.canBypass).toBe(false);
    expect((await request('/api/maintenance/status', admin)).body.data.canBypass).toBe(true);
    expect((await request('/api/orders', customer, 'POST', {})).status).toBe(503);
    expect((await request('/api/deposits', customer, 'POST', {})).status).toBe(503);
    expect((await request('/api/payment-events/vodafone-cash', null, 'POST', {})).body.code).not.toBe('MAINTENANCE_MODE');
    expect((await request('/api/auth/login', null, 'POST', {})).status).not.toBe(503);
    expect((await request('/api/maintenance/status', admin, 'PATCH', { enabled: false })).body.data.enabled).toBe(false);
    expect((await request('/api/maintenance/status')).body.data.enabled).toBe(false);
});
test('all theme presets validate for free and retain independent layouts', () => {
    for (const name of [...theme.FREE_PRESETS, ...theme.PRO_PRESETS]) {
        const configuration = theme.preset(name);
        expect(() => theme.assertPlanAllows(configuration, 'FREE')).not.toThrow();
        const next = theme.validateTheme({ ...configuration, layout: { productsPerRow: 5, categoriesPerRow: 2, productsPerRowMobile: 1, categoriesPerRowMobile: 3 } });
        expect(next.layout).toEqual({ productsPerRow: 5, categoriesPerRow: 2, productsPerRowMobile: 1, categoriesPerRowMobile: 3 });
    }
});
test('admin saves and publishes a free theme and public API returns both color modes and layout', async () => {
    const admin = await createAdmin();
    const configuration = theme.preset('royal');
    configuration.layout.productsPerRowMobile = 1;
    configuration.layout.categoriesPerRowMobile = 3;
    configuration.chrome.modes.dark.header.background = '#123456';
    expect((await request('/api/admin/theme/draft', admin, 'POST', configuration)).status).toBe(200);
    const result = await request('/api/admin/theme/publish', admin, 'POST', configuration);
    expect(result.status).toBe(200);
    const published = await request('/api/theme/published');
    expect(published.body.data.published.layout.productsPerRowMobile).toBe(1);
    expect(published.body.data.published.layout.categoriesPerRowMobile).toBe(3);
    expect(published.body.data.published.chrome.modes.dark.header.background).toBe('#123456');
    expect((await request('/api/admin/theme/history', admin)).body.data.items).toHaveLength(1);
    expect((await request('/api/admin/theme/restore-draft', admin, 'POST', { version: 1 })).body.data.draft.layout.productsPerRowMobile).toBe(1);
    expect((await request('/api/admin/theme/publish', null, 'POST', configuration)).status).toBe(401);
});
test('legacy theme settings gain defaults without losing their saved appearance', () => {
    const old = theme.preset('classic');
    delete old.layout;
    delete old.chrome.modes;
    delete old.modes.light.neon.sidebar;
    delete old.modes.dark.neon.sidebar;
    delete old.modes.light.typography.bodyWeight;
    delete old.modes.dark.typography.bodyWeight;
    const result = theme.validateTheme(old);
    expect(result.modes.light.colors).toEqual(old.modes.light.colors);
    expect(result.modes.light.neon.sidebar.enabled).toBe(false);
    expect(result.modes.light.typography.bodyWeight).toBe(400);
    expect(result.chrome.modes.dark.header).toEqual(result.chrome.header);
});
test('theme schema rejects invalid media, layout and injected colors', () => {
    const value = theme.preset('classic');
    expect(() => theme.validateTheme({ ...value, brand: { ...value.brand, logoPath: 'https://example.com/logo.png' } })).toThrow();
    expect(() => theme.validateTheme({ ...value, layout: { ...value.layout, productsPerRowMobile: 10 } })).toThrow();
    expect(() => theme.validateTheme({ ...value, modes: { ...value.modes, light: { ...value.modes.light, colors: { ...value.modes.light.colors, primary: 'red' } } } })).toThrow();
});
test('contact lists add, edit and delete with revision protection and public refresh', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup();
    const entries = [
        { id: 'one', name: 'Ahmed', role: 'Support', number: '+201012345678' },
        { id: 'two', name: 'Sara', role: 'Manager', number: '+201112345678' },
    ];
    await request('/api/settings/payment'); // Populate the public cache first.
    expect((await request('/api/admin/settings/supportContacts', customer, 'PATCH', { value: { entries, revision: 0 } })).status).toBe(403);
    const added = await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { entries, revision: 0 } });
    expect(added.status).toBe(200);
    expect((await request('/api/settings/payment')).body.data.supportContacts.entries).toEqual(entries);
    const modified = [{ ...entries[1], name: 'Sarah', role: 'Accounts', number: '+201222222222' }];
    const edited = await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { entries: modified, revision: 1 } });
    expect(edited.status).toBe(200);
    expect((await request('/api/settings/payment')).body.data.supportContacts.entries).toEqual(modified);
    expect((await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { entries, revision: 1 } })).status).toBe(409);
    expect((await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { owner: '+201012345678', support: '' } })).status).toBe(409);
    const empty = await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { entries: [], revision: 2 } });
    expect(empty.status).toBe(200);
    expect((await request('/api/settings/payment')).body.data.supportContacts).toMatchObject({ entries: [], revision: 3 });
});
test('simultaneous contact edits cannot overwrite each other', async () => {
    const admin = await createAdmin();
    await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { entries: [], revision: 0 } });
    const item = (id) => ({ id, name: id, role: 'Support', number: '+201012345678' });
    const results = await Promise.all(['first', 'second'].map((id) => request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { entries: [item(id)], revision: 1 } })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await request('/api/settings/payment')).body.data.supportContacts.revision).toBe(2);
});
test('legacy edits advance revision and cannot be replaced by an older list', async () => {
    const admin = await createAdmin();
    const changed = await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { owner: '+201012345678', support: '' } });
    expect(changed.status).toBe(200);
    expect((await request('/api/settings/payment')).body.data.supportContacts.revision).toBe(1);
    expect((await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { entries: [], revision: 0 } })).status).toBe(409);
    expect((await request('/api/admin/settings/supportContacts', admin, 'PATCH', { value: { entries: [], revision: 1 } })).status).toBe(200);
});
