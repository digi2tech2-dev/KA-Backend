# Supplier price precision

Catalog requests for Canonical B2B, Brand One Card, Alkasr/Brand1,
Toros, Royal Crown and Ibra decode numeric price fields as decimal strings
before JavaScript can round them. Quoted prices also retain their digits.
Product IDs, quantities and flags keep their existing JSON types. This
decoder applies only to catalog requests.

Source prices are normalized to plain decimal strings without a decimal-place
limit in supplier storage and the live-price cache. Normalization may remove
trailing zeros or expand scientific notation without changing the value.

Brand One Card retains the source price in `rawPayload.sourcePrice` and still
converts non-USD prices using the configured `platformRate`. Calculated FX and
markup amounts retain the existing 60 significant digit / 50 decimal place
arithmetic policy; this change does not alter wallet rounding.

Outgoing B2B catalog price aliases no longer round to six decimal places.
They remain JSON numbers when the decimal value survives a number-to-JSON
round trip exactly. Values that would lose digits are returned as decimal
strings. Consumers should accept either representation.

Regression coverage: `src/tests/providerPricePrecision.test.js` exercises raw
JSON through real Axios transformation, all six adapters, source normalization,
Brand One FX conversion, B2B aliases, sync write arguments and live-price cache.
