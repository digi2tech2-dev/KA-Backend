'use strict';

const whatsappService = require('./whatsapp.service');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const { getSettingValue } = require('../admin/admin.settings.service');

const getStatus = async (_req, res) => {
    const adminNotificationNumber = await getSettingValue('adminNotificationWhatsApp', process.env.ADMIN_NOTIFICATION_NUMBER || '');
    sendSuccess(
        res,
        whatsappService.getStatus({ adminNotificationNumber: adminNotificationNumber || process.env.ADMIN_NOTIFICATION_NUMBER }),
        'WhatsApp status retrieved'
    );
};

const reconnect = async (_req, res) => {
    await whatsappService.reconnectWhatsAppClient();
    const adminNotificationNumber = await getSettingValue('adminNotificationWhatsApp', process.env.ADMIN_NOTIFICATION_NUMBER || '');
    sendSuccess(res, whatsappService.getStatus({ adminNotificationNumber: adminNotificationNumber || process.env.ADMIN_NOTIFICATION_NUMBER }), 'WhatsApp reconnect triggered');
};

const reset = async (_req, res) => {
    await whatsappService.resetWhatsAppClient();
    const adminNotificationNumber = await getSettingValue('adminNotificationWhatsApp', process.env.ADMIN_NOTIFICATION_NUMBER || '');
    sendSuccess(res, whatsappService.getStatus({ adminNotificationNumber: adminNotificationNumber || process.env.ADMIN_NOTIFICATION_NUMBER }), 'WhatsApp hard reset triggered');
};

module.exports = {
    getStatus,
    reconnect,
    reset,
};
