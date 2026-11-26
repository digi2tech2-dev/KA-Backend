'use strict';
const fs = require('node:fs');
const path = require('node:path');
const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../package.json'),'utf8'));
test('upgraded Sharp can encode and decode an uploaded image',async()=>{
    const sharp=require('sharp');
    const png=await sharp({create:{width:16,height:12,channels:3,background:'#123456'}}).png().toBuffer();
    const decoded=await sharp(png).raw().toBuffer({resolveWithObject:true});
    expect(decoded.info.width).toBe(16);expect(decoded.info.height).toBe(12);
});
test('upgraded Nodemailer produces an email without network access',async()=>{
    const transport=require('nodemailer').createTransport({streamTransport:true,buffer:true,newline:'unix'});
    const result=await transport.sendMail({from:'sender@example.test',to:'owner@example.test',subject:'Security verification',html:'<p>Verification code: 123456</p>'});
    expect(result.message.toString()).toContain('Verification code: 123456');
});
(manifest.dependencies['firebase-admin']?test:test.skip)('Firebase Admin modular messaging API still initializes without sending',async()=>{
    const {initializeApp,deleteApp}=require('firebase-admin/app');
    const app=initializeApp({projectId:'demo-security-local'},'security-compatibility');
    try {expect(typeof require('firebase-admin/messaging').getMessaging(app).send).toBe('function');}
    finally {await deleteApp(app);}
});
