'use strict';
const mongoose=require('mongoose');
const crypto=require('node:crypto');
const express=require('express');
const { User }=require('../modules/users/user.model');
const Group=require('../modules/groups/group.model');
const auth=require('../modules/auth/auth.service');
const email=require('../services/email.service');
const handoff=require('../shared/utils/oauthHandoff');
let server,url,owner;
beforeAll(async()=>{
    await mongoose.connect(process.env.MONGO_TEST_URI);
    const group=await Group.create({name:'OAuth proof group',percentage:10,isActive:true});
    owner=await User.create({name:'OAuth Owner',email:'oauth-proof@example.test',role:'CUSTOMER',status:'ACTIVE',verified:true,isTwoFactorEnabled:true,groupId:group._id,phone:'+201012345678',country:'EG',currency:'USD',profileCompletedAt:new Date()});
    const app=express();app.use(express.json());
    app.post('/exchange',handoff.exchange);
    app.use((error,req,res,next)=>res.status(error.statusCode||500).json({code:error.code}));
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    url=`http://127.0.0.1:${server.address().port}`;
});
afterAll(async()=>{await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();});
afterEach(()=>jest.restoreAllMocks());
const start=async()=>{
    const verifier=crypto.randomBytes(32).toString('base64url');
    const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const state=await handoff.begin({query:{code_challenge:challenge,intent:'signup',referralCode:'ABC123'}});
    const oauthState=await handoff.consumeState(state);
    const code=await handoff.store({oauthState},await User.findById(owner._id));
    return {verifier,code,state};
};
const send=(code,verifier)=>new Promise((resolve,reject)=>{
    const body=JSON.stringify({code,verifier});
    const request=require('node:http').request(url+'/exchange',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
        let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>resolve({status:response.statusCode,json:async()=>JSON.parse(data)}));
    });request.on('error',reject);request.end(body);
});
test('OAuth requires the initiating tab proof, preserves MFA, and consumes state/code once',async()=>{
    jest.spyOn(email,'sendTwoFactorOtpEmail').mockResolvedValue();
    const {code,verifier,state}=await start();
    await expect(handoff.consumeState(state)).rejects.toThrow();
    expect((await send(code)).status).toBe(401);
    expect((await send(code,'x'.repeat(43))).status).toBe(401);
    const responses=await Promise.all([send(code,verifier),send(code,verifier)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,401]);
    const body=await responses.find(r=>r.status===200).json();
    expect(body.data.requires2FA).toBe(true);expect(body.data.token).toBeUndefined();
    expect((await send(code,verifier)).status).toBe(401);
    const records=await handoff.Grant.find().lean();
    expect(JSON.stringify(records)).not.toContain('tempToken');
});
test('changing account permissions revokes a pending OAuth handoff',async()=>{
    const {code,verifier}=await start();
    await User.findByIdAndUpdate(owner._id,{$set:{permissions:['VIEW_USERS']}});
    expect((await send(code,verifier)).status).toBe(401);
});
test('expired grants cannot be exchanged and malformed starts are rejected',async()=>{
    const {code,verifier}=await start();
    await handoff.Grant.updateOne({_id:crypto.createHash('sha256').update(code).digest('hex')},{$set:{expiresAt:new Date(0)}});
    expect((await send(code,verifier)).status).toBe(401);
    await expect(handoff.begin({query:{}})).rejects.toThrow();
});
test('Google can issue an ordinary session only after valid tab proof',async()=>{
    const current=await User.findById(owner._id);current.isTwoFactorEnabled=false;await current.save();
    const {code,verifier}=await start();
    const response=await send(code,verifier);expect(response.status).toBe(200);
    const result=await response.json();expect(typeof result.data.token).toBe('string');
    const payload=require('jsonwebtoken').verify(result.data.token,process.env.JWT_SECRET);
    expect(payload.purpose).toBe('access');
    expect(payload.id).toBe(String(owner._id));
});
