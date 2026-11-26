'use strict';
const mongoose=require('mongoose');
const {User}=require('../modules/users/user.model');
const Group=require('../modules/groups/group.model');
const {WalletTransaction}=require('../modules/wallet/walletTransaction.model');
const {Currency}=require('../modules/currency/currency.model');
const money=require('../shared/utils/atomicAdminWallet');
const adminUsers=require('../modules/admin/admin.users.service');
let owner,admin,staff,currencyRaceOwner;
beforeAll(async()=>{
    await mongoose.connect(process.env.MONGO_TEST_URI);
    await Promise.all([money.Operation.init(),money.Budget.init(),WalletTransaction.init()]);
    await Promise.all([
        Currency.updateOne({code:'USD'},{$set:{name:'US Dollar',symbol:'$',platformRate:1,isActive:true}},{upsert:true}),
        Currency.updateOne({code:'EGP'},{$set:{name:'Egyptian Pound',symbol:'E£',platformRate:50,isActive:true}},{upsert:true}),
    ]);
    const group=await Group.create({name:'hotfix-finance',percentage:10,isActive:true});
    const create=(name,role,balance)=>User.create({name,email:`${name}@example.test`,role,status:'ACTIVE',verified:true,groupId:group._id,walletBalance:balance,creditLimit:0,currency:'USD',phone:'+201012345678',country:'EG',profileCompletedAt:new Date()});
    owner=await create('Owner','CUSTOMER',100);currencyRaceOwner=await create('CurrencyRaceOwner','CUSTOMER',100);
    admin=await create('Admin','ADMIN',0);staff=await create('Staff','SUPERVISOR',0);
});
afterAll(async()=>mongoose.disconnect());
test('concurrent credits preserve both amounts and ledger entries',async()=>{
    await Promise.all([money.adjust('ADD',owner._id,10,'Test credit one',admin._id,'concurrent-credit-1'),money.adjust('ADD',owner._id,20,'Test credit two',admin._id,'concurrent-credit-2')]);
    expect((await User.findById(owner._id)).walletBalance).toBe(130);
    expect(await WalletTransaction.countDocuments({userId:owner._id})).toBe(2);
});
test('currency conversion cannot overwrite a concurrent wallet credit',async()=>{
    const outcome=await Promise.allSettled([
        adminUsers.updateUserCurrency(currencyRaceOwner._id,'EGP',admin._id),
        money.adjust('ADD',currencyRaceOwner._id,10,'Concurrent currency test',admin._id,'currency-race-key-1'),
    ]);
    const successes=outcome.filter(result=>result.status==='fulfilled').length;
    expect(successes).toBeGreaterThan(0);
    const current=await User.findById(currencyRaceOwner._id);
    if(successes===2) {
        expect(current.currency).toBe('EGP');
        expect([5010,5500]).toContain(current.walletBalance);
    } else if(current.currency==='EGP') expect(current.walletBalance).toBe(5000);
    else { expect(current.currency).toBe('USD'); expect(current.walletBalance).toBe(110); }
});
test('replaying the same key does not mint additional funds',async()=>{
    const result=await money.adjust('ADD',owner._id,10,'Test credit one',admin._id,'concurrent-credit-1');
    expect(result.idempotent).toBe(true);
    expect((await User.findById(owner._id)).walletBalance).toBe(130);
});
test('a supervisor cannot create funds',async()=>{
    await expect(money.adjust('ADD',owner._id,10,'Invalid credit',staff._id,'supervisor-credit')).rejects.toMatchObject({statusCode:403});
});
test('set balance cannot exceed the credit floor',async()=>{
    await expect(money.adjust('SET',owner._id,-10,'Invalid floor',admin._id,'invalid-floor')).rejects.toMatchObject({code:'INSUFFICIENT_BALANCE'});
});
test('missing keys and amounts above the approval threshold fail closed',async()=>{
    await expect(money.adjust('ADD',owner._id,10,'Missing key',admin._id)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REQUIRED'});
    await expect(money.adjust('ADD',owner._id,1001,'Needs approval',admin._id,'large-credit-key')).rejects.toMatchObject({code:'SECOND_APPROVAL_REQUIRED'});
});
