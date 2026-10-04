'use strict';

// Small helpers the provider descriptors share. No requires, so a descriptor can load before anything else does.

const parseVersion = (text) => /\d+\.\d+\.\d+/.exec(String(text || ''))?.[0] || null;
const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1);

module.exports = { parseVersion, cap };
