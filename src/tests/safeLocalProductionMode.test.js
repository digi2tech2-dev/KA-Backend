'use strict';

const originalSafeMode = process.env.SAFE_LOCAL_PRODUCTION_MODE;
const restore = () => {
    if (originalSafeMode === undefined) delete process.env.SAFE_LOCAL_PRODUCTION_MODE;
    else process.env.SAFE_LOCAL_PRODUCTION_MODE = originalSafeMode;
};

afterEach(() => { jest.resetModules(); restore(); });
afterAll(restore);

const loadConfig = (value) => {
    jest.resetModules();
    if (value === undefined) delete process.env.SAFE_LOCAL_PRODUCTION_MODE;
    else process.env.SAFE_LOCAL_PRODUCTION_MODE = value;
    return require('../config/config');
};

describe('SAFE_LOCAL_PRODUCTION_MODE', () => {
    test.each([['true', true], ['false', false], ['TRUE', false], ['1', false], [undefined, false]])(
        'only literal lowercase %p enables safe mode', (value, expected) => {
            expect(loadConfig(value).safeLocalProductionMode).toBe(expected);
        }
    );

    test('skips default settings seeding only when safe mode is enabled', async () => {
        const { startDefaultSettingsSeed } = require('../shared/startup/defaultSettingsSeed');
        const seed = jest.fn().mockResolvedValue();
        expect(startDefaultSettingsSeed({ safeLocalProductionMode: true, seed })).toBe(false);
        expect(seed).not.toHaveBeenCalled();
        expect(startDefaultSettingsSeed({ safeLocalProductionMode: false, seed })).toBe(true);
        await Promise.resolve();
        expect(seed).toHaveBeenCalledTimes(1);
    });

    test('skips schedulers and WhatsApp initialization when enabled', async () => {
        jest.resetModules();
        jest.doMock('../app', () => ({ listen: jest.fn((_port, callback) => { callback(); return { close: jest.fn() }; }) }));
        const { startServer } = require('../server');
        const config = require('../config/config');
        config.safeLocalProductionMode = true;
        const dependencies = {
            appInstance: { listen: jest.fn((_port, callback) => { callback(); return { close: jest.fn() }; }) },
            connectDatabase: jest.fn().mockResolvedValue(),
            fulfillment: { start: jest.fn(), stop: jest.fn() },
            providerSync: { start: jest.fn(), stop: jest.fn() },
            whatsapp: { initializeWhatsAppClient: jest.fn(), destroyWhatsAppClient: jest.fn() },
            registerProcessHandlers: false,
            exitOnFailure: false,
        };
        await startServer(dependencies);
        expect(dependencies.fulfillment.start).not.toHaveBeenCalled();
        expect(dependencies.providerSync.start).not.toHaveBeenCalled();
        expect(dependencies.whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();
    });

    test('keeps legacy scheduler and WhatsApp controls when safe mode is disabled', async () => {
        jest.resetModules();
        jest.doMock('../app', () => ({ listen: jest.fn() }));
        const { startServer } = require('../server');
        const config = require('../config/config');
        config.safeLocalProductionMode = false;
        const dependencies = {
            appInstance: { listen: jest.fn((_port, callback) => { callback(); return { close: jest.fn() }; }) },
            connectDatabase: jest.fn().mockResolvedValue(),
            fulfillment: { start: jest.fn(), stop: jest.fn() },
            providerSync: { start: jest.fn(), stop: jest.fn() },
            whatsapp: { initializeWhatsAppClient: jest.fn().mockResolvedValue(), destroyWhatsAppClient: jest.fn() },
            registerProcessHandlers: false,
            exitOnFailure: false,
        };
        await startServer(dependencies);
        expect(dependencies.fulfillment.start).toHaveBeenCalledTimes(1);
        expect(dependencies.providerSync.start).toHaveBeenCalledTimes(1);
        expect(dependencies.whatsapp.initializeWhatsAppClient).toHaveBeenCalledTimes(1);
    });

    test('makes SMTP delivery a no-op in safe mode', async () => {
        jest.resetModules();
        const sendMail = jest.fn().mockResolvedValue();
        const createTransport = jest.fn(() => ({ sendMail }));
        jest.doMock('nodemailer', () => ({ createTransport }));
        const config = require('../config/config');
        config.safeLocalProductionMode = true;
        const { sendEmail } = require('../services/email.service');
        await sendEmail({ to: 'safe@example.com', subject: 'safe', html: '<p>safe</p>' });
        expect(createTransport).not.toHaveBeenCalled();
        expect(sendMail).not.toHaveBeenCalled();
    });

    test('makes WhatsApp initialization and admin notifications no-ops in safe mode', async () => {
        jest.resetModules();
        const initialize = jest.fn().mockResolvedValue();
        const Client = jest.fn(() => ({ on: jest.fn(), initialize }));
        const LocalAuth = jest.fn();
        jest.doMock('whatsapp-web.js', () => ({ Client, LocalAuth }));
        const config = require('../config/config');
        config.safeLocalProductionMode = true;
        const whatsapp = require('../modules/whatsapp/whatsapp.service');
        await whatsapp.initializeWhatsAppClient();
        await expect(whatsapp.sendAdminNotification('must not send')).resolves.toBeNull();
        expect(Client).not.toHaveBeenCalled();
        expect(initialize).not.toHaveBeenCalled();
    });
});
