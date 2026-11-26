'use strict';
const mongoose=require('mongoose');
const crypto=require('node:crypto');
const {AppError}=require('../errors/AppError');
const Attempts=mongoose.models.HotfixLoginAttempts || mongoose.model('HotfixLoginAttempts',new mongoose.Schema({_id:String,attempts:Number,expiresAt:{type:Date,expires:0}}));
const guard=login=>async credentials=>{
    const email=String(credentials?.email || '').trim().toLowerCase();
    const id=crypto.createHash('sha256').update(email).digest('hex');
    const now=new Date();
    await Attempts.updateOne({_id:id,expiresAt:{$lte:now}},{$set:{attempts:0,expiresAt:new Date(Date.now()+900000)}});
    let attempt;
    try {attempt=await Attempts.findOneAndUpdate({_id:id},{$setOnInsert:{expiresAt:new Date(Date.now()+900000)},$inc:{attempts:1}},{upsert:true,new:true});}
    catch(error){if(error.code!==11000)throw error;attempt=await Attempts.findOneAndUpdate({_id:id},{$inc:{attempts:1}},{new:true});}
    if(!attempt || attempt.attempts>10)throw new AppError('Too many authentication attempts. Please retry later.',429,'ACCOUNT_LOGIN_LIMIT');
    const result=await login(credentials);
    await Attempts.deleteOne({_id:id,expiresAt:attempt.expiresAt});
    return result;
};
module.exports={guard,Attempts};
