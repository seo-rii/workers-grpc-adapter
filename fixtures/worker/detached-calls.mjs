// RPCs still running when a Worker returns its Response, as when an SDK leaves
// a Rollback in the background or drains a RunQuery stream after get() has
// resolved. One transport and client are shared by every request in the isolate.
import { Buffer } from 'node:buffer';
import { Client, credentials } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const serialize = value => Buffer.from(JSON.stringify(value));
const deserialize = bytes => JSON.parse(bytes.toString());
const events = [];
let shared;
function setup(env, scenario) {
    if (shared?.scenario === scenario) return shared;
    const limits = scenario === 'admission' ? { maxConcurrentCalls: 2 } : undefined;
    const transport = createWorkersGrpcTransport({ mode: 'grpc-web', allowInsecureLocalhost: true,
        defaultTimeoutMs: Number(env.DEADLINE_MS), endpoints: { 'peer.test:443': `http://127.0.0.1:${env.PEER_PORT}` },
        ...(limits ? { resourceLimits: limits } : {}) });
    const client = new Client('peer.test:443', credentials.createInsecure(), transport.grpcOptions());
    shared = { scenario, transport, client };
    return shared;
}
function usage(state) {
    const { activeCalls, queuedCalls, bufferedBytes, peakActiveCalls } = state.transport.resourceUsage();
    return { activeCalls, queuedCalls, bufferedBytes, peakActiveCalls, channelCalls: state.client.getChannel().activeCallCount() };
}
// Resolves on the first message and leaves the trailer pending, like an SDK
// stream that ends locally before the RPC does.
function firstMessage(state, tag) {
    const call = state.client.makeServerStreamRequest('/peer.Detached/Stream', serialize, deserialize, { tag }, {});
    call.on('error', error => events.push({ tag, event: 'error', code: error.code, details: error.details }));
    call.on('status', value => events.push({ tag, event: 'status', code: value.code, details: value.details }));
    return new Promise((resolve, reject) => { call.once('data', resolve); call.once('error', reject); });
}
function unary(state, tag, done = () => {}) {
    state.client.makeUnaryRequest('/peer.Detached/Unary', serialize, deserialize, { tag }, {}, (error, value) => {
        events.push({ tag, event: 'callback', code: error?.code ?? 0, details: error?.details ?? '' });
        done(error ? { code: error.code, details: error.details } : { code: 0, value });
    });
}
async function idle(state, maxMs) {
    const end = Date.now() + maxMs;
    while (Date.now() < end && state.transport.resourceUsage().activeCalls > 0) await new Promise(resolve => setTimeout(resolve, 5));
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const scenario = url.searchParams.get('scenario');
        const state = setup(env, scenario);
        switch (url.pathname) {
        case '/start': {
            if (scenario === 'stream-drain' || scenario === 'wait-until') {
                const first = await firstMessage(state, scenario);
                // Retains this request only for its own calls; a bounded wait is
                // not durable background work.
                if (scenario === 'wait-until') ctx.waitUntil(idle(state, 5000));
                return Response.json({ first, usage: usage(state) });
            }
            if (scenario === 'detached-unary') {
                unary(state, scenario);
                await new Promise(resolve => setTimeout(resolve, 20));
                return Response.json({ usage: usage(state) });
            }
            if (scenario === 'admission') {
                await firstMessage(state, 'admission-stream');
                unary(state, 'admission-unary');
                await new Promise(resolve => setTimeout(resolve, 20));
                return Response.json({ usage: usage(state) });
            }
            return new Response('unknown scenario', { status: 404 });
        }
        case '/observe': {
            const observed = usage(state);
            // Expiry delivers statuses asynchronously, in this request.
            await new Promise(resolve => setTimeout(resolve, 10));
            return Response.json({ usage: observed, events: events.splice(0) });
        }
        case '/call': {
            const result = await new Promise(resolve => unary(state, `${scenario}-later`, resolve));
            return Response.json({ result, usage: usage(state), events: events.splice(0) });
        }
        default: return new Response('not found', { status: 404 });
        }
    },
};
