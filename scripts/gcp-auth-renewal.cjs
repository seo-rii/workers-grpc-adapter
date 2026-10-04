'use strict';

const MODES = ['native', 'grpc-web', 'cloudflare'];
const IDS = ['initial', 'cached', 'renewed', 'recached'];
const GENERATIONS = [1, 1, 2, 2];
const RECEIPT_KEYS = ['schemaVersion', 'kind', 'mode', 'status', 'observationBoundary', 'clock',
    'sourceCredential', 'sourceRefreshSupported', 'sameSdkClient', 'sameAuthClient', 'lifetimeSeconds',
    'eagerRefreshThresholdMs', 'mints', 'steps', 'wait', 'mintOperations', 'authorizationChecks',
    'tokensChanged', 'cleanup', 'startedAtMs', 'completedAtMs', 'elapsedMs'];
const MINT_KEYS = ['generation', 'httpStatus', 'startedAtMs', 'completedAtMs', 'expireTimeMs', 'remainingLifetimeMs'];
const STEP_KEYS = ['id', 'grpcCode', 'mintCount', 'authorizationCount', 'tokenGeneration', 'startedAtMs', 'completedAtMs', 'elapsedMs'];
const WAIT_KEYS = ['startedAtMs', 'previousExpiryMs', 'completedAtMs', 'elapsedMs'];

function parseAuthRenewalArgs(argv) {
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail('INVALID_AUTH_RENEWAL_OPTION');
    const selected = argv.filter(value => value.startsWith('--verify-auth-renew'));
    if (selected.length === 0) return false;
    if (selected.length !== 1 || selected[0] !== '--verify-auth-renewal') fail('INVALID_AUTH_RENEWAL_OPTION');
    if (!argv.includes('--catalog')) fail('CATALOG_REQUIRED_FOR_AUTH_RENEWAL');
    return true;
}

function exactKeys(value, expected) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && keys.every(key => expected.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function exactArray(value, length) {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length === length &&
        Reflect.ownKeys(value).length === length + 1 &&
        Array.from({ length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
            .every(item => item?.enumerable === true && Object.hasOwn(item, 'value'));
}
const integer = value => Number.isSafeInteger(value) && value >= 0;

// A successful receipt contains only this fixed evidence schema. Values from an
// untrusted report are never interpolated into diagnostics or copied on failure.
function validateCredentialRenewal(receipt, options = {}) {
    const errors = [];
    const check = (condition, code) => { if (!condition) errors.push(code); };
    const result = () => ({ valid: errors.length === 0, errors });
    try {
        const mode = options?.mode;
        check(MODES.includes(mode), 'expected-mode');
        if (!exactKeys(receipt, RECEIPT_KEYS)) { check(false, 'receipt-schema'); return result(); }
        check(receipt.schemaVersion === 1 && receipt.kind === 'credential-renewal' && receipt.status === 'passed', 'receipt-identity');
        check(receipt.mode === mode && MODES.includes(receipt.mode), 'receipt-mode');
        check(receipt.observationBoundary === (mode === 'native' ? 'auth-request-headers' : 'transport-fetch'), 'observation-boundary');
        check(receipt.clock === 'real' && receipt.sourceCredential === 'access-token-only' &&
            receipt.sourceRefreshSupported === false, 'credential-scope');
        check(receipt.sameSdkClient === true && receipt.sameAuthClient === true, 'same-clients');
        check(receipt.lifetimeSeconds === 60 && receipt.eagerRefreshThresholdMs === 1000, 'refresh-policy');
        check(receipt.mintOperations === 2 && receipt.authorizationChecks === 4 && receipt.tokensChanged === true, 'operation-counts');
        check(exactKeys(receipt.cleanup, ['sdkClosed']) && receipt.cleanup.sdkClosed === true, 'cleanup');
        const mintSchema = exactArray(receipt.mints, 2) && receipt.mints.every(item => exactKeys(item, MINT_KEYS));
        const stepSchema = exactArray(receipt.steps, 4) && receipt.steps.every(item => exactKeys(item, STEP_KEYS));
        const waitSchema = exactKeys(receipt.wait, WAIT_KEYS);
        check(mintSchema, 'mints-schema'); check(stepSchema, 'steps-schema'); check(waitSchema, 'wait-schema');
        if (!mintSchema || !stepSchema || !waitSchema) return result();
        const numericRows = [
            [receipt, ['startedAtMs', 'completedAtMs', 'elapsedMs'], 'receipt-numbers'],
            ...receipt.mints.map((mint, index) => [mint, MINT_KEYS, `mint-${index + 1}-numbers`]),
            ...receipt.steps.map((step, index) => [step, STEP_KEYS.filter(key => key !== 'id'), `step-${IDS[index]}-numbers`]),
            [receipt.wait, WAIT_KEYS, 'wait-numbers'],
        ];
        let numeric = true;
        for (const [row, keys, code] of numericRows) {
            const valid = keys.every(key => integer(row[key]));
            check(valid, code); numeric &&= valid;
        }
        if (!numeric) return result();
        const { startedAtMs, completedAtMs, mints, steps, wait } = receipt;
        const inside = row => startedAtMs <= row.startedAtMs && row.startedAtMs <= row.completedAtMs &&
            row.completedAtMs <= completedAtMs;
        check(completedAtMs >= startedAtMs && receipt.elapsedMs === completedAtMs - startedAtMs &&
            receipt.elapsedMs <= 120000, 'receipt-window');
        for (const [index, mint] of mints.entries()) {
            check(mint.generation === index + 1 && mint.httpStatus === 200, `mint-${index + 1}-identity`);
            check(inside(mint), `mint-${index + 1}-window`);
            check(mint.remainingLifetimeMs >= 40000 && mint.remainingLifetimeMs <= 70000 &&
                mint.remainingLifetimeMs === mint.expireTimeMs - mint.completedAtMs, `mint-${index + 1}-expiry`);
            const step = steps[index * 2];
            check(step.startedAtMs <= mint.startedAtMs && mint.completedAtMs <= step.completedAtMs,
                `mint-${index + 1}-step`);
        }
        for (const [index, step] of steps.entries()) {
            check(step.id === IDS[index], `step-${IDS[index]}-identity`);
            check(step.grpcCode === 7 && step.authorizationCount === 1 && step.mintCount === GENERATIONS[index] &&
                step.tokenGeneration === GENERATIONS[index], `step-${IDS[index]}-counts`);
            check(inside(step) && step.elapsedMs === step.completedAtMs - step.startedAtMs, `step-${IDS[index]}-window`);
            if (index !== 0) check(steps[index - 1].completedAtMs <= step.startedAtMs, `step-${IDS[index]}-order`);
        }
        check(inside(wait) && wait.elapsedMs > 0 && wait.elapsedMs === wait.completedAtMs - wait.startedAtMs, 'wait-window');
        check(wait.startedAtMs >= steps[1].completedAtMs && wait.completedAtMs <= steps[2].startedAtMs, 'wait-order');
        check(wait.previousExpiryMs === mints[0].expireTimeMs && wait.startedAtMs < wait.previousExpiryMs + 250 &&
            wait.completedAtMs >= wait.previousExpiryMs + 250, 'wait-expiry');
        check(mints[1].startedAtMs >= wait.completedAtMs && mints[1].startedAtMs >= mints[0].expireTimeMs + 250 &&
            mints[1].expireTimeMs > mints[0].expireTimeMs, 'renewal-order');
        return result();
    } catch {
        // Includes objects with throwing accessors/proxies; no original value or
        // exception text is allowed into the public verification report.
        check(false, 'unreadable-receipt');
        return result();
    }
}

module.exports = { parseAuthRenewalArgs, validateCredentialRenewal };
