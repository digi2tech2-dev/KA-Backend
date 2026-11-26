'use strict';
const {DevicePushToken}=require('../modules/pushTokens/devicePushToken.model');
const service=require('../modules/pushTokens/devicePushToken.service');
afterEach(()=>jest.restoreAllMocks());
test('registering a known token cannot silently steal an active device from another user',async()=>{
    const lookup=jest.spyOn(DevicePushToken,'findOneAndUpdate').mockRejectedValue(Object.assign(new Error('duplicate token'),{code:11000}));
    await expect(service.registerPushToken({userId:'new-user',token:'known-token',platform:'android'})).rejects.toMatchObject({statusCode:409});
    expect(lookup.mock.calls[0][0]).toEqual({token:'known-token',$or:[{userId:'new-user'},{isActive:false}]});
});
