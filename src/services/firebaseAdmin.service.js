'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const config = require('../config/config');

let missingConfigurationWarned = false;
let initializationWarned = false;

const getFirebaseApp = () => {
    const { projectId, clientEmail, privateKey } = config.firebase;
    if (!projectId || !clientEmail || !privateKey) {
        if (!missingConfigurationWarned) {
            missingConfigurationWarned = true;
            console.warn('[Push] Firebase Admin is not configured; push delivery is disabled.');
        }
        return null;
    }

    try {
        return getApps()[0] || initializeApp({
            credential: cert({ projectId, clientEmail, privateKey }),
            projectId,
        });
    } catch (error) {
        if (!initializationWarned) {
            initializationWarned = true;
            console.warn('[Push] Firebase Admin initialization failed:', error.message);
        }
        return null;
    }
};

module.exports = { getFirebaseApp };
