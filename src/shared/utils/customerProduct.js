'use strict';
const sensitive = ['providerPrice', 'markupType', 'markupValue', 'pricingMode', 'provider', 'providerProduct', 'providerMapping',
    'syncPriceWithProvider', 'enableManualPrice', 'manualPriceAdjustment', 'executionType', 'createdBy', 'deletedAt',
    'internalNotes', 'syncedProviderBasePrice', 'supplierId', 'providerId', 'externalProductId', 'externalProductName',
    'costPrice', 'rawPayload', 'rawResponse', 'credentials', '__v', 'basePrice'];
module.exports = (product, customerPrice) => {
    if (!product) return product;
    const value = typeof product.toObject === 'function' ? product.toObject() : { ...product };
    for (const field of sensitive) delete value[field];
    if (customerPrice !== undefined) {
        // Legacy clients use these aliases; both carry the customer's sale price.
        value.basePrice = customerPrice;
        value.finalPrice = customerPrice;
    }
    if (!value.showAccountNumber) value.displayAccountNumber = null;
    return value;
};
