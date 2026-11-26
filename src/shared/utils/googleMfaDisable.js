'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const config = require('../../config/config');
const { AuthenticationError } = require('../errors/AppError');
const { User } = require('../../modules/users/user.model');
const Proof = mongoose.models.GoogleMfaDisableProof || mongoose.model('GoogleMfaDisableProof', new mongoose.Schema({
    _id: mongoose.Schema.Types.ObjectId, requestId: String, codeHash: String, sessionVersion: String,
    attempts: {type:Number,default:0}, nextRequestAt: Date, expiresAt: {type:Date,expires:0},
}));
const denied = () => new AuthenticationError('Cannot disable MFA. Use your current password or request a fresh Google-account email code.');
const hash = (requestId, code) => crypto.createHmac('sha256', config.jwt.secret).update(`disable-google-mfa:${requestId}:${code}`).digest('hex');
const eligible = user => user && user.googleId && !user.password && user.verified && user.isTwoFactorEnabled && user.status === 'ACTIVE' && !user.deletedAt && !user.blockedAt;
const request = async (req,res,next) => {
    try {
        const user = await User.findById(req.user._id).select('+password');
        if (!eligible(user)) throw denied();
        const requestId = crypto.randomBytes(32).toString('hex');
        const code = crypto.randomInt(0,1000000).toString().padStart(6,'0');
        // Unique account ID plus compare-and-set enforces a cross-process resend cooldown.
        let proof;
        try {
            proof = await Proof.findOneAndUpdate({_id:user._id,$or:[{nextRequestAt:{$lte:new Date()}},{nextRequestAt:{$exists:false}}]},
                {$set:{requestId,codeHash:hash(requestId,code),sessionVersion:String(user.sessionVersion||'0'),attempts:0,nextRequestAt:new Date(Date.now()+60000),expiresAt:new Date(Date.now()+300000)}},
                {upsert:true,new:true});
        } catch (error) { if(error.code===11000) throw denied(); throw error; }
        if (!proof) throw denied();
        try {
            await require('../../services/email.service').sendEmail({to:user.email,subject:'Confirm disabling two-factor authentication',
                text:`Code: ${code}. This code disables two-factor protection on your account. It expires in 5 minutes. If you did not request this, secure your account immediately.`});
        } catch(error) { await Proof.deleteOne({_id:user._id,requestId}); throw error; }
        res.set('Cache-Control','no-store');res.json({success:true,data:{requestId},message:'A confirmation code was sent to your verified email.'});
    } catch(error) { next(error); }
};
const confirm = async (req,res,next) => {
    let session;
    try {
        const {requestId,otp}=req.body||{};
        if(typeof requestId!=='string'||!/^[a-f0-9]{64}$/.test(requestId)||typeof otp!=='string'||!/^\d{6}$/.test(otp)) throw denied();
        const user = await User.findById(req.user._id).select('+password');
        if (!eligible(user)) throw denied();
        const filter={_id:user._id,requestId,sessionVersion:String(user.sessionVersion||'0'),expiresAt:{$gt:new Date()},attempts:{$lt:5}};
        // Increment BEFORE checking the code, including concurrent incorrect submissions.
        const proof=await Proof.findOneAndUpdate(filter,{$inc:{attempts:1}},{new:true});
        if(!proof || !crypto.timingSafeEqual(Buffer.from(proof.codeHash,'hex'),Buffer.from(hash(requestId,otp),'hex'))) throw denied();
        session=await mongoose.startSession();
        await session.withTransaction(async()=>{
            const consumed=await Proof.findOneAndDelete({...filter,attempts:{$lte:5},codeHash:proof.codeHash},{session});
            if(!consumed) throw denied();
            const updated=await User.findOneAndUpdate({_id:user._id,googleId:user.googleId,password:null,verified:true,isTwoFactorEnabled:true,status:'ACTIVE',deletedAt:null,blockedAt:null,
                sessionVersion:user.sessionVersion||'0'},{$set:{isTwoFactorEnabled:false,twoFactorOtp:null,twoFactorOtpExpires:null}},{session,new:true});
            if(!updated) throw denied();
        });
        const {USER_ACTIONS,ENTITY_TYPES,ACTOR_ROLES}=require('../../modules/audit/audit.constants');
        await require('../../modules/audit/audit.service').createAuditLog({actorId:user._id,actorRole:ACTOR_ROLES[user.role]||user.role,
            action:USER_ACTIONS.TWO_FACTOR_DISABLED,entityType:ENTITY_TYPES.USER,entityId:user._id,metadata:{method:'google-email-proof'}});
        res.set('Cache-Control','no-store');res.json({success:true,data:null,message:'Two-factor authentication disabled. Sign in again.'});
    } catch(error) { next(error); }
    finally { if(session) await session.endSession(); }
};
module.exports={request,confirm,Proof};
