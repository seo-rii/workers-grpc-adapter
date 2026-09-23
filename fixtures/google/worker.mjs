import { configureTransport, contextFor } from './bootstrap.mjs';
import { suites } from './suites.mjs';
// Test-only Worker. Deploy only to a dedicated account/project; it can write test data.
export default {
    async fetch(request, env) {
        const expected = env.WGA_TEST_KEY;
        if (typeof expected !== 'string' || expected.length < 32 ||
            request.method !== 'POST' || request.headers.get('authorization') !== `Bearer ${expected}`) {
            return new Response('Not found', { status: 404 });
        }
        if (env.WGA_RUN_GOOGLE_TESTS !== '1') {
            return new Response('Disabled', { status: 403 });
        }
        const name = new URL(request.url).pathname.slice(1);
        if (!Object.hasOwn(suites, name)) {
            return new Response('Not found', { status: 404 });
        }
        try {
            configureTransport(env, 'worker');
            const context = contextFor(env, name, crypto.randomUUID());
            const run = await suites[name].load();
            const checks = await run(context);
            return Response.json({ suite: name, status: 'passed', checks });
        }
        catch (error) {
            return Response.json({ suite: name, status: 'failed',
                code: error && typeof error.code === 'number' ? error.code : 'REDACTED_ERROR' }, { status: 500 });
        }
    },
};
