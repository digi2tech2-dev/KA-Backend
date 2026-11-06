'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const theme = require('../modules/theme/theme.service');
let standalone;
beforeAll(async () => {
    standalone = await MongoMemoryServer.create();
    await mongoose.connect(standalone.getUri());
});
afterAll(async () => { await mongoose.disconnect(); await standalone.stop(); });
test('standalone cannot use transaction-based theme publishing', async () => {
    const result = await mongoose.connection.db.admin().command({ hello: 1 });
    expect(result.setName).toBeUndefined();
    await expect(theme.publish(new mongoose.Types.ObjectId(), theme.presets()[0].configuration))
        .rejects.toMatchObject({ code: 20 });
});
