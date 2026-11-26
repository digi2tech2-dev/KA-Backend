'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-unit-test-secret-only-2026';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/never-connect-unit-tests';
const fs = require('node:fs/promises');
const express = require('express');
const sharp = require('sharp');
const { createUpload } = require('../shared/middlewares/upload');
test('upload factory rejects disguised executable content and accepts decoded images', async () => {
    const app = express();
    const published = [];
    app.post('/', createUpload('avatars').single('image'), (req, res) => {
        published.push(req.file.path); res.status(201).json({ ok: true });
    });
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ code: error.code }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
        const fake = new FormData(); fake.append('image', new Blob(['<script>steal()</script>'], { type: 'image/png' }), 'fake.png');
        const rejected = await fetch(url, { method: 'POST', body: fake });
        expect(rejected.status).toBe(422);
        expect((await rejected.json()).code).toBe('INVALID_FILE_CONTENT');
        const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
        const good = new FormData(); good.append('image', new Blob([png], { type: 'image/png' }), 'real.png');
        expect((await fetch(url, { method: 'POST', body: good })).status).toBe(201);
        expect(published).toHaveLength(1);
    } finally {
        await new Promise(resolve => server.close(resolve));
        for (const file of published) await fs.unlink(file);
    }
});
