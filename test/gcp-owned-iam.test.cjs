'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { grantOwnedServiceAccountTokenCreator: grant } = require('../scripts/gcp-owned-iam.cjs');

const role = 'roles/iam.serviceAccountTokenCreator';
const stages = ['identity-before', 'policy-before', 'identity-before-write', 'policy-write', 'policy-after', 'identity-after'];
function fixture() {
    const project = 'wga-test-project', run = 'wga-probe-20261004-1234abcd', uid = '123456789012345678901';
    const email = `wga-probe-123456abcdef@${project}.iam.gserviceaccount.com`;
    const resource = `projects/${project}/serviceAccounts/${uid}`;
    const url = `https://iam.googleapis.com/v1/${resource}`;
    const principal = 'user:operator@example.test';
    const record = { kind: 'service-account', name: email, uid, url: `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${email}`,
        owned: true, created: true, absentBefore: true, attempted: true, creationSettled: true, creationIdentityVerified: true };
    const identity = { name: `projects/${project}/serviceAccounts/${email}`, email, projectId: project, uniqueId: uid, description: run };
    const before = { etag: 'AQAB' };
    const after = { version: 1, etag: 'AgAC', bindings: [{ role, members: [principal] }] };
    const calls = [];
    const responses = [identity, before, identity, after, after, identity].map(data => ({ status: 200, data: structuredClone(data) }));
    const args = { enabled: true, project, run, record, principal, api: async (...args) => {
        calls.push(structuredClone(args));
        assert.ok(responses.length, 'no extra API calls');
        return responses.shift();
    } };
    return { args, calls, responses, url, resource, identity, before, after };
}

test('IAM preparation requires explicit boolean opt-in before any API call', async () => {
    for (const enabled of [undefined, false, 0, 1, 'true', null]) {
        const { args, calls } = fixture(); args.enabled = enabled;
        await assert.rejects(grant(args), { code: 'OWNED_IAM_EXPLICIT_OPT_IN_REQUIRED', mutationAttempted: false });
        assert.equal(calls.length, 0);
    }
    await assert.rejects(grant(), { code: 'OWNED_IAM_EXPLICIT_OPT_IN_REQUIRED' });
});

test('only acknowledged fresh resources with exact project, run prefix and UID are eligible', async () => {
    for (const change of [
        x => { x.project = '-'; }, x => { x.project = 'foreign-project'; }, x => { x.run = 'production'; },
        x => { x.project += '\n'; }, x => { x.run += '\n'; }, x => { x.record.uid += '\n'; },
        x => { x.record.kind = 'database'; }, x => { x.record.name = `production@${x.project}.iam.gserviceaccount.com`; },
        x => { x.record.name = 'wga-probe-123456abcdef@other-project.iam.gserviceaccount.com'; },
        x => { x.record.uid = '123/keys'; }, x => { x.record.uid = 123456789012345678901; },
        x => { x.record.url += '?forged=true'; }, x => { x.record.description = 'another-run'; },
        ...['owned', 'created', 'creationIdentityVerified', 'creationSettled', 'absentBefore', 'attempted'].flatMap(key => [
            x => { delete x.record[key]; }, x => { x.record[key] = 'true'; },
        ]),
        ...['ambiguousCreate', 'collision', 'deleted'].map(key => x => { x.record[key] = true; }),
    ]) {
        const { args, calls } = fixture(); change(args);
        await assert.rejects(grant(args), error => error.code.startsWith('OWNED_IAM_') && error.mutationAttempted === false);
        assert.equal(calls.length, 0);
    }
});

test('principal validation excludes wildcard, deleted, group, malformed and non-service-account principals', async () => {
    for (const principal of [undefined, null, '', 'allUsers', 'allAuthenticatedUsers', 'group:operators@example.test',
        'deleted:user:operator@example.test?uid=123', 'user:*@example.test', 'user:operator@example.test\n',
        'user:operator@example.test:extra', 'user:.operator@example.test', 'user:operator..name@example.test',
        'user:operator@-example.test', 'user:operator@example.test-', 'serviceAccount:operator@example.test',
        `user:${'a'.repeat(65)}@example.test`]) {
        const { args, calls } = fixture(); args.principal = principal;
        await assert.rejects(grant(args), { code: 'OWNED_IAM_INVALID_PRINCIPAL', mutationAttempted: false });
        assert.equal(calls.length, 0);
    }
});

test('resource replacement and ownership changes abort before policy mutation', async () => {
    for (const index of [0, 2]) {
        for (const change of [
            value => { value.uniqueId = '999999999999999999999'; }, value => { value.email = 'foreign@example.test'; },
            value => { value.projectId = 'foreign-project'; }, value => { value.name = 'projects/-/serviceAccounts/123'; },
            value => { value.description = 'wga-probe-20261004-deadbeef'; }, value => { value.disabled = true; },
        ]) {
            const { args, calls, responses } = fixture(); change(responses[index].data);
            await assert.rejects(grant(args), { code: 'OWNED_IAM_IDENTITY_CHANGED', mutationAttempted: false });
            assert.equal(calls.length, index + 1);
            assert.ok(calls.every(([url]) => !url.includes(':setIamPolicy')));
        }
    }
    const { args, calls } = fixture(); const api = args.api;
    args.api = async (...request) => { const response = await api(...request); if (calls.length === 3) args.record.owned = false; return response; };
    await assert.rejects(grant(args), { code: 'OWNED_IAM_UNPROVEN_OWNERSHIP', mutationAttempted: false });
    assert.equal(calls.length, 3);
});

test('existing bindings, audit configuration and missing or malformed etags are never overwritten', async () => {
    for (const policy of [
        {}, { etag: '' }, { etag: 'bad etag' }, { etag: 'AQAB=' }, { etag: 'a'.repeat(1028) },
        { etag: 'AQAB', version: 2 }, { etag: 'AQAB', version: '1' }, { etag: 'AQAB', bindings: {} },
        { etag: 'AQAB', bindings: [{ role, members: ['user:operator@example.test'] }] },
        { etag: 'AQAB', auditConfigs: [{ service: 'allServices' }] }, { etag: 'AQAB', auditConfigs: {} },
        { etag: 'AQAB', unexpectedField: true },
    ]) {
        const { args, calls, responses } = fixture(); responses[1].data = policy;
        await assert.rejects(grant(args), { code: 'OWNED_IAM_POLICY_NOT_EMPTY', mutationAttempted: false });
        assert.equal(calls.length, 2);
        assert.ok(calls.every(([url]) => !url.includes(':setIamPolicy')));
    }
});

test('one exact grant uses immutable UID, empty-body POST policy reads and conditional original etag', async () => {
    const { args, calls, url, responses } = fixture();
    const recordBefore = structuredClone(args.record);
    const receipt = await grant(args);
    assert.equal(responses.length, 0);
    assert.deepEqual(calls, [
        [url, 'GET', undefined], [url + ':getIamPolicy?options.requestedPolicyVersion=3', 'POST', undefined],
        [url, 'GET', undefined], [url + ':setIamPolicy', 'POST', {
            policy: { version: 3, etag: 'AQAB', bindings: [{ role, members: [args.principal] }] },
            updateMask: 'bindings,etag,version',
        }], [url + ':getIamPolicy?options.requestedPolicyVersion=3', 'POST', undefined], [url, 'GET', undefined],
    ]);
    assert.deepEqual(receipt, {
        status: 'granted', resourceUid: args.record.uid, role, principalKind: 'user', policyVersion: 1,
        policyEtagSha256: require('node:crypto').createHash('sha256').update('AgAC').digest('hex'),
        bindingCount: 1, memberCount: 1, policyVerified: true, keysCreated: 0,
        projectIamChanged: false, cleanup: 'delete-owned-service-account',
    });
    assert.deepEqual(args.record, recordBefore);
    assert.ok(!JSON.stringify(receipt).includes(args.principal));
    assert.ok(!JSON.stringify(receipt).includes(args.record.name));
    assert.ok(calls.every(([target]) => target.startsWith(url) && !target.includes('/keys')));
});

test('empty valid policy versions and supported service-account principals are accepted', async () => {
    for (const version of [undefined, 0, 1, 3]) {
        const { args, responses } = fixture();
        responses[1].data = { version, etag: 'AQAB', bindings: [], auditConfigs: [] };
        const result = await grant(args); assert.equal(result.policyVerified, true);
    }
    for (const email of ['operator@other-project.iam.gserviceaccount.com', '123456789012-compute@developer.gserviceaccount.com',
        'other-project@appspot.gserviceaccount.com']) {
        const { args, responses } = fixture(); args.principal = 'serviceAccount:' + email;
        responses[3].data.bindings[0].members = [args.principal]; responses[4].data.bindings[0].members = [args.principal];
        const result = await grant(args); assert.equal(result.principalKind, 'serviceAccount');
    }
});

test('unconditional policy version normalization never relaxes exact binding checks', async () => {
    for (const written of [undefined, 0, 1, 3]) {
        for (const confirmed of [undefined, 0, 1, 3]) {
            const { args, responses } = fixture();
            responses[3].data.version = written; responses[4].data.version = confirmed;
            const receipt = await grant(args);
            assert.equal(receipt.policyVersion, confirmed ?? 0);
        }
    }
});

test('etag conflict is never retried, merged or escalated to a project policy', async () => {
    const { args, calls, responses } = fixture();
    responses[3] = { status: 409, data: { error: { message: 'sensitive-error-marker', status: 'ABORTED' } } };
    await assert.rejects(grant(args), error => error.code === 'OWNED_IAM_API_FAILED' &&
        error.mutationAttempted === true && !String(error).includes('sensitive-error-marker'));
    assert.equal(calls.length, 4);
    assert.equal(calls.filter(([url]) => url.includes(':setIamPolicy')).length, 1);
});

test('unexpected returned grants and reread races fail closed without repair writes', async () => {
    const mutations = [
        value => { value.bindings.push({ role: 'roles/owner', members: ['allUsers'] }); },
        value => { value.bindings[0].members.push('user:someone@example.test'); },
        value => { value.bindings[0].members = ['user:someone@example.test']; },
        value => { value.bindings[0].role = 'roles/owner'; },
        value => { value.bindings[0].condition = { expression: 'true' }; },
        value => { value.auditConfigs = [{ service: 'allServices' }]; },
        value => { value.version = 2; }, value => { value.version = '1'; },
        value => { value.etag = 'AQAB'; }, value => { value.etag = 'not-an-etag'; },
        value => { value.unexpectedField = true; },
    ];
    for (const index of [3, 4]) {
        for (const change of mutations) {
            const { args, calls, responses } = fixture(); change(responses[index].data);
            await assert.rejects(grant(args), { code: index === 3 ? 'OWNED_IAM_POLICY_RESULT_MISMATCH' : 'OWNED_IAM_POLICY_CONFIRMATION_MISMATCH', mutationAttempted: true });
            assert.equal(calls.length, index + 1);
            assert.equal(calls.filter(([url]) => url.includes(':setIamPolicy')).length, 1);
        }
    }
    const { args, calls, responses } = fixture(); responses[4].data.etag = 'AwAD';
    await assert.rejects(grant(args), { code: 'OWNED_IAM_POLICY_CONFIRMATION_MISMATCH', mutationAttempted: true });
    assert.equal(calls.length, 5);
});

test('resource identity must remain exact after the confirmed grant', async () => {
    const { args, calls, responses } = fixture(); responses[5].data.description = 'another-run';
    await assert.rejects(grant(args), { code: 'OWNED_IAM_IDENTITY_CHANGED', mutationAttempted: true });
    assert.equal(calls.length, 6);
    assert.equal(calls.filter(([url]) => url.includes(':setIamPolicy')).length, 1);
});

test('HTTP failures expose only the exact fixed stage, valid status and attempted-write state', async () => {
    for (let index = 0; index < stages.length; index++) {
        for (const status of [403, 404, 400, 409, 429, 503]) {
            const { args, calls, responses } = fixture();
            responses[index] = { status, data: { error: { message: `sensitive-token-marker ${args.principal} ${args.record.url}`,
                stage: 'forged-stage', httpStatus: 201, credential: 'secret-token-marker' } } };
            await assert.rejects(grant(args), error => {
                assert.deepEqual({ ...error }, { code: 'OWNED_IAM_API_FAILED', mutationAttempted: index >= 3,
                    stage: stages[index], httpStatus: status });
                assert.equal(error.message, 'OWNED_IAM_API_FAILED');
                assert.equal(error.cause, undefined);
                assert.ok(!error.stack.includes('sensitive-token-marker'));
                assert.ok(!JSON.stringify(error).includes(args.principal));
                assert.ok(!JSON.stringify(error).includes(args.record.url));
                return true;
            });
            assert.equal(calls.length, index + 1);
            assert.equal(calls.filter(([url]) => url.includes(':setIamPolicy')).length, index >= 3 ? 1 : 0);
        }
    }
});

test('malformed status values are redacted and invalid successful responses retain their HTTP status', async () => {
    for (const status of [undefined, null, '403 secret-token-marker', 99, 600, 200.5, NaN, Infinity, {}, []]) {
        const { args, calls, responses } = fixture(); responses[1] = { status, data: {} };
        await assert.rejects(grant(args), error => {
            assert.deepEqual({ ...error }, { code: 'OWNED_IAM_API_FAILED', mutationAttempted: false,
                stage: 'policy-before', httpStatus: null });
            assert.ok(!error.stack.includes('secret-token-marker'));
            return true;
        });
        assert.equal(calls.length, 2);
    }
    for (const data of [null, [], 'secret-token-marker', { error: { message: 'secret-token-marker' } }]) {
        const { args, calls, responses } = fixture(); responses[4] = { status: 200, data };
        await assert.rejects(grant(args), { code: 'OWNED_IAM_API_FAILED', mutationAttempted: true,
            stage: 'policy-after', httpStatus: 200 });
        assert.equal(calls.length, 5);
    }
});

test('successful HTTP responses with invalid identity or policy retain exact validation stages', async () => {
    for (let index = 0; index < stages.length; index++) {
        const { args, calls, responses } = fixture(); responses[index].data = {};
        const code = [0, 2, 5].includes(index) ? 'OWNED_IAM_IDENTITY_CHANGED' : index === 1
            ? 'OWNED_IAM_POLICY_NOT_EMPTY' : index === 3 ? 'OWNED_IAM_POLICY_RESULT_MISMATCH' : 'OWNED_IAM_POLICY_CONFIRMATION_MISMATCH';
        await assert.rejects(grant(args), { code, mutationAttempted: index >= 3, stage: stages[index], httpStatus: 200 });
        assert.equal(calls.length, index + 1);
    }
});

test('transport failures at every step expose only fixed diagnostics, never thrown error fields', async () => {
    for (let index = 0; index < 6; index++) {
        const { args, calls } = fixture(); const api = args.api;
        args.api = (...request) => {
            if (calls.length === index) {
                calls.push(request);
                throw Object.assign(new Error(`secret-token-marker ${args.principal} ${args.record.url}`),
                    { stage: 'forged-stage', status: 403, httpStatus: 403, mutationAttempted: false });
            }
            return api(...request);
        };
        await assert.rejects(grant(args), error => {
            assert.deepEqual({ ...error }, { code: 'OWNED_IAM_API_FAILED', mutationAttempted: index >= 3,
                stage: stages[index], httpStatus: null });
            assert.equal(error.cause, undefined);
            assert.ok(!error.stack.includes('secret-token-marker'));
            return true;
        });
        assert.equal(calls.length, index + 1);
    }
});
