'use strict';
const verify=require('../shared/utils/verifiedGoogleProfile');
test.each([{}, {id:'google-user',emails:[{value:'owner@example.test'}]}, {id:'google-user',_json:{email_verified:false},emails:[{value:'owner@example.test'}]}])('unverified OAuth profiles never reach account lookup', profile=>expect(()=>verify(profile)).toThrow());
test('accepts the verified OpenID profile returned by passport-google-oauth20',()=>{
    expect(()=>verify({id:'google-user',_json:{email_verified:true},emails:[{value:'owner@example.test',verified:true}]})).not.toThrow();
});
