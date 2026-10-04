'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { parseAuthRenewalArgs, validateCredentialRenewal: validate } = require('../scripts/gcp-auth-renewal.cjs');
const modes = ['native', 'grpc-web', 'cloudflare'];
const ids = ['initial', 'cached', 'renewed', 'recached'];
const generations = [1, 1, 2, 2];

function fixture(mode = 'cloudflare', { base = 1791115200000, initialOffset = 10, mintDelay = 20,
    rpcDelay = 10, gap = 5, remaining = 60000, wakeDelay = 0 } = {}) {
    const mint1 = { generation: 1, httpStatus: 200, startedAtMs: base + initialOffset + 5,
        completedAtMs: base + initialOffset + 5 + mintDelay, expireTimeMs: 0, remainingLifetimeMs: remaining };
    mint1.expireTimeMs = mint1.completedAtMs + remaining;
    const step = (index, start, end) => ({ id: ids[index], grpcCode: 7, mintCount: generations[index],
        authorizationCount: 1, tokenGeneration: generations[index], startedAtMs: start, completedAtMs: end, elapsedMs: end - start });
    const first = step(0, base + initialOffset, mint1.completedAtMs + rpcDelay);
    const cached = step(1, first.completedAtMs + gap, first.completedAtMs + gap + rpcDelay);
    const wait = { startedAtMs: cached.completedAtMs + gap, previousExpiryMs: mint1.expireTimeMs,
        completedAtMs: mint1.expireTimeMs + 250 + wakeDelay, elapsedMs: 0 };
    wait.elapsedMs = wait.completedAtMs - wait.startedAtMs;
    const mint2 = { generation: 2, httpStatus: 200, startedAtMs: wait.completedAtMs + gap + 5,
        completedAtMs: wait.completedAtMs + gap + 5 + mintDelay, expireTimeMs: 0, remainingLifetimeMs: remaining };
    mint2.expireTimeMs = mint2.completedAtMs + remaining;
    const renewed = step(2, wait.completedAtMs + gap, mint2.completedAtMs + rpcDelay);
    const recached = step(3, renewed.completedAtMs + gap, renewed.completedAtMs + gap + rpcDelay);
    const completedAtMs = recached.completedAtMs + gap;
    return { schemaVersion: 1, kind: 'credential-renewal', mode, status: 'passed',
        observationBoundary: mode === 'native' ? 'auth-request-headers' : 'transport-fetch',
        clock: 'real', sourceCredential: 'access-token-only', sourceRefreshSupported: false,
        sameSdkClient: true, sameAuthClient: true, lifetimeSeconds: 60, eagerRefreshThresholdMs: 1000,
        mints: [mint1, mint2], steps: [first, cached, renewed, recached], wait, mintOperations: 2,
        authorizationChecks: 4, tokensChanged: true, cleanup: { sdkClosed: true },
        startedAtMs: base, completedAtMs, elapsedMs: completedAtMs - base };
}
function rejects(mutate, mode = 'cloudflare', expectedError) {
    const receipt = fixture(mode); mutate(receipt);
    const result = validate(receipt, { mode });
    assert.equal(result.valid, false); assert.ok(result.errors.length > 0);
    if (expectedError) assert.ok(result.errors.includes(expectedError), result.errors.join(','));
    return result;
}

test('auth renewal CLI opt-in is exact, singular and requires the catalog', () => {
    assert.equal(parseAuthRenewalArgs([]), false);
    assert.equal(parseAuthRenewalArgs(['--catalog']), false);
    assert.equal(parseAuthRenewalArgs(['--catalog', '--verify-auth-renewal']), true);
    assert.equal(parseAuthRenewalArgs(['--verify-auth-renewal', '--catalog', '--deploy-temporary']), true);
    for (const argv of [null, {}, [null], ['--verify-auth-renewal=true'], ['--verify-auth-renewal=1'],
        ['--verify-auth-renew'], ['--verify-auth-renewa'], ['--verify-auth-renewals'], ['--verify-auth-renewal-extra'],
        ['--verify-auth-renewal '], ['--verify-auth-renewal\n'], ['--verify-auth-renewal', '--verify-auth-renewal', '--catalog']]) {
        assert.throws(() => parseAuthRenewalArgs(argv), { code: 'INVALID_AUTH_RENEWAL_OPTION', message: 'INVALID_AUTH_RENEWAL_OPTION' });
    }
    for (const argv of [['--verify-auth-renewal'], ['--verify-auth-renewal', '--catalog=true']]) {
        assert.throws(() => parseAuthRenewalArgs(argv), { code: 'CATALOG_REQUIRED_FOR_AUTH_RENEWAL', message: 'CATALOG_REQUIRED_FOR_AUTH_RENEWAL' });
    }
});

test('strict credential renewal evidence accepts all three exact observation boundaries', () => {
    for (const mode of modes) {
        const receipt = fixture(mode), before = structuredClone(receipt);
        assert.deepEqual(validate(receipt, { mode }), { valid: true, errors: [] });
        assert.deepEqual(receipt, before);
    }
    for (const mode of [undefined, '', 'grpc', true, null]) assert.equal(validate(fixture(), { mode }).valid, false);
    assert.equal(validate(fixture(), null).valid, false);
});

test('receipt constants, mode, auth scope, client identity and cleanup cannot be relaxed', () => {
    const values = { schemaVersion: 2, kind: 'other', mode: 'grpc-web', status: 'failed',
        observationBoundary: 'auth-request-headers', clock: 'injected', sourceCredential: 'refresh-token',
        sourceRefreshSupported: true, sameSdkClient: false, sameAuthClient: false,
        lifetimeSeconds: 300, eagerRefreshThresholdMs: 300000, mintOperations: 3,
        authorizationChecks: 3, tokensChanged: false };
    for (const [key, value] of Object.entries(values)) rejects(row => { row[key] = value; });
    rejects(row => { row.cleanup.sdkClosed = false; }, 'cloudflare', 'cleanup');
    rejects(row => { row.observationBoundary = 'transport-fetch'; }, 'native', 'observation-boundary');
});

test('missing keys, extra credentials and unknown nested properties are rejected without disclosure', () => {
    const marker = 'credential-content-never-echoed';
    for (const key of Object.keys(fixture())) rejects(row => { delete row[key]; }, 'cloudflare', 'receipt-schema');
    for (const select of [row => row, row => row.mints[0], row => row.mints[1], row => row.steps[0],
        row => row.steps[1], row => row.steps[2], row => row.steps[3], row => row.wait, row => row.cleanup,
        row => row.mints, row => row.steps]) {
        for (const key of ['accessToken', 'authorization', marker]) {
            const result = rejects(row => { select(row)[key] = marker; });
            assert.ok(!JSON.stringify(result).includes(marker));
            assert.ok(!JSON.stringify(result).includes(key));
        }
    }
    for (const select of [row => row.mints[0], row => row.steps[0], row => row.wait, row => row.cleanup]) {
        for (const key of Object.keys(select(fixture()))) rejects(row => { delete select(row)[key]; });
    }
});

test('array counts, holes, row kinds and non-JSON objects fail the strict schema', () => {
    for (const receipt of [null, undefined, [], 1, true, 'passed', NaN, new Date()]) assert.equal(validate(receipt, { mode: 'cloudflare' }).valid, false);
    for (const change of [
        row => { row.mints.pop(); }, row => { row.mints.push(structuredClone(row.mints[0])); },
        row => { delete row.mints[0]; }, row => { row.mints = {}; }, row => { row.mints[0] = []; },
        row => { row.steps.pop(); }, row => { row.steps.push(structuredClone(row.steps[0])); },
        row => { delete row.steps[0]; }, row => { row.steps[0] = null; }, row => { row.wait = []; },
        row => { row.cleanup = []; }, row => { Object.setPrototypeOf(row, { secret: 'hidden' }); },
        row => { Object.defineProperty(row, 'tokensChanged', { value: true, enumerable: false }); },
        row => { row[Symbol('secret')] = true; },
    ]) rejects(change);
});

test('all timestamp and count fields require finite nonnegative safe integers', () => {
    const selectors = [row => row, row => row.mints[0], row => row.mints[1], row => row.wait,
        ...[0, 1, 2, 3].map(index => row => row.steps[index])];
    for (const select of selectors) {
        const keys = Object.keys(select(fixture())).filter(key => typeof select(fixture())[key] === 'number');
        for (const key of keys) for (const invalid of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
            rejects(row => { select(row)[key] = invalid; });
        }
    }
});

test('outer duration must match a nondecreasing window bounded by 120 seconds', () => {
    rejects(row => { row.elapsedMs++; }, 'cloudflare', 'receipt-window');
    rejects(row => { row.completedAtMs = row.startedAtMs - 1; }, 'cloudflare', 'receipt-window');
    rejects(row => { row.completedAtMs = row.startedAtMs + 120001; row.elapsedMs = 120001; }, 'cloudflare', 'receipt-window');
    const boundary = fixture(); boundary.completedAtMs = boundary.startedAtMs + 120000; boundary.elapsedMs = 120000;
    assert.equal(validate(boundary, { mode: 'cloudflare' }).valid, true);
});

test('each mint must be HTTP200, correctly numbered and contain its real 40 to 70 second lifetime', () => {
    for (const index of [0, 1]) for (const mutate of [
        mint => { mint.generation = index + 2; }, mint => { mint.httpStatus = 403; },
        mint => { mint.remainingLifetimeMs = 39999; }, mint => { mint.remainingLifetimeMs = 70001; },
        mint => { mint.expireTimeMs++; }, mint => { mint.startedAtMs = mint.completedAtMs + 1; },
        mint => { mint.completedAtMs = mint.startedAtMs - 1; },
    ]) rejects(row => { mutate(row.mints[index]); });
    for (const remaining of [40000, 70000]) assert.equal(validate(fixture('cloudflare', { remaining }), { mode: 'cloudflare' }).valid, true);
});

test('mints are contained by initial and renewed RPCs rather than unrelated steps', () => {
    for (const index of [0, 1]) {
        rejects(row => { row.mints[index].startedAtMs = row.steps[index * 2].startedAtMs - 1; }, 'cloudflare', `mint-${index + 1}-step`);
        rejects(row => { row.mints[index].completedAtMs = row.steps[index * 2].completedAtMs + 1; }, 'cloudflare', `mint-${index + 1}-step`);
        rejects(row => { row.mints[index].startedAtMs = row.startedAtMs - 1; }, 'cloudflare', `mint-${index + 1}-window`);
    }
});

test('all four RPCs require permission denial, exactly one auth observation and 1,1,2,2 generations', () => {
    for (const index of [0, 1, 2, 3]) for (const [key, value] of [
        ['id', 'wrong'], ['grpcCode', 0], ['grpcCode', 16], ['authorizationCount', 0], ['authorizationCount', 2],
        ['mintCount', generations[index] + 1], ['tokenGeneration', generations[index] + 1],
    ]) rejects(row => { row.steps[index][key] = value; });
    rejects(row => { [row.steps[0], row.steps[1]] = [row.steps[1], row.steps[0]]; });
});

test('RPC windows have exact durations, stay in the run and never overlap', () => {
    for (const index of [0, 1, 2, 3]) {
        rejects(row => { row.steps[index].elapsedMs++; }, 'cloudflare', `step-${ids[index]}-window`);
        rejects(row => { row.steps[index].startedAtMs = row.startedAtMs - 1; }, 'cloudflare', `step-${ids[index]}-window`);
        rejects(row => { row.steps[index].completedAtMs = row.completedAtMs + 1; }, 'cloudflare', `step-${ids[index]}-window`);
        if (index > 0) rejects(row => { row.steps[index].startedAtMs = row.steps[index - 1].completedAtMs - 1; },
            'cloudflare', `step-${ids[index]}-order`);
    }
});

test('wait joins the cached and renewed RPCs and proves passage beyond the first real expiry', () => {
    for (const change of [
        row => { row.wait.elapsedMs++; }, row => { row.wait.previousExpiryMs++; },
        row => { row.wait.startedAtMs = row.steps[1].completedAtMs - 1; },
        row => { row.wait.completedAtMs = row.steps[2].startedAtMs + 1; },
        row => { row.wait.completedAtMs = row.mints[0].expireTimeMs + 249; },
        row => { row.wait.startedAtMs = row.wait.completedAtMs; row.wait.elapsedMs = 0; },
        row => { row.mints[1].startedAtMs = row.mints[0].expireTimeMs - 1; },
        row => { row.mints[1].startedAtMs = row.wait.completedAtMs - 1; },
        row => { row.mints[1].expireTimeMs = row.mints[0].expireTimeMs; },
    ]) rejects(change);
});

test('accessors and throwing proxies cannot leak arbitrary error or credential text', () => {
    const marker = 'private-fixture-marker';
    const receipt = fixture(); Object.defineProperty(receipt, 'mode', { enumerable: true, get() { throw new Error(marker); } });
    const inaccessible = new Proxy({}, { getPrototypeOf() { throw new Error(marker); } });
    for (const value of [receipt, inaccessible]) {
        const result = validate(value, { mode: 'cloudflare' });
        assert.equal(result.valid, false); assert.ok(!JSON.stringify(result).includes(marker));
    }
});

test('generated real-time schedules remain valid and every targeted corruption is rejected', () => {
    const schedule = fc.record({ base: fc.integer({ min: 1700000000000, max: 1800000000000 }),
        initialOffset: fc.integer({ min: 0, max: 1000 }), mintDelay: fc.integer({ min: 0, max: 2000 }),
        rpcDelay: fc.integer({ min: 0, max: 1000 }), gap: fc.integer({ min: 0, max: 1000 }),
        remaining: fc.integer({ min: 40000, max: 70000 }), wakeDelay: fc.integer({ min: 0, max: 1000 }) });
    const corruptions = [
        row => { row.steps[1].mintCount = 2; }, row => { row.steps[2].tokenGeneration = 1; },
        row => { row.wait.completedAtMs = row.wait.previousExpiryMs; row.wait.elapsedMs = row.wait.completedAtMs - row.wait.startedAtMs; },
        row => { row.mints[1].startedAtMs = row.mints[0].expireTimeMs - 1; },
        row => { row.cleanup.sdkClosed = false; }, row => { row.accessToken = 'must-not-be-collected'; },
        row => { row.mints[0].remainingLifetimeMs++; }, row => { row.steps[3].authorizationCount++; },
    ];
    fc.assert(fc.property(schedule, fc.constantFrom(...modes), fc.integer({ min: 0, max: corruptions.length - 1 }),
        (timing, mode, corrupt) => {
            const receipt = fixture(mode, timing);
            assert.deepEqual(validate(receipt, { mode }), { valid: true, errors: [] });
            corruptions[corrupt](receipt);
            assert.equal(validate(receipt, { mode }).valid, false);
        }), { numRuns: 1000, seed: 20261004 });
});
