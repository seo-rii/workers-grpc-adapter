'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { awaitOwnedRestrictedToken: mint } = require('../scripts/gcp-restricted-token.cjs');

const target = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/123456789012345678901:generateAccessToken';
const marker = 'private-token-must-not-enter-public-receipts';
const initialTime = Date.parse('2026-10-04T12:00:00Z');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ allowPropagationWait = false, respond } = {}) {
    let time = initialTime;
    const calls = [], waits = [];
    const fresh = () => ({ status: 200, data: { accessToken: marker, expireTime: new Date(time + 1800000).toISOString() } });
    const args = { url: target, allowPropagationWait, now: () => time,
        wait: async (ms, signal) => { assert.equal(signal.aborted, false); waits.push(ms); time += ms; },
        api: async (...args) => {
            calls.push(args);
            return respond ? respond(calls.length, { fresh, jump: ms => { time += ms; } }) : fresh();
        } };
    return { args, calls, waits, jump: ms => { time += ms; } };
}
function publicOnly(result) {
    assert.deepEqual(Object.keys(result.receipt).sort(), ['attempts', 'elapsedMs', 'httpStatus', 'propagationWaitMs', 'reason', 'status']);
    assert.ok(!JSON.stringify(result.receipt).includes(marker));
    assert.ok(!JSON.stringify(result.receipt).includes('expireTime'));
}
function exactCalls(calls) {
    for (const call of calls) assert.deepEqual(call, [target, 'POST', {
        scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '1800s',
    }]);
    assert.equal(calls.filter(([url]) => url.includes('setIamPolicy') || url.includes('/keys')).length, 0);
}

test('restricted token minting separates private credentials from safe public evidence', async () => {
    const { args, calls, waits } = fixture();
    const result = await mint(args);
    assert.deepEqual(result.credentials, { accessToken: marker, expireTime: '2026-10-04T12:30:00.000Z' });
    assert.deepEqual(result.receipt, { status: 'ready', httpStatus: 200, attempts: 1, elapsedMs: 0, propagationWaitMs: 0, reason: null });
    assert.equal(waits.length, 0); exactCalls(calls); publicOnly(result);
});

test('default is exactly one attempt and a denied response never enables propagation retries', async () => {
    for (const allowPropagationWait of [undefined, false]) {
        const { args, calls, waits } = fixture({ respond: () => ({ status: 403, data: { error: { message: marker }, accessToken: marker } }) });
        args.allowPropagationWait = allowPropagationWait;
        const result = await mint(args);
        assert.equal(result.credentials, null);
        assert.deepEqual(result.receipt, { status: 'blocked', httpStatus: 403, attempts: 1, elapsedMs: 0,
            propagationWaitMs: 0, reason: 'permission-denied' });
        assert.equal(waits.length, 0); assert.equal(calls.length, 1); exactCalls(calls); publicOnly(result);
    }
});

test('explicit propagation retry repeats only the same fixed token request after 403', async () => {
    const { args, calls, waits } = fixture({ allowPropagationWait: true,
        respond: (count, { fresh }) => count < 3 ? { status: 403, data: count === 1 ? null : marker } : fresh() });
    const result = await mint(args);
    assert.equal(result.receipt.status, 'ready'); assert.equal(result.receipt.attempts, 3);
    assert.equal(result.receipt.elapsedMs, 20000); assert.equal(result.receipt.propagationWaitMs, 20000);
    assert.deepEqual(waits, [10000, 10000]); exactCalls(calls); publicOnly(result);
});

test('permission propagation stops at 300 seconds and never exceeds 31 requests', async () => {
    const { args, calls, waits } = fixture({ allowPropagationWait: true, respond: () => ({ status: 403 }) });
    const result = await mint(args);
    assert.equal(result.credentials, null); assert.equal(result.receipt.status, 'blocked');
    assert.equal(result.receipt.reason, 'permission-propagation-timeout');
    assert.equal(result.receipt.elapsedMs, 300000); assert.equal(result.receipt.propagationWaitMs, 300000);
    assert.ok(calls.length <= 31); assert.equal(calls.length, 30);
    assert.equal(waits.length, 30); assert.ok(waits.every(ms => ms === 10000)); exactCalls(calls); publicOnly(result);
});

test('API time consumes the same propagation budget and no request starts after the deadline', async () => {
    const { args, calls, waits } = fixture({ allowPropagationWait: true,
        respond: (_count, { jump }) => { jump(15000); return { status: 403 }; } });
    const result = await mint(args);
    assert.equal(result.receipt.status, 'blocked'); assert.equal(result.receipt.elapsedMs, 300000);
    assert.equal(calls.length, 12); assert.equal(waits.length, 12);
    exactCalls(calls); publicOnly(result);
    const partial = fixture({ allowPropagationWait: true,
        respond: (_count, { jump }) => { jump(297000); return { status: 403 }; } });
    assert.equal((await mint(partial.args)).receipt.elapsedMs, 300000);
    assert.equal(partial.calls.length, 1); assert.deepEqual(partial.waits, [3000]);
});

test('other HTTP statuses do not retry or return token-shaped error bodies as credentials', async () => {
    for (const httpStatus of [201, 204, 301, 400, 401, 404, 409, 429, 500, 503]) {
        const { args, calls, waits } = fixture({ allowPropagationWait: true,
            respond: (_count, { fresh }) => ({ ...fresh(), status: httpStatus }) });
        const result = await mint(args);
        assert.equal(result.receipt.status, 'failed'); assert.equal(result.receipt.reason, 'mint-http-status');
        assert.equal(result.receipt.httpStatus, httpStatus); assert.equal(result.credentials, null);
        assert.equal(calls.length, 1); assert.equal(waits.length, 0); exactCalls(calls); publicOnly(result);
    }
});

test('malformed response, token, expiry and error shape cannot become ready', async () => {
    for (const change of [
        () => null, () => ({}), value => ({ ...value, status: '200' }), value => ({ ...value, status: 999 }),
        value => ({ ...value, data: null }), value => ({ ...value, data: {} }),
        ...[undefined, '', 'short', marker + '\n', marker + '\0', marker + '\x7f', 'x'.repeat(8193)]
            .map(token => value => ({ ...value, data: { ...value.data, accessToken: token } })),
        ...[undefined, '', '2026', '2026-10-04T12:00:00Z', '2026-10-04T11:59:59Z',
            '2026-10-04T13:00:00Z', '2026-10-04T24:00:00Z', '2026-10-04T12:30:00Z\n', 'not-a-date']
            .map(expireTime => value => ({ ...value, data: { ...value.data, expireTime } })),
        value => ({ ...value, data: { ...value.data, error: { message: marker } } }),
    ]) {
        const { args, calls, waits } = fixture({ allowPropagationWait: true, respond: (_count, { fresh }) => change(fresh()) });
        const result = await mint(args);
        assert.equal(result.receipt.status, 'failed'); assert.equal(result.credentials, null);
        assert.equal(calls.length, 1); assert.equal(waits.length, 0); exactCalls(calls); publicOnly(result);
    }
    const { args } = fixture({ respond: (_count, { fresh }) => ({ ...fresh(), data: { accessToken: marker, expireTime: '2026-02-29T12:30:00Z' } }) });
    args.now = () => Date.parse('2026-03-01T12:00:00Z');
    assert.equal((await mint(args)).receipt.reason, 'invalid-token-response');
});

test('valid RFC3339 offsets and nanosecond forms retain the exact private expiry text', async () => {
    for (const expireTime of ['2026-10-04T21:30:00+09:00', '2026-10-04T12:30:00.123456789Z']) {
        const { args } = fixture({ respond: () => ({ status: 200, data: { accessToken: marker, expireTime } }) });
        const result = await mint(args); assert.equal(result.receipt.status, 'ready');
        assert.equal(result.credentials.expireTime, expireTime); publicOnly(result);
    }
});

test('malformed dependency options and non-fixed URLs fail before any request', async () => {
    for (const change of [
        args => { args.allowPropagationWait = 'true'; }, args => { args.api = undefined; },
        args => { args.now = 1; }, args => { args.wait = false; }, args => { args.signal = {}; },
        ...['https://example.test/token', target + '?token=' + marker, target + '\n', target.replace('projects/-', 'projects/wga-project'),
            target.replace('generateAccessToken', 'setIamPolicy'), target.replace('123456789012345678901', 'existing@example.test')]
            .map(url => args => { args.url = url; }),
    ]) {
        const { args, calls } = fixture(); change(args);
        await assert.rejects(mint(args), error => /^INVALID_RESTRICTED_TOKEN_(OPTIONS|URL)$/.test(error.code) && !String(error).includes(marker));
        assert.equal(calls.length, 0);
    }
});

test('pre-abort and abort during a pending request prevent further work and ignore late results', async () => {
    for (const lateReject of [false, true]) {
        const controller = new AbortController(); let finish, reject;
        const { args, calls, waits } = fixture({ allowPropagationWait: true,
            respond: () => new Promise((resolve, fail) => { finish = resolve; reject = fail; }) });
        args.signal = controller.signal;
        const pending = mint(args); await turn();
        controller.abort(new Error(marker));
        const result = await pending, saved = JSON.stringify(result);
        assert.equal(result.receipt.status, 'interrupted'); assert.equal(result.credentials, null);
        assert.equal(calls.length, 1); assert.equal(waits.length, 0);
        if (lateReject) reject(new Error(marker));
        else finish({ status: 200, data: { accessToken: marker, expireTime: '2026-10-04T12:30:00Z' } });
        await turn();
        assert.equal(JSON.stringify(result), saved); publicOnly(result);
    }
    const controller = new AbortController(); controller.abort(new Error(marker));
    const { args, calls } = fixture(); args.signal = controller.signal;
    assert.equal((await mint(args)).receipt.status, 'interrupted'); assert.equal(calls.length, 0);
});

test('abort while waiting for permission propagation settles without another token request', async () => {
    const controller = new AbortController(); let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const { args, calls } = fixture({ allowPropagationWait: true, respond: () => ({ status: 403 }) });
    args.signal = controller.signal;
    args.wait = async (_ms, signal) => { entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); };
    const pending = mint(args); await waiting; controller.abort(new Error(marker));
    const result = await pending;
    assert.equal(result.receipt.status, 'interrupted'); assert.equal(result.credentials, null);
    assert.equal(calls.length, 1); publicOnly(result);
});

test('transport, wait and invalid clock failures expose no arbitrary diagnostic data', async () => {
    const requests = fixture({ respond: () => { throw Object.assign(new Error(marker), { token: marker }); } });
    const requestResult = await mint(requests.args);
    assert.equal(requestResult.receipt.reason, 'mint-request-failed'); publicOnly(requestResult);
    const waits = fixture({ allowPropagationWait: true, respond: () => ({ status: 403 }) });
    waits.args.wait = () => { throw new Error(marker); };
    const waitResult = await mint(waits.args);
    assert.equal(waitResult.receipt.reason, 'propagation-wait-failed'); assert.equal(waits.calls.length, 1); publicOnly(waitResult);
    const backward = fixture({ allowPropagationWait: true, respond: (_count, { jump }) => { jump(-1); return { status: 403 }; } });
    const clockResult = await mint(backward.args);
    assert.equal(clockResult.receipt.reason, 'invalid-clock'); publicOnly(clockResult);
    const immediate = fixture({ allowPropagationWait: true, respond: () => ({ status: 403 }) });
    immediate.args.wait = async () => {};
    const immediateResult = await mint(immediate.args);
    assert.equal(immediateResult.receipt.reason, 'propagation-wait-incomplete'); assert.equal(immediate.calls.length, 1);
});

test('real-time deadline ends a stalled callback locally and late completion cannot mutate its receipt', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: initialTime });
    let finish;
    const { args, calls } = fixture({ allowPropagationWait: true,
        respond: () => new Promise(resolve => { finish = resolve; }) });
    args.now = Date.now;
    const pending = mint(args); await turn();
    t.mock.timers.tick(300000);
    const result = await pending, saved = JSON.stringify(result);
    assert.equal(result.receipt.status, 'failed'); assert.equal(result.receipt.reason, 'mint-timeout');
    assert.equal(result.receipt.elapsedMs, 300000); assert.equal(result.credentials, null); assert.equal(calls.length, 1);
    finish({ status: 200, data: { accessToken: marker, expireTime: '2026-10-04T12:35:00Z' } });
    await turn(); assert.equal(JSON.stringify(result), saved); publicOnly(result);
});

test('native credential renewal remains gated before any fixture import or credential use', async () => {
    const { runNativeCredentialRenewal } = require('../scripts/gcp-native-probe.cjs');
    const env = { WGA_GCP_PROJECT: 'wga-project', WGA_GCP_PROJECT_NUMBER: '123456789012',
        WGA_RUN_GOOGLE_TESTS: '1', WGA_ALLOW_TEST_WRITES: '1', WGA_GOOGLE_ACCESS_TOKEN: marker,
        WGA_FIRESTORE_DATABASE: 'wga-probe-test-fs', WGA_DATASTORE_DATABASE: 'wga-probe-test-ds',
        WGA_SECRET_NAME: 'projects/123456789012/secrets/wga-probe-test-secret',
        WGA_OWNED_SERVICE_ACCOUNT_UID: '123456789012345678901' };
    for (const flag of [undefined, '', false, true, 'true', '0']) {
        await assert.rejects(runNativeCredentialRenewal({ ...env, WGA_AUTH_RENEWAL_ENABLED: flag }), { code: 'INVALID_PROBE_BINDING' });
    }
    for (const uid of [undefined, 'existing@example.test', '123456789012345678901\n']) {
        await assert.rejects(runNativeCredentialRenewal({ ...env, WGA_AUTH_RENEWAL_ENABLED: '1', WGA_OWNED_SERVICE_ACCOUNT_UID: uid }),
            { code: 'INVALID_PROBE_BINDING' });
    }
});
