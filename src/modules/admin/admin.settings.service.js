'use strict';

/**
 * admin.settings.service.js
 *
 * CRUD over the Setting collection.
 * Only admins can write. Reads can be used internally.
 */

const { Setting } = require('./setting.model');
const { NotFoundError, ValidationError, ConflictError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const settingsCache = require('./settings.cache');
const THEME_CONTACT_SETTING_KEYS = new Set(['supportContacts', 'adminNotificationWhatsApp']);
const normalizePhone = (value, allowEmpty = false) => {
    const phone = String(value || '').trim();
    if (allowEmpty && !phone) return '';
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new ValidationError('WhatsApp numbers must use international format, for example +201234567890.');
    return phone;
};

const PAYMENT_SETTING_KEYS = new Set([
    'paymentGroups',
    'paymentCountryAccounts',
    'paymentInstructions',
    'whatsappNumber',
    'supportContacts',
]);

// ─── List ──────────────────────────────────────────────────────────────────────

const listSettings = async () => {
    return Setting.find().sort({ key: 1 }).select('-__v');
};

// ─── Get One ──────────────────────────────────────────────────────────────────

const getSettingByKey = async (key) => {
    const setting = await Setting.findOne({ key });
    if (!setting) throw new NotFoundError('Setting');
    return setting;
};

// ─── Get value (internal use) ─────────────────────────────────────────────────

const getSettingValue = async (key, defaultValue = null) => {
    const setting = await Setting.findOne({ key }).lean();
    return setting ? setting.value : defaultValue;
};

const getPaymentSettings = async () => {
    const cacheKey = settingsCache.SETTINGS_CACHE_KEYS.paymentGroups;
    const cached = settingsCache.get(cacheKey);
    if (cached) {
        // Contact edits may come from another backend process; never serve its
        // cached copy indefinitely after another instance changes the list.
        const contacts = await Setting.findOne({ key: 'supportContacts' }).select('value').lean();
        return { ...cached, supportContacts: contacts?.value || { owner: '', support: '' } };
    }

    const keys = [...PAYMENT_SETTING_KEYS];
    const settings = await Setting.find({ key: { $in: keys } }).lean();
    const find = (key) => settings.find((s) => s.key === key)?.value;

    const paymentGroups = (find('paymentGroups') || [])
        .filter((g) => g.isActive !== false)
        .map((g) => ({
            ...g,
            methods: (g.methods || []).filter((m) => m.isActive !== false),
        }))
        .filter((g) => g.methods && g.methods.length > 0);

    const payload = {
        paymentGroups,
        countryAccounts: find('paymentCountryAccounts') || [],
        instructions: find('paymentInstructions') || '',
        whatsappNumber: find('whatsappNumber') || '',
        supportContacts: find('supportContacts') || { owner: '', support: '' },
    };

    return settingsCache.set(cacheKey, payload);
};

const invalidateSettingsCache = (key) => {
    if (!key) {
        settingsCache.clear();
        return;
    }

    if (PAYMENT_SETTING_KEYS.has(key)) {
        settingsCache.del(settingsCache.SETTINGS_CACHE_KEYS.paymentGroups);
    }
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateSetting = async (key, value, adminId) => {
    if (key === 'maintenanceMode' && typeof value !== 'boolean') {
        throw new ValidationError('Maintenance status must be a boolean.');
    }
    if (key === 'supportContacts' && Array.isArray(value?.entries)) {
        if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.entries.length > 30) throw new ValidationError('Invalid contact list revision or size.');
        const ids = new Set();
        const entries = value.entries.map((item) => {
            const id = String(item?.id || '').trim();
            const name = String(item?.name || '').trim();
            const role = String(item?.role || '').trim();
            if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id) || !name || name.length > 80 || !role || role.length > 80) {
                throw new ValidationError('Each contact needs a unique ID, name and role (up to 80 characters).');
            }
            ids.add(id);
            return { id, name, role, number: normalizePhone(item.number) };
        });
        const nextValue = { entries, revision: value.revision + 1, owner: entries[0]?.number || '', support: entries[1]?.number || '' };
        let setting = await Setting.findOne({ key }).lean();
        if (!setting) {
            if (value.revision !== 0) throw new ConflictError('Contacts changed. Reload before saving.');
            try { setting = await Setting.create({ key, value: nextValue, updatedBy: adminId, description: 'Public WhatsApp contact numbers' }); }
            catch (error) { if (error.code === 11000) throw new ConflictError('Contacts changed. Reload before saving.'); throw error; }
        } else {
            const filter = { _id: setting._id, ...(value.revision === 0
                ? { $or: [{ 'value.revision': { $exists: false } }, { 'value.revision': 0 }] }
                : { 'value.revision': value.revision }) };
            setting = await Setting.findOneAndUpdate(filter, { $set: { value: nextValue, updatedBy: adminId } }, { new: true, runValidators: true });
            if (!setting) throw new ConflictError('Contacts changed. Reload before saving.');
        }
        invalidateSettingsCache(key);
        createAuditLog({ actorId: adminId, actorRole: ACTOR_ROLES.ADMIN, action: ADMIN_ACTIONS.SETTING_UPDATED,
            entityType: ENTITY_TYPES.SETTING, entityId: setting._id, metadata: { key, before: '[REDACTED]', after: '[REDACTED]' } });
        return setting;
    }
    if (key === 'supportContacts') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid support contacts.');
        const legacy = { owner: normalizePhone(value.owner, true), support: normalizePhone(value.support, true) };
        let setting = await Setting.findOneAndUpdate({ key, 'value.entries': { $exists: false } },
            { $set: { 'value.owner': legacy.owner, 'value.support': legacy.support, updatedBy: adminId }, $inc: { 'value.revision': 1 } }, { new: true, runValidators: true });
        if (!setting) {
            if (await Setting.exists({ key })) throw new ConflictError('Contacts are managed in the updated editor. Reload before saving.');
            try { setting = await Setting.create({ key, value: { ...legacy, revision: 1 }, updatedBy: adminId, description: 'Public WhatsApp contact numbers' }); }
            catch (error) { if (error.code === 11000) throw new ConflictError('Contacts changed. Reload before saving.'); throw error; }
        }
        invalidateSettingsCache(key);
        createAuditLog({ actorId: adminId, actorRole: ACTOR_ROLES.ADMIN, action: ADMIN_ACTIONS.SETTING_UPDATED,
            entityType: ENTITY_TYPES.SETTING, entityId: setting._id, metadata: { key, before: '[REDACTED]', after: '[REDACTED]' } });
        return setting;
    }
    if (THEME_CONTACT_SETTING_KEYS.has(key)) {
        if (key === 'supportContacts') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Support contacts must include owner and support WhatsApp numbers.');
            value = { owner: normalizePhone(value.owner, true), support: normalizePhone(value.support, true) };
        } else {
            value = normalizePhone(value, true);
        }
    }
    let setting = await Setting.findOne({ key });
    if (!setting && THEME_CONTACT_SETTING_KEYS.has(key)) {
        setting = await Setting.create({ key, value, description: key === 'supportContacts' ? 'Public WhatsApp contact numbers' : 'Admin notification WhatsApp recipient' });
        setting.updatedBy = adminId;
    }
    if (!setting) throw new NotFoundError('Setting');

    const before = setting.value;

    // Mongoose does not detect mutations to Mixed-type fields.
    // Without markModified(), `.save()` silently skips the write.
    setting.value = value;
    setting.updatedBy = adminId;
    setting.markModified('value');
    await setting.save();

    invalidateSettingsCache(key);

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SETTING_UPDATED,
        entityType: ENTITY_TYPES.SETTING,
        entityId: setting._id,
        metadata: { key, before: THEME_CONTACT_SETTING_KEYS.has(key) ? '[REDACTED]' : before, after: THEME_CONTACT_SETTING_KEYS.has(key) ? '[REDACTED]' : value },
    });

    return setting;
};

module.exports = {
    listSettings,
    getSettingByKey,
    getSettingValue,
    getPaymentSettings,
    invalidateSettingsCache,
    updateSetting,
};
