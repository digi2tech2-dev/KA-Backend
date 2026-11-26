'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { BusinessRuleError } = require('../errors/AppError');
let active = 0;
module.exports = async file => {
    if (active >= 2) throw new BusinessRuleError('Upload processing is busy. Please retry.', 'UPLOAD_BUSY');
    active++;
    try {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.pdf') {
            const data = await fs.readFile(file.path);
            if (file.mimetype !== 'application/pdf' || !/^%PDF-[12]\.\d/.test(data.subarray(0, 16).toString('ascii')) || !data.subarray(-1024).includes(Buffer.from('%%EOF'))) throw new Error('Invalid PDF');
            return;
        }
        if (ext === '.bmp') {
            const data = await fs.readFile(file.path);
            if (data.length < 54 || file.mimetype !== 'image/bmp' || data.subarray(0, 2).toString() !== 'BM') throw new Error('Invalid bitmap');
            const width = data.readInt32LE(18), height = Math.abs(data.readInt32LE(22));
            const bits = data.readUInt16LE(28), offset = data.readUInt32LE(10);
            const row = Math.ceil(width * bits / 32) * 4;
            if (width < 1 || height < 1 || width * height > 16_000_000 || ![24, 32].includes(bits)
                || data.readUInt16LE(26) !== 1 || data.readUInt32LE(30) !== 0 || offset < 54
                || offset + row * height > data.length || data.readUInt32LE(2) !== data.length) throw new Error('Invalid bitmap');
            return;
        }
        if (ext === '.bmp') {
            const data = await fs.readFile(file.path);
            if (data.length < 54 || file.mimetype !== 'image/bmp' || data.subarray(0, 2).toString() !== 'BM') throw new Error('Invalid bitmap');
            const width = data.readInt32LE(18), height = Math.abs(data.readInt32LE(22));
            const bits = data.readUInt16LE(28), offset = data.readUInt32LE(10);
            const row = Math.ceil(width * bits / 32) * 4;
            if (width < 1 || height < 1 || width * height > 16_000_000 || ![24, 32].includes(bits)
                || data.readUInt16LE(26) !== 1 || data.readUInt32LE(30) !== 0 || offset < 54
                || offset + row * height > data.length || data.readUInt32LE(2) !== data.length) throw new Error('Invalid bitmap');
            return;
        }
        const formats = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.gif': 'gif' };
        const image = sharp(file.path, { failOn: 'error', limitInputPixels: 16_000_000 });
        const info = await image.metadata();
        if (!formats[ext] || formats[ext] !== info.format || file.mimetype !== `image/${info.format}`
            || !info.width || !info.height || info.width * info.height * (info.pages || 1) > 16_000_000) throw new Error('Invalid image');
        await image.stats();
    } catch {
        throw new BusinessRuleError('Uploaded content does not match its declared file format.', 'INVALID_FILE_CONTENT');
    } finally { active--; }
};
