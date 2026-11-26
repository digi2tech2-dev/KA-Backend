'use strict';
const {immutableAmount,immutableUpdate}=require('../shared/utils/depositReviewPolicy');
test('deposit approval cannot replace the requested amount or currency',()=>{
    expect(()=>immutableAmount({requestedAmount:100,currency:'EGP'},{amount:5000})).toThrow();
    expect(()=>immutableAmount({requestedAmount:100,currency:'EGP'},{currency:'USD'})).toThrow();
    expect(()=>immutableAmount({requestedAmount:100,currency:'EGP'},{amount:100,currency:'EGP'})).not.toThrow();
});
test('pending deposits cannot be inflated before approval',()=>{
    expect(()=>immutableUpdate({requestedAmount:5000})).toThrow();
    expect(()=>immutableUpdate({adminNotes:'Reviewed'})).not.toThrow();
});
