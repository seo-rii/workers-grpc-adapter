/** Stable numeric gRPC status values. No HTTP/2 implementation is used. */
export enum status {
    OK = 0,
    CANCELLED = 1,
    UNKNOWN = 2,
    INVALID_ARGUMENT = 3,
    DEADLINE_EXCEEDED = 4,
    NOT_FOUND = 5,
    ALREADY_EXISTS = 6,
    PERMISSION_DENIED = 7,
    RESOURCE_EXHAUSTED = 8,
    FAILED_PRECONDITION = 9,
    ABORTED = 10,
    OUT_OF_RANGE = 11,
    UNIMPLEMENTED = 12,
    INTERNAL = 13,
    UNAVAILABLE = 14,
    DATA_LOSS = 15,
    UNAUTHENTICATED = 16
}
export enum connectivityState {
    IDLE = 0,
    CONNECTING = 1,
    READY = 2,
    TRANSIENT_FAILURE = 3,
    SHUTDOWN = 4
}
export enum compressionAlgorithms {
    identity = 0,
    deflate = 1,
    gzip = 2
}
export enum propagate {
    DEADLINE = 1,
    CENSUS_STATS_CONTEXT = 2,
    CENSUS_TRACING_CONTEXT = 4,
    CANCELLATION = 8,
    DEFAULTS = 65535
}
export class WorkersGrpcConfigurationError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'WorkersGrpcConfigurationError';
    }
}
/** Internal errors never interpolate response bodies or credential generator messages. */
export class TransportError extends Error {
    constructor(public readonly code: status, public readonly diagnostic: string) {
        super(diagnostic);
        this.name = 'TransportError';
    }
}
export function httpStatusToGrpc(code: number): status {
    return ({ 400: status.INTERNAL, 401: status.UNAUTHENTICATED, 403: status.PERMISSION_DENIED,
        404: status.UNIMPLEMENTED, 429: status.UNAVAILABLE, 502: status.UNAVAILABLE,
        503: status.UNAVAILABLE, 504: status.UNAVAILABLE } as Record<number, status>)[code] ?? status.UNKNOWN;
}
export function authErrorCode(error: unknown): status {
    const code = (error as {
        code?: unknown;
    } | null)?.code;
    if (typeof code !== 'number') {
        return status.UNKNOWN;
    }
    if (!Number.isInteger(code) || code < 0 || code > 16 || [0, 3, 5, 6, 9, 10, 11, 15].includes(code)) {
        return status.INTERNAL;
    }
    return code;
}
