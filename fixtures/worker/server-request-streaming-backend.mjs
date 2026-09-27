import { Buffer } from 'node:buffer';
import { createGrpcWebHandler } from '@grpc/grpc-js/server';
const cases = new Map();
const codec = { requestDeserialize: bytes => bytes.toString(), responseSerialize: value => Buffer.from(value) };
const definition = {
    client: { ...codec, path: '/fixture.BindingUpload/Client', requestStream: true, responseStream: false },
    bidi: { ...codec, path: '/fixture.BindingUpload/Bidi', requestStream: true, responseStream: true },
};
export default { async fetch(request, _env, execution) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/control/')) {
        const state = cases.get(url.pathname.slice('/control/'.length));
        return Response.json(state ? { ...state, bodyLocked: state.request.body.locked, request: undefined, cleanup: undefined } : null);
    }
    function track(input, context) {
        const id = context.metadata.get('x-case-id')[0];
        if (typeof id !== 'string' || cases.has(id)) throw new Error('Invalid case id');
        let finish;
        const cleanup = new Promise(resolve => { finish = resolve; });
        const state = { id, request, messages: 0, eof: false, closed: false, inputReleased: false, cancelled: false, cleanup };
        cases.set(id, state);
        execution.waitUntil(cleanup);
        context.signal.addEventListener('abort', () => { state.cancelled = true; }, { once: true });
        return (async function* () {
            try {
                for await (const value of input) { state.messages++; yield value; }
                state.eof = true;
            } finally {
                state.closed = true;
                // The handler's finally can run before the decoder's finally:
                // cancellation races pending input next() without awaiting it.
                // Retain this invocation through actual reader release, not
                // merely application generator completion.
                void (async () => {
                    const end = Date.now() + 2500;
                    while (request.body.locked && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 1));
                    state.inputReleased = !request.body.locked;
                    finish();
                })();
            }
        })();
    }
    const handler = createGrpcWebHandler(definition, {
        async client(input, context) { const values = []; for await (const value of track(input, context)) values.push(value); return values.join('|'); },
        async *bidi(input, context) { yield* track(input, context); },
    });
    return handler(request);
} };
