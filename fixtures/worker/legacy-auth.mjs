import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, credentials, Metadata, status } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const scenarios = ['sync', 'async', 'duplicate', 'empty', 'modern', 'modern-error', 'error', 'missing', 'invalid',
    'throw', 'async-reject', 'cancel', 'deadline', 'success-throw', 'error-success', 'returned-only'];
const succeeds = new Set(['sync', 'async', 'duplicate', 'empty', 'modern', 'success-throw']);
const turns = () => new Promise(resolve => setTimeout(resolve, 0));

async function exercise(mode, invocation, scenario) {
    let callback, started, callbacks = 0, legacyCalls = 0, modernCalls = 0;
    const ready = new Promise(resolve => { started = resolve; });
    const statuses = [];
    const authUrl = 'https://legacy-auth.test/fixture.Legacy';
    const auth = {
        getRequestMetadata(url, done) {
            legacyCalls++;
            assert.equal(this, auth);
            assert.equal(url, authUrl);
            callback = done;
            started();
            const error = Object.assign(new Error('fixture-secret-must-not-escape'), { code: status.UNAUTHENTICATED });
            if (scenario === 'throw') throw error;
            if (scenario === 'async-reject') return Promise.reject(error);
            if (scenario === 'returned-only') return Promise.resolve({ authorization: 'Bearer fixture-returned' });
            if (scenario === 'cancel' || scenario === 'deadline') return;
            if (scenario === 'async') return fetch('https://control.fixture.invalid/turn').then(() => done(null, { authorization: `Bearer ${invocation}-${scenario}` }));
            if (scenario === 'missing') { done(null); return; }
            if (scenario === 'invalid') { done(null, { authorization: ['fixture-array'] }); return; }
            if (scenario === 'error' || scenario === 'error-success') {
                done(error, { authorization: 'Bearer ignored' });
                if (scenario === 'error-success') done(null, { authorization: 'Bearer late' });
                return;
            }
            done(null, scenario === 'empty' ? {} : { authorization: `Bearer ${invocation}-${scenario}`, 'x-goog-user-project': 'fixture-project' });
            if (scenario === 'duplicate') done(error);
            if (scenario === 'success-throw') throw error;
        },
    };
    if (scenario === 'modern' || scenario === 'modern-error') auth.getRequestHeaders = async function (url) {
        modernCalls++;
        assert.equal(this, auth);
        assert.equal(url, authUrl);
        if (scenario === 'modern-error') throw Object.assign(new Error('fixture-secret-must-not-escape'), { code: status.UNAUTHENTICATED });
        return new Headers({ authorization: `Bearer ${invocation}-${scenario}` });
    };
    const transport = createWorkersGrpcTransport({ mode, ...(mode === 'grpc-web' ? { endpoints: { 'legacy-auth.test': 'https://legacy-gateway.test' } } : {}) });
    const channelCredentials = credentials.combineChannelCredentials(credentials.createSsl(), credentials.createFromGoogleCredential(auth));
    const client = new Client('legacy-auth.test', channelCredentials, transport.grpcOptions());
    const metadata = new Metadata();
    metadata.set('x-fixture-mode', mode);
    metadata.set('x-fixture-scenario', scenario);
    metadata.set('x-fixture-invocation', invocation);
    let surface;
    const result = new Promise(resolve => {
        surface = client.makeUnaryRequest('/fixture.Legacy/Echo', value => Buffer.from(value), value => value.toString(),
            scenario, metadata, { deadline: Date.now() + (scenario === 'deadline' || scenario === 'returned-only' ? 100 : 10000) }, (error, value) => {
                callbacks++;
                resolve({ code: error?.code ?? status.OK, details: error?.details, value });
            });
    });
    surface.on('status', value => statuses.push(value.code));
    try {
        if (scenario === 'cancel' || scenario === 'deadline' || scenario === 'returned-only') {
            await ready;
            // A real outbound boundary gives the pending authentication call a turn.
            await fetch('https://control.fixture.invalid/turn');
            if (scenario === 'cancel') surface.cancel();
        }
        const actual = await result;
        const expected = succeeds.has(scenario) ? status.OK : scenario === 'cancel' ? status.CANCELLED
            : scenario === 'deadline' || scenario === 'returned-only' ? status.DEADLINE_EXCEEDED
                : scenario === 'missing' || scenario === 'invalid' ? status.UNKNOWN : status.UNAUTHENTICATED;
        assert.equal(actual.code, expected, 'terminal code');
        if (succeeds.has(scenario)) assert.equal(actual.value, scenario);
        else if (expected !== status.CANCELLED && expected !== status.DEADLINE_EXCEEDED) assert.equal(actual.details, 'WGA_AUTH_METADATA');
        if (scenario === 'cancel' || scenario === 'deadline' || scenario === 'returned-only') {
            callback(null, { authorization: 'Bearer fixture-late' });
            callback(new Error('fixture-secret-late-error'));
        }
        await turns();
        await fetch('https://control.fixture.invalid/turn');
        assert.equal(callbacks, 1, 'callback count');
        assert.deepEqual(statuses, [expected], 'status count');
        assert.equal(legacyCalls, scenario.startsWith('modern') ? 0 : 1, 'legacy selection');
        assert.equal(modernCalls, scenario.startsWith('modern') ? 1 : 0, 'modern selection');
        let call = surface.call;
        while (call && typeof call.diagnostics !== 'function') call = call.call ?? call.nextCall;
        assert.ok(call, 'transport diagnostics');
        assert.deepEqual(call.diagnostics(), { terminal: true, fetchCount: succeeds.has(scenario) ? 1 : 0, requestBytes: 0, responseBytes: 0, timerActive: false });
        assert.equal(client.getChannel().activeCallCount(), 0);
        return { mode, scenario, code: expected, callbacks, statuses: statuses.length, legacyCalls, modernCalls, rpcCount: succeeds.has(scenario) ? 1 : 0 };
    } finally { client.close(); }
}

export default {
    async fetch(request) {
        const invocation = new URL(request.url).pathname.slice(1);
        try {
            assert.ok(['cold', 'warm'].includes(invocation));
            const cases = [];
            for (const mode of ['cloudflare', 'grpc-web']) for (const scenario of scenarios) cases.push(await exercise(mode, invocation, scenario));
            return Response.json({ status: 'passed', invocation, cases });
        } catch {
            // Credential contents and provider errors never enter the fixture response.
            return Response.json({ status: 'failed', diagnostic: 'LEGACY_AUTH_FIXTURE' }, { status: 500 });
        }
    },
};
