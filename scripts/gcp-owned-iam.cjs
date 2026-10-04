'use strict';
const { createHash } = require('node:crypto');

const ROLE = 'roles/iam.serviceAccountTokenCreator';
const API = 'https://iam.googleapis.com/v1/';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, mutationAttempted = false) {
    // Never include API response bodies, credentials, or arbitrary thrown text.
    throw Object.assign(new Error(code), { code, mutationAttempted });
}

function targetFor(project, run, record) {
    if (typeof project !== 'string' || /\s/.test(project) || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) ||
        typeof run !== 'string' || /\s/.test(run) || !/^wga-probe-\d{8}-[a-f0-9]{8}$/.test(run)) {
        fail('OWNED_IAM_INVALID_SCOPE');
    }
    if (!isObject(record) || record.kind !== 'service-account' || record.owned !== true ||
        record.created !== true || record.creationIdentityVerified !== true ||
        record.creationSettled !== true || record.absentBefore !== true || record.attempted !== true ||
        record.ambiguousCreate || record.collision || record.deleted ||
        typeof record.uid !== 'string' || /\s/.test(record.uid) || !/^[1-9]\d{9,29}$/.test(record.uid)) {
        fail('OWNED_IAM_UNPROVEN_OWNERSHIP');
    }
    const suffix = `@${project}.iam.gserviceaccount.com`;
    if (typeof record.name !== 'string' || !record.name.endsWith(suffix) ||
        !/^wga-probe-[a-f0-9]{12}$/.test(record.name.slice(0, -suffix.length)) ||
        record.url !== `${API}projects/${project}/serviceAccounts/${record.name}` ||
        (record.description !== undefined && record.description !== run)) {
        fail('OWNED_IAM_RESOURCE_MISMATCH');
    }
    return `projects/${project}/serviceAccounts/${record.uid}`;
}

function validatePrincipal(principal) {
    if (typeof principal !== 'string' || /\s/.test(principal)) fail('OWNED_IAM_INVALID_PRINCIPAL');
    const match = /^(user|serviceAccount):([^:]+)$/.exec(principal);
    const email = match?.[2];
    if (!email || email.length > 254 ||
        !/^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email) ||
        email.slice(0, email.indexOf('@')).length > 64 ||
        (match[1] === 'serviceAccount' && !email.endsWith('.gserviceaccount.com'))) {
        fail('OWNED_IAM_INVALID_PRINCIPAL');
    }
}

function policyShape(policy) {
    if (!isObject(policy) || Object.keys(policy).some(key => !['version', 'bindings', 'auditConfigs', 'etag'].includes(key)) ||
        (policy.version !== undefined && ![0, 1, 3].includes(policy.version)) ||
        (policy.bindings !== undefined && !Array.isArray(policy.bindings)) ||
        (policy.auditConfigs !== undefined && !Array.isArray(policy.auditConfigs)) ||
        typeof policy.etag !== 'string' || policy.etag.length === 0 || policy.etag.length > 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(policy.etag) ||
        Buffer.from(policy.etag, 'base64').toString('base64') !== policy.etag) return false;
    return true;
}

function exactGrant(policy, principal) {
    // A version-3 read is a maximum format version, not an exact version promise.
    // Valid 0/default, 1 and 3 formats are equivalent for this unconditional grant;
    // bindings must still have exactly role + members, with no condition field.
    if (!policyShape(policy) || (policy.auditConfigs?.length ?? 0) !== 0 ||
        policy.bindings?.length !== 1) return false;
    const binding = policy.bindings[0];
    return isObject(binding) && Object.keys(binding).length === 2 && binding.role === ROLE &&
        Array.isArray(binding.members) && binding.members.length === 1 && binding.members[0] === principal;
}

/**
 * Opt-in only, for the probe's newly created SA. This grants access TO the SA;
 * it neither grants the SA project roles nor proves it has no inherited access.
 * The caller must separately authorize the grant and delete its owned SA in
 * finally, including when an uncertain write or verification failure is thrown.
 * api(url, method, body?) returns {status, data}; this module has no auth/network
 * default, does not retry writes, and never creates service-account keys.
 *
 * REST method/body mapping and optimistic concurrency:
 * https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/getIamPolicy
 * https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/setIamPolicy
 * https://docs.cloud.google.com/iam/docs/reference/rest/v1/Policy
 * https://docs.cloud.google.com/iam/docs/allow-policies
 */
async function grantOwnedServiceAccountTokenCreator({ enabled, project, run, record, principal, api } = {}) {
    if (enabled !== true) fail('OWNED_IAM_EXPLICIT_OPT_IN_REQUIRED');
    const resource = targetFor(project, run, record);
    validatePrincipal(principal);
    if (typeof api !== 'function') fail('OWNED_IAM_API_REQUIRED');
    const email = record.name, uid = record.uid;
    const url = API + resource;
    // getIamPolicy is POST with no body; options is an HTTP query parameter.
    const policyUrl = `${url}:getIamPolicy?options.requestedPolicyVersion=3`;
    let mutationAttempted = false;
    const request = async (target, method, body) => {
        let response;
        try { response = await api(target, method, body); }
        catch { fail('OWNED_IAM_API_FAILED', mutationAttempted); }
        if (!isObject(response) || response.status !== 200 || !isObject(response.data) || response.data.error) {
            fail('OWNED_IAM_API_FAILED', mutationAttempted);
        }
        return response.data;
    };
    const checkIdentity = async () => {
        const value = await request(url, 'GET');
        if (value.projectId !== project || value.uniqueId !== uid || value.email !== email ||
            value.description !== run || (value.disabled !== undefined && value.disabled !== false) ||
            ![`projects/${project}/serviceAccounts/${email}`, resource].includes(value.name)) {
            fail('OWNED_IAM_IDENTITY_CHANGED', mutationAttempted);
        }
    };
    await checkIdentity();
    const before = await request(policyUrl, 'POST');
    if (!policyShape(before) || (before.bindings?.length ?? 0) !== 0 || (before.auditConfigs?.length ?? 0) !== 0) {
        fail('OWNED_IAM_POLICY_NOT_EMPTY');
    }
    const etag = before.etag;
    await checkIdentity();
    if (targetFor(project, run, record) !== resource || record.name !== email) fail('OWNED_IAM_IDENTITY_CHANGED');
    mutationAttempted = true;
    const written = await request(`${url}:setIamPolicy`, 'POST', {
        policy: { version: 3, etag, bindings: [{ role: ROLE, members: [principal] }] },
        updateMask: 'bindings,etag,version',
    });
    if (!exactGrant(written, principal) || written.etag === etag) fail('OWNED_IAM_POLICY_RESULT_MISMATCH', true);
    const confirmed = await request(policyUrl, 'POST');
    if (!exactGrant(confirmed, principal) || confirmed.etag !== written.etag) fail('OWNED_IAM_POLICY_CONFIRMATION_MISMATCH', true);
    await checkIdentity();
    return {
        status: 'granted', resourceUid: uid, role: ROLE, principalKind: principal.split(':')[0],
        policyVersion: confirmed.version ?? 0,
        policyEtagSha256: createHash('sha256').update(confirmed.etag).digest('hex'),
        bindingCount: 1, memberCount: 1, policyVerified: true, keysCreated: 0,
        projectIamChanged: false, cleanup: 'delete-owned-service-account',
    };
}

module.exports = { grantOwnedServiceAccountTokenCreator };
