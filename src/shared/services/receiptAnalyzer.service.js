'use strict';

const config = require('../../config/config');

let sharp;
try {
    // Optional at module-load time so the server can still boot with a clear error path.
    sharp = require('sharp');
} catch (_) {
    sharp = null;
}

const DEFAULT_OCR_LANGUAGE = 'eng+ara';
let activeOcrWorkers = 0;

const ensureBuffer = (value) => Buffer.isBuffer(value) && value.length > 0;

const average = (values = []) => {
    if (!Array.isArray(values) || values.length === 0) return 0;
    return values.reduce((sum, current) => sum + Number(current || 0), 0) / values.length;
};

const withTimeout = async (promise, timeoutMs) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`OCR_TIMEOUT_${timeoutMs}MS`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
};

const resolveSettings = (overrides = {}) => {
    return {
        ...config.receiptAnalyzer,
        ...overrides,
        ocrKeywords: Array.isArray(overrides.ocrKeywords) && overrides.ocrKeywords.length > 0
            ? overrides.ocrKeywords
            : config.receiptAnalyzer.ocrKeywords,
    };
};

const analyzeIntegrityAndBlankness = async (imageBuffer, settings) => {
    if (!sharp) {
        return {
            isValid: false,
            reason: 'SHARP_NOT_AVAILABLE',
            details: 'sharp dependency is not installed',
        };
    }

    if (!ensureBuffer(imageBuffer)) {
        return {
            isValid: false,
            reason: 'EMPTY_OR_INVALID_BUFFER',
        };
    }

    try {
        const image = sharp(imageBuffer, {
            failOn: 'error',
            limitInputPixels: settings.maxInputPixels,
        });

        const [metadata, stats] = await Promise.all([
            image.metadata(),
            image.stats(),
        ]);

        if (!metadata?.format || !metadata?.width || !metadata?.height) {
            return {
                isValid: false,
                reason: 'INVALID_IMAGE_METADATA',
            };
        }

        const channels = (stats?.channels || []).slice(0, 3);
        if (channels.length === 0) {
            return {
                isValid: false,
                reason: 'NO_COLOR_CHANNEL_STATS',
            };
        }

        const means = channels.map((channel) => Number(channel?.mean || 0));
        const stdDevs = channels.map((channel) => Number(channel?.stdev || 0));
        const entropy = Number(stats?.entropy || 0);
        const avgStdDev = average(stdDevs);

        const isSolidBlack =
            Math.max(...means) <= settings.blackMeanMax &&
            avgStdDev <= settings.solidStdDevMax;

        const isSolidWhite =
            Math.min(...means) >= settings.whiteMeanMin &&
            avgStdDev <= settings.solidStdDevMax;

        const isLowEntropyBlankLike =
            entropy < settings.minEntropy &&
            avgStdDev <= settings.lowEntropyStdDevMax;

        if (isSolidBlack) {
            return {
                isValid: false,
                reason: 'SOLID_BLACK_IMAGE',
                metrics: { entropy, avgStdDev, means },
            };
        }

        if (isSolidWhite) {
            return {
                isValid: false,
                reason: 'SOLID_WHITE_IMAGE',
                metrics: { entropy, avgStdDev, means },
            };
        }

        if (isLowEntropyBlankLike) {
            return {
                isValid: false,
                reason: 'LOW_ENTROPY_IMAGE',
                metrics: { entropy, avgStdDev, means },
            };
        }

        return {
            isValid: true,
            metadata: {
                format: metadata.format,
                width: metadata.width,
                height: metadata.height,
            },
            metrics: {
                entropy,
                avgStdDev,
            },
        };
    } catch (error) {
        return {
            isValid: false,
            reason: 'CORRUPTED_OR_UNSUPPORTED_IMAGE',
            details: error.message,
        };
    }
};

const runOptionalOcrValidation = async (imageBuffer, settings) => {
    if (!settings.enableOcr) {
        return {
            skipped: true,
            reason: 'OCR_DISABLED',
            isValid: true,
        };
    }

    let tesseract;
    try {
        tesseract = require('tesseract.js');
    } catch (_) {
        return {
            skipped: true,
            reason: 'OCR_LIBRARY_NOT_INSTALLED',
            isValid: false,
        };
    }

    const maxConcurrent = Math.max(1, Math.floor(Number(settings.ocrMaxConcurrent) || 2));
    if (activeOcrWorkers >= maxConcurrent) {
        return { skipped: false, isValid: false, reason: 'OCR_CAPACITY_EXCEEDED' };
    }

    activeOcrWorkers += 1;
    let worker;
    try {
        const preparedBuffer = await sharp(imageBuffer)
            .resize({ width: settings.ocrResizeWidth, withoutEnlargement: true })
            .grayscale()
            .normalize()
            .png()
            .toBuffer();

        if (typeof tesseract.createWorker !== 'function') {
            return {
                skipped: false,
                reason: 'OCR_RECOGNIZER_NOT_AVAILABLE',
                isValid: false,
            };
        }

        worker = await tesseract.createWorker(DEFAULT_OCR_LANGUAGE, 1, { logger: () => {} });
        const ocrResult = await withTimeout(worker.recognize(preparedBuffer), settings.ocrTimeoutMs);

        const extractedText = String(ocrResult?.data?.text || '').trim();
        const normalizedText = extractedText.toLowerCase();
        const matchedKeywords = (settings.ocrKeywords || [])
            .filter((keyword) => normalizedText.includes(String(keyword || '').toLowerCase()));

        if (matchedKeywords.length < settings.ocrMinKeywordMatches) {
            return {
                skipped: false,
                isValid: false,
                reason: 'OCR_KEYWORDS_MISSING',
                matchedKeywords,
            };
        }

        return {
            skipped: false,
            isValid: true,
            matchedKeywords,
        };
    } catch (error) {
        return {
            skipped: false,
            reason: String(error?.message || '').startsWith('OCR_TIMEOUT_') ? 'OCR_TIMEOUT' : 'OCR_RUNTIME_FAILED',
            isValid: false,
        };
    } finally {
        if (worker) await worker.terminate().catch(() => {});
        activeOcrWorkers -= 1;
    }
};

const analyzeReceiptBuffer = async (imageBuffer, overrides = {}) => {
    const settings = resolveSettings(overrides);

    const integrityResult = await analyzeIntegrityAndBlankness(imageBuffer, settings);
    if (!integrityResult.isValid) {
        return integrityResult;
    }

    const ocrResult = await runOptionalOcrValidation(imageBuffer, settings);
    if (!ocrResult.isValid) {
        return ocrResult;
    }

    return {
        isValid: true,
        metadata: integrityResult.metadata || null,
        metrics: integrityResult.metrics || null,
        ocr: ocrResult,
    };
};

module.exports = {
    analyzeReceiptBuffer,
};
