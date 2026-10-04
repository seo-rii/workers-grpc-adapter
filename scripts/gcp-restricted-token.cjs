'use strict';
const { setTimeout: sleep } = require('node:timers/promises');

const MAX_MS = 300000;
const RETRY_MS = 10000;
const MAX_ATTEMPTS = 31;
const INTERRUPTED = Symbol('interrupted');
const EXPIRED = Symbol('expired');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function tokenExpiration(value) {
    if (typeof value !== 'string') return NaN;
    const fields = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if (!fields) return NaN;
    const year = Number(fields[1]), month = Number(fields[2]), day = Number(fields[3]);
    const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return NaN;
    return Date.parse(value);
}

function awaitWithSignal(operation, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => signal.aborted ? Promise.reject(signal.reason) : operation()).then(
            value => { signal.removeEventListener('abort', abort); resolve(value); },
            error => { signal.removeEventListener('abort', abort); reject(error); },
        );
    });
}

/**
 * The caller must establish that url belongs to its newly created account.
 * api(url, method, body) is the existing probe API contract. It must independently
 * bound/abort its Fetch with the caller's signal: racing that callback here ends
 * local waiting but cannot abort an API implementation that ignores cancellation.
 * Only an explicitly approved owned-SA IAM grant enables propagation retries.
 * No policy writes, fallback principals, keys or credential discovery occur here.
 * Keep credentials private; only receipt is suitable for a verification report.
 */
async function awaitOwnedRestrictedToken({ api, url, wait = (ms, signal) => sleep(ms, undefined, { signal }),
    now = Date.now, signal, allowPropagationWait = false } = {}) {
    if (typeof api !== 'function' || typeof now !== 'function' || typeof wait !== 'function' ||
        typeof allowPropagationWait !== 'boolean' || (signal !== undefined && !(signal instanceof AbortSignal))) {
        throw Object.assign(new TypeError('INVALID_RESTRICTED_TOKEN_OPTIONS'), { code: 'INVALID_RESTRICTED_TOKEN_OPTIONS' });
    }
    // IAM Credentials requires the '-' project segment. The UID alternative
    // prevents a deleted/recreated account from reusing the target's identity.
    if (typeof url !== 'string' || /\s/.test(url) ||
        !/^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/(?:[1-9]\d{9,29}|wga-probe-[a-f0-9]{12}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com):generateAccessToken$/.test(url)) {
        throw Object.assign(new TypeError('INVALID_RESTRICTED_TOKEN_URL'), { code: 'INVALID_RESTRICTED_TOKEN_URL' });
    }
    const startedAt = now();
    if (!Number.isFinite(startedAt) || startedAt < 0) {
        throw Object.assign(new TypeError('INVALID_RESTRICTED_TOKEN_CLOCK'), { code: 'INVALID_RESTRICTED_TOKEN_CLOCK' });
    }
    let previous = startedAt, attempts = 0, httpStatus = null, propagationWaitMs = 0;
    const controller = new AbortController();
    const onAbort = () => controller.abort(INTERRUPTED);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(EXPIRED), MAX_MS);
    const result = (status, reason, credentials = null) => ({ credentials, receipt: {
        status, httpStatus, attempts, elapsedMs: previous - startedAt, propagationWaitMs, reason,
    } });
    const readClock = () => {
        const value = now();
        if (!Number.isFinite(value) || value < previous) return false;
        previous = value;
        return true;
    };
    try {
        for (;;) {
            if (!readClock()) return result('failed', 'invalid-clock');
            if (controller.signal.aborted) return result(signal?.aborted ? 'interrupted' : 'failed',
                signal?.aborted ? 'interrupted' : 'mint-timeout');
            if (previous - startedAt >= MAX_MS) return result(httpStatus === 403 ? 'blocked' : 'failed',
                httpStatus === 403 ? 'permission-propagation-timeout' : 'mint-timeout');
            attempts++;
            let response;
            try {
                response = await awaitWithSignal(() => api(url, 'POST', {
                    scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '1800s',
                }), controller.signal);
            } catch {
                readClock();
                return result(signal?.aborted ? 'interrupted' : 'failed',
                    signal?.aborted ? 'interrupted' : controller.signal.aborted ? 'mint-timeout' : 'mint-request-failed');
            }
            if (!readClock()) return result('failed', 'invalid-clock');
            if (signal?.aborted) return result('interrupted', 'interrupted');
            if (controller.signal.aborted || previous - startedAt > MAX_MS) return result('failed', 'mint-timeout');
            if (!isObject(response) || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
                return result('failed', 'invalid-response');
            }
            httpStatus = response.status;
            if (httpStatus === 200) {
                const data = response.data;
                // Date.parse alone accepts non-timestamp input such as '2026'.
                const expiresAt = tokenExpiration(data?.expireTime);
                if (!isObject(data) || data.error || typeof data.accessToken !== 'string' ||
                    data.accessToken.length <= 20 || data.accessToken.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(data.accessToken) ||
                    !Number.isFinite(expiresAt) || expiresAt <= previous || expiresAt > previous + 1810000) {
                    return result('failed', 'invalid-token-response');
                }
                return result('ready', null, { accessToken: data.accessToken, expireTime: data.expireTime });
            }
            // API error bodies can contain arbitrary text. Status alone controls
            // this deliberately narrow policy; malformed 403 bodies stay denied.
            if (httpStatus !== 403) return result('failed', 'mint-http-status');
            if (!allowPropagationWait) return result('blocked', 'permission-denied');
            if (attempts >= MAX_ATTEMPTS || previous - startedAt >= MAX_MS) {
                return result('blocked', 'permission-propagation-timeout');
            }
            const pauseMs = Math.min(RETRY_MS, MAX_MS - (previous - startedAt));
            const beforePause = previous;
            try { await awaitWithSignal(() => wait(pauseMs, controller.signal), controller.signal); }
            catch {
                readClock();
                return result(signal?.aborted ? 'interrupted' : controller.signal.aborted ? 'blocked' : 'failed',
                    signal?.aborted ? 'interrupted' : controller.signal.aborted ? 'permission-propagation-timeout' : 'propagation-wait-failed');
            }
            if (!readClock()) return result('failed', 'invalid-clock');
            if (previous - beforePause < pauseMs) return result('failed', 'propagation-wait-incomplete');
            propagationWaitMs += previous - beforePause;
        }
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        controller.abort(INTERRUPTED);
    }
}

module.exports = { awaitOwnedRestrictedToken };
