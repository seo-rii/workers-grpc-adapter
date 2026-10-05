'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { parseOptions, runDedicatedProbe } = require('../scripts/gcp-dedicated-probe.cjs');
const { planOwnedProject } = require('../scripts/gcp-owned-project.cjs');
const optIn = ['--create-dedicated-project', '--link-unique-billing-account'];

function fixture() {
    const plan = planOwnedProject(() => Buffer.alloc(12, 0xac));
    const events = [], saved = [];
    const record = { ...plan, name: 'projects/123456789012', created: true, creationSettled: true,
        absentBefore: true, billingAccountName: 'billingAccounts/SYNTHETIC' };
    const report = { project: plan.projectId, projectNumber: '123456789012', dedicatedProject: true,
        run: 'wga-probe-synthetic', allCreatedResourcesDeleted: true, existingResourcesUnchanged: true };
    const options = { plan, options: parseOptions([...optIn, '--catalog', '--soak-seconds=60', '--soak-burst=4']),
        persist(value) { events.push('persist'); saved.push(structuredClone(value)); },
        request() { throw new Error('Network forbidden'); },
        async prepare({ onOwned }) { events.push('prepare'); onOwned(record); return record; },
        async runProbe(args) { events.push('probe'); assert.ok(args.includes(`--project=${plan.projectId}`));
            assert.ok(args.includes('--dedicated-project')); assert.ok(args.includes('--soak-burst=4'));
            return { exitCode: 0, report }; },
        async cleanup({ record: owned }) { events.push('cleanup'); assert.deepEqual(owned, record);
            return { status: 'delete-requested', billingUnlinked: true, state: 'DELETE_REQUESTED', finalDeletionPending: true }; },
    };
    return { options, record, report, events, saved };
}

test('dedicated provisioning needs both exact flags and cannot target an existing project', () => {
    for (const args of [[], optIn.slice(0, 1), optIn.slice(1), [...optIn, '--project=existing'],
        [...optIn, '--link-unique-billing-account=false'], [...optIn, optIn[0]], [...optIn, '--unknown'],
        [...optIn, '--grant-owned-token-creator'], [...optIn, '--soak-burst=4'], [...optIn, '--region=invalid']]) {
        assert.throws(() => parseOptions(args));
    }
    assert.deepEqual(parseOptions([...optIn, '--catalog', '--verify-auth-renewal', '--grant-owned-token-creator']), {
        region: 'asia-northeast3', probeArgs: ['--catalog', '--verify-auth-renewal', '--grant-owned-token-creator'],
    });
    const child = spawnSync(process.execPath, ['scripts/gcp-dedicated-probe.cjs', '--project=existing'], {
        cwd: require('node:path').resolve(__dirname, '..'), env: { PATH: '', CF_TOKEN: 'synthetic-never-used' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 1); assert.match(child.stderr, /DEDICATED_INVALID_OPTIONS/);
    assert.ok(!child.stderr.includes('synthetic-never-used'));
});

test('plan is saved before provisioning and child completes before project cleanup', async () => {
    const f = fixture(); const result = await runDedicatedProbe(f.options);
    assert.equal(result.status, 'passed'); assert.equal(result.releaseEligible, false);
    assert.equal(f.events[0], 'persist');
    assert.ok(f.events.indexOf('prepare') < f.events.indexOf('probe'));
    assert.ok(f.events.indexOf('probe') < f.events.indexOf('cleanup'));
    assert.equal(f.saved[0].ownership, undefined); assert.deepEqual(f.saved[1].ownership, f.record);
    assert.equal(result.projectCleanup.finalDeletionPending, true);
});

test('child failure, invalid receipt and unremoved CF resources still clean owned GCP project but never pass', async () => {
    for (const mode of ['failed', 'stale', 'foreign-number', 'cf-remains', 'spawn-error']) {
        const f = fixture();
        f.options.runProbe = async () => {
            if (mode === 'spawn-error') throw Object.assign(new Error('private marker'), { code: 'DEDICATED_CHILD_START_FAILED' });
            if (mode === 'stale') f.report.project = 'existing-project';
            if (mode === 'foreign-number') f.report.projectNumber = '999999999999';
            if (mode === 'cf-remains') f.report.allCreatedResourcesDeleted = false;
            return { exitCode: mode === 'failed' ? 1 : 0, report: f.report };
        };
        const result = await runDedicatedProbe(f.options);
        assert.equal(result.status, 'failed'); assert.equal(f.events.filter(event => event === 'cleanup').length, 1);
        assert.equal(result.projectCleanup.state, 'DELETE_REQUESTED');
        assert.ok(!JSON.stringify(f.saved).includes('private marker'));
        if (mode === 'cf-remains') assert.equal(result.child.allCreatedResourcesDeleted, false);
        if (mode === 'failed') assert.equal(result.child.exitCode, 1);
    }
});

test('setup cleanup is not repeated and uncertain creation retains recovery data without deleting', async () => {
    for (const mode of ['cleaned', 'ambiguous']) {
        const f = fixture();
        f.options.prepare = async ({ onOwned }) => {
            if (mode === 'cleaned') onOwned(f.record);
            throw Object.assign(new Error('private marker'), { code: 'OWNED_PROJECT_CREATE_AMBIGUOUS',
                cleanupCompleted: mode === 'cleaned', operationName: 'operations/create-owned' });
        };
        const result = await runDedicatedProbe(f.options);
        assert.equal(result.status, 'failed'); assert.equal(f.events.includes('probe'), false);
        assert.equal(f.events.includes('cleanup'), false); assert.equal(result.creationOperation, 'operations/create-owned');
        assert.equal(result.projectCleanup?.status ?? null, mode === 'cleaned' ? 'delete-requested' : null);
        assert.ok(!JSON.stringify(f.saved).includes('private marker'));
    }
});

test('interruption after setup skips deployment and cleans only proven ownership', async () => {
    const f = fixture(); let stopped = false;
    const prepare = f.options.prepare;
    f.options.prepare = async options => { const value = await prepare(options); stopped = true; return value; };
    f.options.interrupted = () => stopped;
    const result = await runDedicatedProbe(f.options);
    assert.equal(result.error, 'DEDICATED_INTERRUPTED'); assert.equal(result.status, 'failed');
    assert.equal(f.events.includes('probe'), false); assert.equal(f.events.includes('cleanup'), true);
});

test('project cleanup failures remain failures even when probe and resource deletion pass', async () => {
    const f = fixture();
    f.options.cleanup = async () => { throw Object.assign(new Error('private marker'), { code: 'OWNED_PROJECT_PERMISSION_DENIED' }); };
    const result = await runDedicatedProbe(f.options);
    assert.equal(result.status, 'failed'); assert.equal(result.child.exitCode, 0);
    assert.deepEqual(result.projectCleanup, { status: 'failed', error: 'OWNED_PROJECT_PERMISSION_DENIED' });
    assert.ok(!JSON.stringify(f.saved).includes('private marker'));
});
