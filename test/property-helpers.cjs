'use strict';
const fc = require('fast-check');

function integerSetting(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be a decimal integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}`);
    }
    return value;
}

// One seed per assertion keeps the seed/path from fast-check directly replayable.
// Preserve shrinking and its original error; never turn an interrupted run into a pass.
function check(property, options = {}) {
    const path = process.env.WGA_FUZZ_PATH;
    if (path !== undefined && !/^\d+(?::\d+)*$/.test(path)) {
        throw new Error('WGA_FUZZ_PATH must be a fast-check counterexample path');
    }
    if (path !== undefined && process.env.WGA_FUZZ_SEED === undefined) {
        throw new Error('Replay requires WGA_FUZZ_SEED together with WGA_FUZZ_PATH');
    }
    return fc.assert(property, {
        ...options,
        seed: integerSetting('WGA_FUZZ_SEED', 0x57a913e5, -2147483648, 2147483647),
        numRuns: integerSetting('WGA_FUZZ_RUNS', options.numRuns ?? 200, 1, 100000),
        includeErrorInReport: true,
        ...(path === undefined ? {} : { path, endOnFailure: true }),
    });
}

module.exports = { fc, check };
