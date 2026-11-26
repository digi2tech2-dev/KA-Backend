'use strict';
const mongoose=require('mongoose');
const express=require('express');
const {User}=require('../modules/users/user.model');
const Group=require('../modules/groups/group.model');
const email=require('../services/email.service');
const mfa=require('../shared/utils/googleMfaDisable');
let server,url,user,other,sent;
beforeAll(async()=>{
    await mongoose.connect(process.env.MONGO_TEST_URI);await mfa.Proof.init();
    const group=await Group.create({name:'Google MFA disable',percentage:10,isActive:true});
    const base={name:'Google Owner',googleId:'google-owner',role:'CUSTOMER',status:'ACTIVE',verified:true,isTwoFactorEnabled:true,groupId:group._id,phone:'+201012345678',country:'EG',currency:'USD',profileCompletedAt:new Date()};
    user=await User.create({...base,email:'disable-proof@example.test'});
    other=await User.create({...base,email:'disable-other@example.test',googleId:'google-other'});
    const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={_id:req.headers['x-test-user']||user._id};next();});
    app.post('/request',mfa.request);app.post('/confirm',mfa.confirm);
    app.use((error,req,res,next)=>res.status(error.statusCode||500).json({code:error.code}));
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});url=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(async()=>{
    sent=[];jest.spyOn(email,'sendEmail').mockImplementation(async body=>sent.push(body));
    await mfa.Proof.deleteMany({});await User.findByIdAndUpdate(user._id,{$set:{isTwoFactorEnabled:true}});
});
afterEach(()=>jest.restoreAllMocks());
afterAll(async()=>{await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();});
const post=(path,body={},id)=>new Promise((resolve,reject)=>{
    const data=JSON.stringify(body);
    const request=require('node:http').request(url+path,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...(id?{'x-test-user':String(id)}:{})}},response=>{
        let content='';response.on('data',chunk=>content+=chunk);response.on('end',()=>resolve({status:response.statusCode,json:async()=>JSON.parse(content)}));
    });request.on('error',reject);request.end(data);
});
const begin=async()=>{
    const response=await post('/request');expect(response.status).toBe(200);
    const {data}=await response.json();const otp=sent.at(-1).text.match(/Code: (\d{6})/)[1];
    return {requestId:data.requestId,otp};
};
test('Google-only disable requires a distinct emailed proof and consumes it once under concurrency',async()=>{
    const priorVersion=String((await User.findById(user._id)).sessionVersion||'0');
    const proof=await begin();expect((await post('/request')).status).toBe(401);
    expect((await post('/confirm',proof,other._id)).status).toBe(401);
    const responses=await Promise.all([post('/confirm',proof),post('/confirm',proof)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,401]);
    const updated=await User.findById(user._id);
    expect(updated.isTwoFactorEnabled).toBe(false);
    expect(String(updated.sessionVersion)).not.toBe(priorVersion);
    expect((await post('/confirm',proof)).status).toBe(401);
});
test('five wrong attempts lock even a subsequently correct code',async()=>{
    const proof=await begin();const wrong=proof.otp==='000000'?'111111':'000000';
    for(let i=0;i<5;i++)expect((await post('/confirm',{...proof,otp:wrong})).status).toBe(401);
    expect((await post('/confirm',proof)).status).toBe(401);
    expect((await User.findById(user._id)).isTwoFactorEnabled).toBe(true);
});
test('expiry and session revocation invalidate disable proof',async()=>{
    const proof=await begin();await mfa.Proof.updateOne({_id:user._id},{$set:{expiresAt:new Date(0)}});
    expect((await post('/confirm',proof)).status).toBe(401);
    await mfa.Proof.deleteMany({});const fresh=await begin();
    await User.findByIdAndUpdate(user._id,{$set:{permissions:['VIEW_USERS']}});
    expect((await post('/confirm',fresh)).status).toBe(401);
});
test('password accounts cannot use the Google-only recovery route',async()=>{
    const current=await User.findById(user._id);current.password='unrelated-test-password';await current.save();
    expect((await post('/request')).status).toBe(401);expect(sent.length).toBe(0);
});
