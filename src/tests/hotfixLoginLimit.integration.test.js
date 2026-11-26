'use strict';
const mongoose=require('mongoose');
const {guard,Attempts}=require('../shared/utils/accountLoginLimit');
beforeAll(async()=>{await mongoose.connect(process.env.MONGO_TEST_URI);await Attempts.init();});
afterAll(async()=>mongoose.disconnect());
test('distributed guesses are limited by account regardless of IP',async()=>{
    const underlying=jest.fn().mockRejectedValue(new Error('Invalid password'));
    const login=guard(underlying);
    for(let i=0;i<10;i++)await expect(login({email:'Owner@example.test',password:'bad',ip:`10.0.0.${i}`})).rejects.toThrow('Invalid password');
    await expect(login({email:'owner@example.test',password:'bad',ip:'9.9.9.9'})).rejects.toMatchObject({code:'ACCOUNT_LOGIN_LIMIT'});
    expect(underlying).toHaveBeenCalledTimes(10);
});
test('successful authentication clears failed password attempts',async()=>{
    const underlying=jest.fn().mockResolvedValue({token:'verified'});
    const result=await guard(underlying)({email:'valid@example.test'});
    expect(result.token).toBe('verified');
    expect(await Attempts.countDocuments()).toBe(1);
});
