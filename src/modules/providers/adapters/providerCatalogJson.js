'use strict';

// Quote only numeric price values BEFORE JSON.parse can round them to a JS
// Number. Consume complete JSON strings so prices embedded in names/descriptions
// are never touched. IDs, quantities, flags and status codes keep their types.
const PRICE_KEYS = new Set([
    'price', 'cost', 'rate', 'product_price', 'cost_per_unit',
    'rawPrice', 'providerPrice', 'costPrice', 'basePrice',
    'api_price', 'provider_price', 'base_price', 'original_price',
]);
const PRICE_TOKEN = /("(?:[^"\\]|\\.)*")(?:([\t\r\n ]*:[\t\r\n ]*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\t\r\n ]*[,}\]]))?/g;

const parseProviderCatalog = (data) => {
    if (typeof data !== 'string' || !data.trim()) return data;
    const protectedJson = data.replace(/^\uFEFF/, '').replace(PRICE_TOKEN, (match, key, separator, number) => (
        number !== undefined && PRICE_KEYS.has(JSON.parse(key))
            ? `${key}${separator}${JSON.stringify(number)}`
            : match
    ));
    // Reject invalid catalogs rather than silently syncing an empty product list.
    return JSON.parse(protectedJson);
};

const providerCatalogRequest = { transformResponse: [parseProviderCatalog] };

module.exports = { parseProviderCatalog, providerCatalogRequest };
