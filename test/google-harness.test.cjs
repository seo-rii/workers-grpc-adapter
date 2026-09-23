'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const helpers = import('../fixtures/google/shared/assert.mjs');
test('Google harness: dedicated write context accepted without contacting any SDK', async () => {
    const { requireWrites } = await helpers;
    requireWrites({ allowWrites: true, options: { projectId: 'test-project' }, allowedProjectId: 'test-project', runId: randomUUID() });
});
test('Google harness: writes denied without explicit opt-in', async () => {
    const { requireWrites } = await helpers;
    assert.throws(() => requireWrites({ allowWrites: false }), { code: 'WGA_FIXTURE_ASSERTION' });
});
test('Google harness: other project and unsafe resource IDs rejected', async () => {
    const { requireWrites, fixtureId } = await helpers;
    assert.throws(() => requireWrites({ allowWrites: true, options: { projectId: 'other' }, allowedProjectId: 'test' }));
    assert.throws(() => fixtureId('../../production'));
    assert.throws(() => fixtureId('small'));
});
test('Google harness: cleanup executes after success', async () => {
    const { withCleanup } = await helpers;
    let cleaned = false;
    assert.equal(await withCleanup(async () => 42, async () => {
        cleaned = true;
    }), 42);
    assert.equal(cleaned, true);
});
test('Google harness: preserves primary failure after cleanup', async () => {
    const { withCleanup } = await helpers;
    const error = new Error('primary');
    let cleaned = false;
    await assert.rejects(withCleanup(async () => {
        throw error;
    }, async () => {
        cleaned = true;
    }), e => e === error);
    assert.equal(cleaned, true);
});
test('Google harness: simultaneous cleanup failure retains both errors', async () => {
    const { withCleanup } = await helpers;
    const errors = [new Error('primary'), new Error('cleanup')];
    await assert.rejects(withCleanup(async () => {
        throw errors[0];
    }, async () => {
        throw errors[1];
    }), e => e instanceof AggregateError && e.errors[0] === errors[0] && e.errors[1] === errors[1]);
});
test('Google harness: falsy thrown value is not swallowed', async () => {
    const { withCleanup } = await helpers;
    let rejected = false;
    await withCleanup(async () => {
        throw null;
    }, async () => {
    }).catch(value => {
        rejected = true;
        assert.equal(value, null);
    });
    assert.equal(rejected, true);
});
test('Google harness: suite registry contains five SDK tests but does not import or execute SDKs', async () => {
    const { suites } = await import('../fixtures/google/suites.mjs');
    assert.equal(Object.keys(suites).length, 5);
    for (const [name, suite] of Object.entries(suites)) {
        assert.equal(typeof suite.load, 'function');
        assert.equal(suite.writes, name !== 'secret-manager-read');
    }
});
