'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planOwnedProject, prepareOwnedProject, cleanupOwnedProject, SERVICES } = require('../scripts/gcp-owned-project.cjs');

const RESOURCE = 'https://cloudresourcemanager.googleapis.com/v3/';
const BILLING = 'https://cloudbilling.googleapis.com/v1/';
const USAGE = 'https://serviceusage.googleapis.com/v1/';
const NUMBER = '123456789012';
const ACCOUNT = 'billingAccounts/ABCDEF-123456-ABCDEF';
const clone = value => structuredClone(value);

function fixture() {
    const plan = planOwnedProject(() => Buffer.alloc(12, 0xab));
    const calls = [];
    const state = { project: null, billing: '', services: new Set(), accounts: [{ name: ACCOUNT, open: true }],
        permission: true, existingProject: { projectId: 'existing-production-project', name: 'projects/987654321098' } };
    const projectUrl = RESOURCE + `projects/${plan.projectId}`;
    const numberUrl = RESOURCE + `projects/${NUMBER}`;
    const billingUrl = BILLING + `projects/${plan.projectId}/billingInfo`;
    const result = data => ({ status: 200, data: clone(data) });
    async function request(url, method, body) {
        calls.push([url, method, clone(body)]);
        if (url === projectUrl && method === 'GET' || url === numberUrl && method === 'GET')
            return state.project ? result(state.project) : { status: 404, data: {} };
        if (url === RESOURCE + 'projects' && method === 'POST') {
            if (state.project) return { status: 409, data: {} };
            state.project = { name: `projects/${NUMBER}`, projectId: plan.projectId, state: 'ACTIVE', labels: clone(body.labels) };
            return result({ name: 'operations/create-1', done: true, response: state.project });
        }
        if (url === BILLING + 'billingAccounts' && method === 'GET')
            return result({ billingAccounts: state.accounts });
        if (url === BILLING + ACCOUNT + ':testIamPermissions' && method === 'POST')
            return result({ permissions: state.permission ? ['billing.resourceAssociations.create'] : [] });
        if (url === billingUrl && method === 'GET')
            return result({ name: `projects/${plan.projectId}/billingInfo`, projectId: plan.projectId,
                billingAccountName: state.billing, billingEnabled: Boolean(state.billing) });
        if (url === billingUrl && method === 'PUT') {
            state.billing = body.billingAccountName;
            return result({ name: `projects/${plan.projectId}/billingInfo`, projectId: plan.projectId,
                billingAccountName: state.billing, billingEnabled: Boolean(state.billing) });
        }
        if (url === USAGE + `projects/${NUMBER}/services:batchEnable` && method === 'POST') {
            assert.deepEqual(body, { serviceIds: [...SERVICES] });
            for (const service of body.serviceIds) state.services.add(service);
            return result({ name: 'operations/services-1', done: true, response: {} });
        }
        for (const service of SERVICES) {
            if (url === USAGE + `projects/${NUMBER}/services/${service}` && method === 'GET')
                return result({ name: `projects/${NUMBER}/services/${service}`,
                    state: state.services.has(service) ? 'ENABLED' : 'DISABLED' });
        }
        if (url === numberUrl && method === 'DELETE') {
            state.project.state = 'DELETE_REQUESTED';
            return result({ name: 'operations/delete-1', done: true, response: {} });
        }
        throw new Error('Unexpected fake API request');
    }
    const options = { request, plan, pause: async () => {}, maxPolls: 2 };
    return { options, plan, calls, state, projectUrl, numberUrl, billingUrl, request };
}

test('random plan is a valid, distinct project ID with an owned label', () => {
    let next = 0;
    const first = planOwnedProject(() => Buffer.alloc(12, next++));
    const second = planOwnedProject(() => Buffer.alloc(12, next++));
    assert.match(first.projectId, /^wga-[a-f0-9]{24}$/);
    assert.notEqual(first.projectId, second.projectId);
    assert.deepEqual(first.labels, { 'wga-owner': first.projectId, 'wga-purpose': 'probe' });
    assert.throws(() => planOwnedProject(() => Buffer.alloc(11)), { code: 'OWNED_PROJECT_INVALID_RANDOM' });
});

test('fresh project is created by ID, verified by immutable number, billed and enabled only at that number', async () => {
    const f = fixture(); const owned = [];
    f.options.onOwned = value => owned.push(clone(value));
    const record = await prepareOwnedProject(f.options);
    assert.equal(record.name, `projects/${NUMBER}`);
    assert.equal(record.billingAccountName, ACCOUNT);
    assert.equal(owned.length, 2);
    assert.equal(owned[0].billingAccountName, null);
    assert.equal(owned[1].billingAccountName, ACCOUNT);
    assert.deepEqual(f.state.project.labels, f.plan.labels);
    assert.deepEqual([...f.state.services].sort(), [...SERVICES].sort());
    const writes = f.calls.filter(([, method]) => ['POST', 'PUT', 'DELETE'].includes(method));
    assert.ok(writes.some(([url, method]) => url === RESOURCE + 'projects' && method === 'POST'));
    assert.ok(writes.some(([url, method, body]) => url === f.billingUrl && method === 'PUT' && body.billingAccountName === ACCOUNT));
    assert.ok(writes.some(([url, method]) => url === USAGE + `projects/${NUMBER}/services:batchEnable` && method === 'POST'));
    assert.ok(writes.every(([url]) => !url.includes(f.state.existingProject.projectId) && !url.includes('987654321098')));
    const cleaned = await cleanupOwnedProject({ request: f.request, record });
    assert.deepEqual(cleaned, { status: 'delete-requested', projectId: f.plan.projectId, projectNumber: NUMBER,
        billingUnlinked: true, state: 'DELETE_REQUESTED', finalDeletionPending: true });
    assert.equal(f.state.billing, '');
    assert.equal(f.state.project.state, 'DELETE_REQUESTED');
    assert.deepEqual(f.state.existingProject, { projectId: 'existing-production-project', name: 'projects/987654321098' });
});

test('existing project ID and permission errors block creation before any mutation', async () => {
    for (const response of [{ status: 200, data: {} }, { status: 403, data: {} }]) {
        const f = fixture(); f.options.request = async (...args) => args[0] === f.projectUrl ? response : f.request(...args);
        await assert.rejects(prepareOwnedProject(f.options), { code: response.status === 200 ? 'OWNED_PROJECT_COLLISION' : 'OWNED_PROJECT_PERMISSION_DENIED' });
        assert.equal(f.calls.length, 0);
        assert.equal(f.state.project, null);
    }
});

test('ambiguous create acknowledgment never claims ownership or deletes a possibly created project', async () => {
    for (const ambiguous of ['response', 'throw']) {
        const f = fixture();
        f.options.request = async (...args) => {
            const reply = await f.request(...args);
            if (args[0] === RESOURCE + 'projects' && args[1] === 'POST') {
                if (ambiguous === 'throw') throw new Error('private API detail');
                return { status: 200, data: {} };
            }
            return reply;
        };
        await assert.rejects(prepareOwnedProject(f.options), error => error.code === 'OWNED_PROJECT_CREATE_AMBIGUOUS' &&
            error.plan.projectId === f.plan.projectId && error.operationName === null &&
            error.reconciliationRequired === true && !String(error).includes('private API detail'));
        assert.ok(f.state.project);
        assert.equal(f.state.billing, '');
        assert.equal(f.calls.filter(([, method]) => method === 'DELETE').length, 0);
        assert.equal(f.calls.filter(([url]) => url.startsWith(USAGE)).length, 0);
    }
});

test('uncertain create operation retains its safe name and plan for manual reconciliation', async () => {
    const f = fixture(); f.options.request = async (...args) => {
        const reply = await f.request(...args);
        if (args[0] === RESOURCE + 'projects' && args[1] === 'POST')
            return { status: 200, data: { name: 'operations/create-2', done: false } };
        if (args[0] === RESOURCE + 'operations/create-2') return { status: 403, data: {} };
        return reply;
    };
    await assert.rejects(prepareOwnedProject(f.options), error => error.code === 'OWNED_PROJECT_CREATE_AMBIGUOUS' &&
        error.plan.projectId === f.plan.projectId && error.operationName === 'operations/create-2' &&
        error.reconciliationRequired === true);
    assert.equal(f.calls.filter(([, method]) => method === 'DELETE').length, 0);
});

test('invalid create number or label is never promoted to owned status', async () => {
    for (const change of [value => { value.name = 'projects/not-a-number'; },
        value => { value.projectId = 'existing-production-project'; },
        value => { value.labels['wga-owner'] = 'someone-else'; }]) {
        const f = fixture(); f.options.request = async (...args) => {
            const reply = await f.request(...args);
            if (args[0] === RESOURCE + 'projects' && args[1] === 'POST') change(reply.data.response);
            return reply;
        };
        await assert.rejects(prepareOwnedProject(f.options), error => error.code.startsWith('OWNED_PROJECT_'));
        assert.equal(f.calls.filter(([, method]) => method === 'DELETE').length, 0);
    }
});

test('multiple or paginated billing accounts block linking and clean the owned project', async () => {
    for (const mutate of [value => { value.billingAccounts.push({ name: 'billingAccounts/OTHER', open: true }); },
        value => { value.nextPageToken = 'more'; }, value => { value.billingAccounts[0].open = false; }]) {
        const f = fixture(); f.options.request = async (...args) => {
            const reply = await f.request(...args);
            if (args[0] === BILLING + 'billingAccounts') mutate(reply.data);
            return reply;
        };
        await assert.rejects(prepareOwnedProject(f.options), { code: 'OWNED_PROJECT_BILLING_NOT_UNIQUE', cleanupCompleted: true });
        assert.equal(f.state.billing, '');
        assert.equal(f.state.project.state, 'DELETE_REQUESTED');
        assert.equal(f.calls.filter(([url, method]) => url === f.billingUrl && method === 'PUT').length, 0);
    }
});

test('missing billing permission cleans the newly owned project without linking', async () => {
    const f = fixture(); f.state.permission = false;
    await assert.rejects(prepareOwnedProject(f.options), { code: 'OWNED_PROJECT_BILLING_PERMISSION_DENIED', cleanupCompleted: true });
    assert.equal(f.state.billing, '');
    assert.equal(f.state.project.state, 'DELETE_REQUESTED');
    assert.equal(f.calls.filter(([url, method]) => url === f.billingUrl && method === 'PUT').length, 0);
});

test('service enable permission failure after billing links still unlinks and requests deletion', async () => {
    const f = fixture(); f.options.request = async (...args) => {
        if (args[0] === USAGE + `projects/${NUMBER}/services:batchEnable`) {
            f.calls.push(clone(args)); return { status: 403, data: {} };
        }
        return f.request(...args);
    };
    await assert.rejects(prepareOwnedProject(f.options), { code: 'OWNED_PROJECT_PERMISSION_DENIED', cleanupCompleted: true });
    assert.equal(f.state.billing, '');
    assert.equal(f.state.project.state, 'DELETE_REQUESTED');
    assert.deepEqual(f.calls.filter(([url, method, body]) => url === f.billingUrl && method === 'PUT').map(([, , body]) => body.billingAccountName),
        [ACCOUNT, '']);
});

test('changed label, number, or account prevents cleanup writes and project deletion', async () => {
    for (const mutate of [
        f => { f.state.project.labels['wga-owner'] = 'foreign'; },
        f => { f.state.project.name = 'projects/999999999999'; },
        f => { f.state.billing = 'billingAccounts/OTHER'; },
    ]) {
        const f = fixture(); const record = await prepareOwnedProject(f.options);
        mutate(f); const before = f.calls.length;
        await assert.rejects(cleanupOwnedProject({ request: f.request, record }), error =>
            ['OWNED_PROJECT_IDENTITY_CHANGED', 'OWNED_PROJECT_BILLING_IDENTITY_CHANGED'].includes(error.code));
        assert.ok(f.calls.slice(before).every(([, method]) => method === 'GET'));
        assert.equal(f.state.project.state, 'ACTIVE');
    }
});

test('uncertain billing unlink does not proceed to project deletion', async () => {
    const f = fixture(); const record = await prepareOwnedProject(f.options);
    const guarded = async (...args) => {
        const response = await f.request(...args);
        if (args[0] === f.billingUrl && args[1] === 'PUT' && args[2].billingAccountName === '')
            return { status: 200, data: {} };
        return response;
    };
    await assert.rejects(cleanupOwnedProject({ request: guarded, record }), { code: 'OWNED_PROJECT_BILLING_RESULT_MISMATCH' });
    assert.equal(f.calls.filter(([, method]) => method === 'DELETE').length, 0);
});

test('cleanup accepts omitted ProtoJSON defaults only after billing readback', async () => {
    const f = fixture(); const record = await prepareOwnedProject(f.options);
    const omitDefaults = async (...args) => {
        const response = await f.request(...args);
        if (args[0] === f.billingUrl && !f.state.billing) {
            delete response.data.billingAccountName;
            delete response.data.billingEnabled;
        }
        return response;
    };
    const result = await cleanupOwnedProject({ request: omitDefaults, record });
    assert.equal(result.state, 'DELETE_REQUESTED');
    assert.equal(result.billingUnlinked, true);
    assert.equal(f.state.billing, '');
    assert.equal(f.state.project.state, 'DELETE_REQUESTED');
});

test('delete acknowledgment alone is insufficient without DELETE_REQUESTED state', async () => {
    const f = fixture(); const record = await prepareOwnedProject(f.options);
    const guarded = async (...args) => {
        const response = await f.request(...args);
        if (args[0] === f.numberUrl && args[1] === 'DELETE') f.state.project.state = 'ACTIVE';
        return response;
    };
    await assert.rejects(cleanupOwnedProject({ request: guarded, record }), { code: 'OWNED_PROJECT_IDENTITY_CHANGED' });
    assert.equal(f.state.billing, '');
});

test('cleanup can verify a prior acknowledged delete after the response is lost', async () => {
    const f = fixture(); const record = await prepareOwnedProject(f.options);
    const ambiguous = async (...args) => {
        const reply = await f.request(...args);
        return args[0] === f.numberUrl && args[1] === 'DELETE' ? { status: 200, data: {} } : reply;
    };
    await assert.rejects(cleanupOwnedProject({ request: ambiguous, record }), { code: 'OWNED_PROJECT_AMBIGUOUS_OPERATION' });
    assert.equal(f.state.project.state, 'DELETE_REQUESTED');
    assert.equal(f.state.billing, '');
    const writes = f.calls.filter(([, method]) => method === 'PUT' || method === 'DELETE').length;
    const result = await cleanupOwnedProject({ request: f.request, record });
    assert.equal(result.recovered, true);
    assert.equal(result.state, 'DELETE_REQUESTED');
    assert.equal(f.calls.filter(([, method]) => method === 'PUT' || method === 'DELETE').length, writes);
});

test('already delete-requested project with linked billing is not treated as fully cleaned', async () => {
    const f = fixture(); const record = await prepareOwnedProject(f.options);
    f.state.project.state = 'DELETE_REQUESTED';
    const before = f.calls.length;
    await assert.rejects(cleanupOwnedProject({ request: f.request, record }), { code: 'OWNED_PROJECT_BILLING_IDENTITY_CHANGED' });
    assert.ok(f.calls.slice(before).every(([, method]) => method === 'GET'));
});

test('setup failure retains both failure codes if safe cleanup also fails', async () => {
    const f = fixture(); f.state.permission = false;
    f.options.request = async (...args) => {
        if (args[0] === f.numberUrl && args[1] === 'DELETE') return { status: 403, data: {} };
        return f.request(...args);
    };
    await assert.rejects(prepareOwnedProject(f.options), { code: 'OWNED_PROJECT_SETUP_CLEANUP_FAILED',
        setupCode: 'OWNED_PROJECT_BILLING_PERMISSION_DENIED', cleanupCode: 'OWNED_PROJECT_PERMISSION_DENIED', cleanupCompleted: false });
    assert.equal(f.state.project.state, 'ACTIVE');
});
