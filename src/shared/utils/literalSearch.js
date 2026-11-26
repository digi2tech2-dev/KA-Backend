'use strict';
module.exports = value => String(value).slice(0, 128).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
