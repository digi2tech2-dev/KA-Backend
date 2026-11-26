'use strict';
const mongoose=require('mongoose');
const {User}=require('../modules/users/user.model');
const Group=require('../modules/groups/group.model');
const {DepositRequest}=require('../modules/deposits/deposit.model');
const {WalletTransaction}=require('../modules/wallet/walletTransaction.model');
const service=require('../modules/deposits/deposit.service');
let user,admin,staff,deposit;
beforeAll(async()=>{
    await mongoose.connect(process.env.MONGO_TEST_URI);
    const group=await Group.create({name:'hotfix-deposit-review',percentage:10,isActive:true});
    const create=(name,role)=>User.create({name,email:`${name}@deposit.test`,role,status:'ACTIVE',verified:true,groupId:group._id,walletBalance:100,currency:'USD',phone:'+201012345678',country:'EG',profileCompletedAt:new Date()});
    user=await create('Owner','CUSTOMER');admin=await create('Admin','ADMIN');staff=await create('Staff','SUPERVISOR');
    deposit=await DepositRequest.create({userId:user._id,paymentMethodId:'manual-test',requestedAmount:100,currency:'USD',exchangeRate:1,amountUsd:100,receiptImage:'uploads/deposits/test.png'});
});
afterAll(async()=>mongoose.disconnect());
test('neither reviewer can inflate an existing pending deposit',async()=>{
    await expect(service.approveDeposit(deposit._id,admin._id,{amount:5000})).rejects.toMatchObject({code:'DEPOSIT_AMOUNT_IMMUTABLE'});
    await expect(service.updatePendingDeposit(deposit._id,{requestedAmount:5000},admin._id)).rejects.toMatchObject({code:'DEPOSIT_AMOUNT_IMMUTABLE'});
    expect((await User.findById(user._id)).walletBalance).toBe(100);
    expect((await DepositRequest.findById(deposit._id)).status).toBe('PENDING');
    expect(await WalletTransaction.countDocuments({userId:user._id})).toBe(0);
});
test('a supervisor with a stolen session cannot approve and mint funds',async()=>{
    await expect(service.approveDeposit(deposit._id,staff._id)).rejects.toMatchObject({statusCode:403});
    expect((await User.findById(user._id)).walletBalance).toBe(100);
});
