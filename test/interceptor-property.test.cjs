'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fc, check } = require('./property-helpers.cjs');
const { fixture } = require('./interceptor-helpers.cjs');

test('PROPERTY INTERCEPTOR generated continuation schedules preserve messages and close exactly once', () => {
    check(fc.property(fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 0, maxLength: 80 }),
        fc.integer({ min: 1, max: 8 }), (generated, messages) => {
            const { call, trace, continuations } = fixture({ asyncClose: true });
            let callbacks = 0;
            for (let id = 0; id < messages; id++) call.sendMessageWithContext({ callback() { callbacks++; } }, { id });
            call.halfClose();
            const actions = [continuations.start, continuations.close, () => call.halfClose(), ...continuations.message];
            const verify = () => {
                const sent = trace.filter(item => item[0] === 'message').map(item => item[1]);
                assert.deepEqual(sent, Array.from({ length: sent.length }, (_, id) => ({ id, tenant: 'rewritten' })));
                assert.equal(callbacks, sent.length);
                assert.ok(trace.filter(item => item[0] === 'start').length <= 1);
                assert.ok(trace.filter(item => item[0] === 'halfClose').length <= 1);
                if (sent.length) assert.equal(trace[0][0], 'start');
                if (trace.some(item => item[0] === 'halfClose')) {
                    assert.equal(sent.length, messages);
                    assert.equal(trace.at(-1)[0], 'halfClose');
                }
            };
            for (const index of [...generated, ...actions.map((_, index) => index)]) {
                actions[index % actions.length]();
                verify();
            }
            assert.equal(callbacks, messages);
            assert.equal(trace.at(-1)[0], 'halfClose');
        }), { numRuns: 250 });
});
