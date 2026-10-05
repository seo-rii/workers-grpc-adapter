'use strict';
const { randomBytes } = require('node:crypto');

// These are the APIs used by the temporary cloud probe, including its
// before/after Artifact Registry inventory. No API outside this fixed set is
// enabled by this helper.
const SERVICES = Object.freeze([
    'run.googleapis.com', 'firestore.googleapis.com', 'datastore.googleapis.com',
    'secretmanager.googleapis.com', 'iam.googleapis.com',
    'iamcredentials.googleapis.com', 'artifactregistry.googleapis.com',
    'serviceusage.googleapis.com',
]);
const RESOURCE = 'https://cloudresourcemanager.googleapis.com/v3/';
const BILLING = 'https://cloudbilling.googleapis.com/v1/';
const USAGE = 'https://serviceusage.googleapis.com/v1/';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, stage, httpStatus = null) {
    // API bodies and arbitrary thrown messages can contain account identities.
    throw Object.assign(new Error(code), { code, stage,
        httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null });
}

function planOwnedProject(random = randomBytes) {
    if (typeof random !== 'function') fail('OWNED_PROJECT_INVALID_RANDOM', 'plan');
    const bytes = random(12);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 12) fail('OWNED_PROJECT_INVALID_RANDOM', 'plan');
    const projectId = `wga-${bytes.toString('hex')}`;
    return Object.freeze({ projectId, labels: Object.freeze({ 'wga-owner': projectId, 'wga-purpose': 'probe' }) });
}

function validPlan(plan) {
    return isObject(plan) && /^wga-[a-f0-9]{24}$/.test(plan.projectId) &&
        isObject(plan.labels) && Object.keys(plan.labels).sort().join(',') === 'wga-owner,wga-purpose' &&
        plan.labels['wga-owner'] === plan.projectId && plan.labels['wga-purpose'] === 'probe';
}

function validRecord(record) {
    return validPlan(record) && /^projects\/[1-9][0-9]{5,29}$/.test(record.name) &&
        record.created === true && record.creationSettled === true && record.absentBefore === true &&
        (record.billingAccountName === null || /^billingAccounts\/[A-Za-z0-9-]+$/.test(record.billingAccountName));
}

function optionsFor({ request, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 240 }) {
    if (typeof request !== 'function' || typeof pause !== 'function' || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 600)
        fail('OWNED_PROJECT_INVALID_OPTIONS', 'options');
    const send = async (stage, url, method, body) => {
        let response;
        try { response = await request(url, method, body); }
        catch { fail('OWNED_PROJECT_API_UNAVAILABLE', stage); }
        if (!isObject(response) || !Number.isInteger(response.status)) fail('OWNED_PROJECT_AMBIGUOUS_RESPONSE', stage);
        return response;
    };
    const read = async (stage, url) => {
        const response = await send(stage, url, 'GET');
        if (response.status === 401 || response.status === 403) fail('OWNED_PROJECT_PERMISSION_DENIED', stage, response.status);
        if (response.status !== 200) fail('OWNED_PROJECT_API_FAILED', stage, response.status);
        if (!isObject(response.data) || response.data.error) fail('OWNED_PROJECT_AMBIGUOUS_RESPONSE', stage, response.status);
        return response.data;
    };
    const write = async (stage, url, method, body) => {
        const response = await send(stage, url, method, body);
        if (response.status === 401 || response.status === 403) fail('OWNED_PROJECT_PERMISSION_DENIED', stage, response.status);
        if (![200, 201, 202].includes(response.status)) fail('OWNED_PROJECT_API_FAILED', stage, response.status);
        if (!isObject(response.data) || response.data.error) fail('OWNED_PROJECT_AMBIGUOUS_RESPONSE', stage, response.status);
        return response.data;
    };
    const operation = async (stage, base, initial) => {
        let value = initial;
        if (!isObject(value) || !/^operations\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(value.name))
            fail('OWNED_PROJECT_AMBIGUOUS_OPERATION', stage);
        for (let attempt = 0; attempt <= maxPolls; attempt++) {
            if (value.done === true) {
                if (value.error || !isObject(value.response)) fail('OWNED_PROJECT_OPERATION_FAILED', stage);
                return value.response;
            }
            if (value.done !== false && value.done !== undefined) fail('OWNED_PROJECT_AMBIGUOUS_OPERATION', stage);
            if (attempt === maxPolls) fail('OWNED_PROJECT_OPERATION_TIMEOUT', stage);
            await pause(1000);
            const next = await read(stage, base + value.name);
            if (next.name !== value.name) fail('OWNED_PROJECT_AMBIGUOUS_OPERATION', stage);
            value = next;
        }
    };
    return { send, read, write, operation };
}

function checkProject(project, record, stage, state = 'ACTIVE') {
    if (!isObject(project) || project.name !== record.name || project.projectId !== record.projectId ||
        project.state !== state || !isObject(project.labels) ||
        Object.keys(project.labels).sort().join(',') !== 'wga-owner,wga-purpose' ||
        project.labels['wga-owner'] !== record.labels['wga-owner'] ||
        project.labels['wga-purpose'] !== record.labels['wga-purpose']) {
        fail('OWNED_PROJECT_IDENTITY_CHANGED', stage, 200);
    }
}

async function verifyIdentity(io, record, stage, states = ['ACTIVE']) {
    const byId = await io.read(stage, RESOURCE + `projects/${record.projectId}`);
    if (!states.includes(byId.state)) fail('OWNED_PROJECT_IDENTITY_CHANGED', stage, 200);
    checkProject(byId, record, stage, byId.state);
    const byNumber = await io.read(stage, RESOURCE + record.name);
    checkProject(byNumber, record, stage, byId.state);
    return byNumber;
}

async function billingInfo(io, record, stage) {
    const value = await io.read(stage, BILLING + `projects/${record.projectId}/billingInfo`);
    if (value.name !== `projects/${record.projectId}/billingInfo` || value.projectId !== record.projectId ||
        (value.billingEnabled !== undefined && typeof value.billingEnabled !== 'boolean') ||
        (value.billingAccountName !== undefined && typeof value.billingAccountName !== 'string')) {
        fail('OWNED_PROJECT_BILLING_IDENTITY_CHANGED', stage, 200);
    }
    // ProtoJSON may omit empty strings and false booleans. A linked account
    // must still have billingEnabled=true at the checks below.
    return { ...value, billingEnabled: value.billingEnabled ?? false };
}

/**
 * No network/auth default. The caller should persist the generated plan before
 * calling this function; an uncertain create response cannot prove ownership.
 * request(url, method, body?) returns {status, data}. onOwned may persist the
 * immutable number after creation and again before an uncertain billing write.
 *
 * https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/create
 * https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/updateBillingInfo
 * https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/batchEnable
 */
async function prepareOwnedProject({ request, plan = planOwnedProject(), pause, maxPolls, onOwned } = {}) {
    if (!validPlan(plan) || (onOwned !== undefined && typeof onOwned !== 'function')) fail('OWNED_PROJECT_INVALID_PLAN', 'plan');
    plan = Object.freeze({ projectId: plan.projectId, labels: Object.freeze({ ...plan.labels }) });
    const io = optionsFor({ request, pause, maxPolls });
    const ambiguousCreate = (stage, httpStatus, operationName) => {
        const safeOperation = typeof operationName === 'string' && /^operations\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(operationName)
            ? operationName : null;
        throw Object.assign(new Error('OWNED_PROJECT_CREATE_AMBIGUOUS'), {
            code: 'OWNED_PROJECT_CREATE_AMBIGUOUS', stage, httpStatus: httpStatus ?? null,
            plan, operationName: safeOperation, reconciliationRequired: true,
        });
    };
    const target = RESOURCE + `projects/${plan.projectId}`;
    const preflight = await io.send('preflight', target, 'GET');
    if (preflight.status === 200) fail('OWNED_PROJECT_COLLISION', 'preflight', 200);
    if (preflight.status === 401 || preflight.status === 403) fail('OWNED_PROJECT_PERMISSION_DENIED', 'preflight', preflight.status);
    if (preflight.status !== 404) fail('OWNED_PROJECT_API_FAILED', 'preflight', preflight.status);
    let record;
    try {
        let created;
        try {
            created = await io.write('create', RESOURCE + 'projects', 'POST', {
                projectId: plan.projectId, displayName: 'WGA dedicated test', labels: plan.labels,
            });
        } catch (error) {
            if (error.code === 'OWNED_PROJECT_API_UNAVAILABLE' || error.code === 'OWNED_PROJECT_AMBIGUOUS_RESPONSE')
                ambiguousCreate('create', error.httpStatus);
            throw error;
        }
        let project;
        try { project = await io.operation('create-operation', RESOURCE, created); }
        catch (error) { ambiguousCreate('create-operation', error.httpStatus, created.name); }
        const candidate = { ...plan, name: project.name, created: true, creationSettled: true,
            absentBefore: true, billingAccountName: null };
        if (!validRecord(candidate)) ambiguousCreate('create-operation', 200, created.name);
        try { checkProject(project, candidate, 'create-operation'); }
        catch { ambiguousCreate('create-operation', 200, created.name); }
        record = Object.freeze({ ...candidate, labels: Object.freeze({ ...candidate.labels }) });
        if (onOwned) await onOwned(record);
        await verifyIdentity(io, record, 'identity-after-create');

        const accounts = await io.read('billing-accounts', BILLING + 'billingAccounts');
        if (!Array.isArray(accounts.billingAccounts) || accounts.billingAccounts.length !== 1 ||
            accounts.nextPageToken || accounts.billingAccounts[0].open !== true ||
            !/^billingAccounts\/[A-Za-z0-9-]+$/.test(accounts.billingAccounts[0].name)) {
            fail('OWNED_PROJECT_BILLING_NOT_UNIQUE', 'billing-accounts', 200);
        }
        const account = accounts.billingAccounts[0].name;
        const permissions = await io.write('billing-permission', BILLING + account + ':testIamPermissions', 'POST',
            { permissions: ['billing.resourceAssociations.create'] });
        if (!Array.isArray(permissions.permissions) || !permissions.permissions.includes('billing.resourceAssociations.create'))
            fail('OWNED_PROJECT_BILLING_PERMISSION_DENIED', 'billing-permission', 200);
        const before = await billingInfo(io, record, 'billing-before');
        if (before.billingEnabled || before.billingAccountName) fail('OWNED_PROJECT_BILLING_ALREADY_LINKED', 'billing-before', 200);
        await verifyIdentity(io, record, 'identity-before-billing');
        record = Object.freeze({ ...record, billingAccountName: account });
        if (onOwned) await onOwned(record);
        const linked = await io.write('billing-link', BILLING + `projects/${record.projectId}/billingInfo`, 'PUT',
            { billingAccountName: account });
        if (linked.name !== `projects/${record.projectId}/billingInfo` || linked.projectId !== record.projectId ||
            linked.billingAccountName !== account || linked.billingEnabled !== true) {
            fail('OWNED_PROJECT_BILLING_RESULT_MISMATCH', 'billing-link', 200);
        }
        const confirmed = await billingInfo(io, record, 'billing-after');
        if (!confirmed.billingEnabled || confirmed.billingAccountName !== account)
            fail('OWNED_PROJECT_BILLING_RESULT_MISMATCH', 'billing-after', 200);

        await verifyIdentity(io, record, 'identity-before-services');
        const enabled = await io.write('services-enable', USAGE + `${record.name}/services:batchEnable`, 'POST',
            { serviceIds: [...SERVICES] });
        await io.operation('services-operation', USAGE, enabled);
        for (const name of SERVICES) {
            const value = await io.read('service-after', USAGE + `${record.name}/services/${name}`);
            if (value.name !== `${record.name}/services/${name}` || value.state !== 'ENABLED')
                fail('OWNED_PROJECT_SERVICE_NOT_ENABLED', 'service-after', 200);
        }
        await verifyIdentity(io, record, 'identity-after-services');
        return record;
    } catch (error) {
        if (record) {
            try {
                await cleanupOwnedProject({ request, record, pause, maxPolls });
                error.cleanupCompleted = true;
            } catch (cleanupError) {
                throw Object.assign(new Error('OWNED_PROJECT_SETUP_CLEANUP_FAILED'), {
                    code: 'OWNED_PROJECT_SETUP_CLEANUP_FAILED', setupCode: error.code || 'OWNED_PROJECT_SETUP_FAILED',
                    cleanupCode: cleanupError.code || 'OWNED_PROJECT_CLEANUP_FAILED', cleanupCompleted: false,
                });
            }
        }
        throw error;
    }
}

/** Project delete is a soft delete. DELETE_REQUESTED is the required receipt. */
async function cleanupOwnedProject({ request, record, pause, maxPolls } = {}) {
    if (!validRecord(record)) fail('OWNED_PROJECT_UNPROVEN_OWNERSHIP', 'cleanup');
    const io = optionsFor({ request, pause, maxPolls });
    const current = await verifyIdentity(io, record, 'identity-before-cleanup', ['ACTIVE', 'DELETE_REQUESTED']);
    if (current.state === 'DELETE_REQUESTED') {
        const billing = await billingInfo(io, record, 'billing-after-prior-delete');
        if (billing.billingAccountName || billing.billingEnabled)
            fail('OWNED_PROJECT_BILLING_IDENTITY_CHANGED', 'billing-after-prior-delete', 200);
        return { status: 'delete-requested', projectId: record.projectId, projectNumber: record.name.slice('projects/'.length),
            billingUnlinked: true, state: 'DELETE_REQUESTED', finalDeletionPending: true, recovered: true };
    }
    const existing = await billingInfo(io, record, 'billing-before-unlink');
    if (existing.billingAccountName) {
        if (existing.billingAccountName !== record.billingAccountName || existing.billingEnabled !== true)
            fail('OWNED_PROJECT_BILLING_IDENTITY_CHANGED', 'billing-before-unlink', 200);
        const unlinked = await io.write('billing-unlink', BILLING + `projects/${record.projectId}/billingInfo`, 'PUT',
            { billingAccountName: '' });
        if (unlinked.name !== `projects/${record.projectId}/billingInfo` || unlinked.projectId !== record.projectId ||
            unlinked.billingAccountName || (unlinked.billingEnabled !== undefined && unlinked.billingEnabled !== false)) {
            fail('OWNED_PROJECT_BILLING_RESULT_MISMATCH', 'billing-unlink', 200);
        }
    } else if (existing.billingEnabled !== false) fail('OWNED_PROJECT_BILLING_IDENTITY_CHANGED', 'billing-before-unlink', 200);
    const after = await billingInfo(io, record, 'billing-after-unlink');
    if (after.billingAccountName || after.billingEnabled !== false)
        fail('OWNED_PROJECT_BILLING_RESULT_MISMATCH', 'billing-after-unlink', 200);
    await verifyIdentity(io, record, 'identity-before-delete');
    const deleted = await io.write('project-delete', RESOURCE + record.name, 'DELETE');
    await io.operation('delete-operation', RESOURCE, deleted);
    await verifyIdentity(io, record, 'identity-after-delete', ['DELETE_REQUESTED']);
    return { status: 'delete-requested', projectId: record.projectId, projectNumber: record.name.slice('projects/'.length),
        billingUnlinked: true, state: 'DELETE_REQUESTED', finalDeletionPending: true };
}

module.exports = { planOwnedProject, prepareOwnedProject, cleanupOwnedProject, SERVICES };
