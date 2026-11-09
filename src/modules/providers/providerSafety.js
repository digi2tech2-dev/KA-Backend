'use strict';
const { isMaya, numeric } = require('./mayaCard.rules');
const redactProvider = (provider) => {
    const obj = provider?.toObject ? provider.toObject() : { ...provider };
    const hasApiToken = Boolean(obj.apiToken || obj.apiKey);
    delete obj.apiToken; delete obj.apiKey; delete obj.effectiveToken;
    return { ...obj, hasApiToken };
};
const isMayaProductRequest = async (req) => {
    const { Product } = require('../products/product.model');
    const { ProviderProduct } = require('./providerProduct.model');
    const { Provider } = require('./provider.model');
    let id;
    if (req.params.productId || req.params.id) {
        const product = await Product.findById(req.params.productId || req.params.id).select('providerProduct');
        id = req.body.providerProduct !== undefined ? req.body.providerProduct : product?.providerProduct;
    } else {
        id = req.body.providerProductId || req.body.providerProduct;
    }
    if (!id) return false;
    const pp = await ProviderProduct.findById(id).select('provider');
    return pp ? isMaya(await Provider.findById(pp.provider)) : false;
};
const validateCatalogMax = async (value, { req }) => {
    if (require('validator').isInt(String(value), { min: 1 })) return true;
    const n = numeric(value);
    if (n < 1 || !(await isMayaProductRequest(req))) throw new Error('maxQty must be >= 1 and integer except for Maya catalog limits');
    return true;
};
module.exports = { redactProvider, isMayaProductRequest, validateCatalogMax };
