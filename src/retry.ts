import { status, WorkersGrpcConfigurationError } from './status';

/** Explicit replay policy. List only unary methods whose requests are safe to repeat. */
export interface WorkersGrpcRetryPolicy {
    methods: readonly string[];
    maxAttempts: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
    backoffMultiplier?: number;
    retryableStatusCodes: readonly status[];
    /** Fetch failures can hide a committed write. Disabled unless explicitly enabled. */
    retryOnFetchError?: boolean;
}
export interface RetryPolicySnapshot {
    readonly methods: readonly string[];
    readonly maxAttempts: number;
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
    readonly backoffMultiplier: number;
    readonly retryableStatusCodes: readonly status[];
    readonly retryOnFetchError: boolean;
}

export function validateRetryPolicy(input: WorkersGrpcRetryPolicy | undefined): RetryPolicySnapshot | undefined {
    if (input === undefined) return undefined;
    const fail = (): never => { throw new WorkersGrpcConfigurationError('WGA_INVALID_RETRY_POLICY', 'Invalid explicit retry policy'); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
    for (const key of Object.keys(input)) {
        if (!['methods', 'maxAttempts', 'initialBackoffMs', 'maxBackoffMs', 'backoffMultiplier', 'retryableStatusCodes', 'retryOnFetchError'].includes(key)) return fail();
    }
    if (!Array.isArray(input.methods) || input.methods.length === 0 || input.methods.length > 128 ||
        input.methods.some(method => typeof method !== 'string' || method.length > 1024 || !/^\/[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(method))) return fail();
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 2 || input.maxAttempts > 10) return fail();
    for (const value of [input.initialBackoffMs, input.maxBackoffMs]) {
        if (!Number.isSafeInteger(value) || value < 1 || value > 300000) return fail();
    }
    if (input.initialBackoffMs > input.maxBackoffMs) return fail();
    const multiplier = input.backoffMultiplier ?? 2;
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) return fail();
    if (!Array.isArray(input.retryableStatusCodes) || input.retryableStatusCodes.length === 0 ||
        input.retryableStatusCodes.some(code => !Number.isInteger(code) || code < 1 || code > 16 || code === status.CANCELLED || code === status.DEADLINE_EXCEEDED)) return fail();
    if (input.retryOnFetchError !== undefined && typeof input.retryOnFetchError !== 'boolean') return fail();
    return Object.freeze({ methods: Object.freeze([...new Set(input.methods)].sort()), maxAttempts: input.maxAttempts,
        initialBackoffMs: input.initialBackoffMs, maxBackoffMs: input.maxBackoffMs, backoffMultiplier: multiplier,
        retryableStatusCodes: Object.freeze([...new Set(input.retryableStatusCodes)].sort((a, b) => a - b)),
        retryOnFetchError: input.retryOnFetchError === true });
}

/** Positive pushback is honored exactly; invalid/negative/excessive pushback stops replay. */
export function retryDelay(policy: RetryPolicySnapshot, attempt: number, pushback: readonly unknown[] = []): number | undefined {
    if (attempt >= policy.maxAttempts) return undefined;
    if (pushback.length > 0) {
        if (pushback.length !== 1 || typeof pushback[0] !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(pushback[0])) return undefined;
        const delay = Number(pushback[0]);
        return Number.isSafeInteger(delay) && delay <= policy.maxBackoffMs ? delay : undefined;
    }
    const base = Math.min(policy.maxBackoffMs, policy.initialBackoffMs * Math.pow(policy.backoffMultiplier, attempt - 1));
    // Jitter is scheduling randomness, not a token or security boundary.
    return Math.min(policy.maxBackoffMs, Math.max(1, Math.round(base * (0.8 + Math.random() * 0.4))));
}
