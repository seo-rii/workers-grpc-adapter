import { status, WorkersGrpcConfigurationError } from './status';

/** Shared overload control, scoped to one transport and logical endpoint. */
export interface WorkersGrpcRetryThrottling {
    maxTokens: number;
    tokenRatio: number;
}
export interface WorkersGrpcRetryUsage {
    readonly tokens: number;
    readonly maxTokens: number;
    readonly tokenRatio: number;
    readonly retriesAllowed: boolean;
    readonly suppressedRetries: number;
}
export function validateRetryThrottling(input: WorkersGrpcRetryThrottling | undefined): Readonly<WorkersGrpcRetryThrottling> | undefined {
    if (input === undefined) return undefined;
    const fail = (): never => { throw new WorkersGrpcConfigurationError('WGA_INVALID_RETRY_THROTTLING', 'Invalid retry throttling'); };
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['maxTokens', 'tokenRatio'].includes(key))) return fail();
    if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 1000
        || typeof input.tokenRatio !== 'number' || !Number.isFinite(input.tokenRatio)
        || input.tokenRatio < 0.001 || input.tokenRatio > 1000) return fail();
    // This bounded range uses ordinary decimal notation in Number#toString.
    // Floating multiplication can turn 1.001 into 1000.9999999999999 and
    // incorrectly discard a whole milli-token at the recovery threshold.
    const [whole, fraction = ''] = String(input.tokenRatio).split('.');
    const milliTokens = Number(whole) * 1000 + Number((fraction + '000').slice(0, 3));
    return Object.freeze({ maxTokens: input.maxTokens, tokenRatio: milliTokens / 1000 });
}
/** Integer milli-tokens avoid accumulated floating point errors at the threshold. */
export class RetryThrottle {
    private tokens: number;
    private suppressed = 0;
    constructor(private readonly settings: Readonly<WorkersGrpcRetryThrottling>) { this.tokens = settings.maxTokens * 1000; }
    allowed(): boolean { return this.tokens > this.settings.maxTokens * 500; }
    failure(): void { this.tokens = Math.max(0, this.tokens - 1000); }
    success(): void { this.tokens = Math.min(this.settings.maxTokens * 1000, this.tokens + Math.round(this.settings.tokenRatio * 1000)); }
    suppress(): void { this.suppressed++; }
    diagnostics(): WorkersGrpcRetryUsage {
        return Object.freeze({ tokens: this.tokens / 1000, ...this.settings, retriesAllowed: this.allowed(), suppressedRetries: this.suppressed });
    }
}

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
