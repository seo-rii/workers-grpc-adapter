import { WorkersGrpcConfigurationError as ConfigError } from './status';
export { WorkersGrpcConfigurationError } from './status';
export type WorkersGrpcConfig = {
    defaultTimeoutMs?: number;
    transportMaxSendBytes?: number;
    transportMaxReceiveBytes?: number;
} & ({
    mode?: 'cloudflare';
    endpoints?: never;
    allowInsecureLocalhost?: never;
} | {
    mode: 'grpc-web';
    endpoints: Readonly<Record<string, string>>;
    allowInsecureLocalhost?: boolean;
});
export interface WorkersGrpcConfigSnapshot {
    readonly mode: 'cloudflare' | 'grpc-web';
    readonly endpoints: Readonly<Record<string, string>>;
    readonly defaultTimeoutMs?: number;
    readonly transportMaxSendBytes: number;
    readonly transportMaxReceiveBytes: number;
    readonly allowInsecureLocalhost: boolean;
}
function fail(code: string, message: string): never {
    throw new ConfigError(code, message);
}
export function normalizeAuthority(target: string): string {
    if (typeof target !== 'string' || !target || /[/@?#\s%\\]/.test(target)) {
        return fail('WGA_INVALID_TARGET', 'Use a hostname[:port], not a URL or resolver scheme');
    }
    if (!/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]+)?$/.test(target)) {
        return fail('WGA_INVALID_TARGET', 'Invalid authority');
    }
    let url: URL;
    try {
        url = new URL('https://' + target);
    }
    catch {
        return fail('WGA_INVALID_TARGET', 'Invalid authority');
    }
    if (url.port === '0') {
        return fail('WGA_INVALID_TARGET', 'Port zero is not an endpoint');
    }
    return `${url.hostname.toLowerCase()}:${url.port || 443}`;
}
export function isLiteralLoopback(hostname: string): boolean {
    return hostname === '127.0.0.1' || hostname === '[::1]';
}
function budget(value: unknown, name: string, fallback?: number): number | undefined {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || (name !== 'defaultTimeoutMs' && value > 2147483647)) {
        return fail('WGA_INVALID_CONFIG', `Invalid ${name}`);
    }
    return value;
}
/** Internal pure validator. The documented public API is configure/get below. */
export function validateConfig(input: WorkersGrpcConfig = {}): WorkersGrpcConfigSnapshot {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return fail('WGA_INVALID_CONFIG', 'Configuration must be an object');
    }
    for (const key of Object.keys(input)) {
        if (!['mode', 'endpoints', 'allowInsecureLocalhost', 'defaultTimeoutMs', 'transportMaxSendBytes', 'transportMaxReceiveBytes'].includes(key)) {
            return fail('WGA_INVALID_CONFIG', 'Unknown configuration key');
        }
    }
    const mode = input.mode ?? 'cloudflare';
    if (mode !== 'cloudflare' && mode !== 'grpc-web') {
        return fail('WGA_INVALID_CONFIG', 'Invalid transport mode');
    }
    if (input.allowInsecureLocalhost !== undefined && typeof input.allowInsecureLocalhost !== 'boolean') {
        return fail('WGA_INVALID_CONFIG', 'Invalid loopback setting');
    }
    if (mode === 'cloudflare' && (input.endpoints !== undefined || input.allowInsecureLocalhost !== undefined)) {
        return fail('WGA_INVALID_CONFIG', 'Gateway options require grpc-web mode');
    }
    const entries: Record<string, string> = Object.create(null);
    if (mode === 'grpc-web') {
        if (!input.endpoints || typeof input.endpoints !== 'object' || Array.isArray(input.endpoints) || Object.keys(input.endpoints).length === 0) {
            return fail('WGA_INVALID_CONFIG', 'grpc-web requires endpoint mappings');
        }
        for (const key of Object.keys(input.endpoints).sort()) {
            const authority = normalizeAuthority(key);
            if (entries[authority]) {
                return fail('WGA_INVALID_CONFIG', 'Duplicate canonical endpoint');
            }
            const origin = input.endpoints[key];
            let url: URL;
            try {
                url = new URL(origin);
            }
            catch {
                return fail('WGA_INVALID_CONFIG', 'Invalid gateway origin');
            }
            if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || typeof origin !== 'string' || /\\/.test(origin)) {
                return fail('WGA_INVALID_CONFIG', 'Endpoint must be an origin without credentials, path, query or fragment');
            }
            if (url.protocol !== 'https:' && !(url.protocol === 'http:' && input.allowInsecureLocalhost === true && isLiteralLoopback(url.hostname))) {
                return fail('WGA_INVALID_CONFIG', 'HTTPS required except explicit literal-loopback tests');
            }
            entries[authority] = url.origin;
        }
    }
    return Object.freeze({ mode, endpoints: Object.freeze(Object.assign(Object.create(null), Object.fromEntries(Object.keys(entries).sort().map(k => [k, entries[k]])))),
        defaultTimeoutMs: budget(input.defaultTimeoutMs, 'defaultTimeoutMs'),
        transportMaxSendBytes: budget(input.transportMaxSendBytes, 'transportMaxSendBytes', 32 * 1024 * 1024)!,
        transportMaxReceiveBytes: budget(input.transportMaxReceiveBytes, 'transportMaxReceiveBytes', 32 * 1024 * 1024)!,
        allowInsecureLocalhost: input.allowInsecureLocalhost === true });
}
let configured = false, locked = false, snapshot = validateConfig();
export function configureWorkersGrpc(config: WorkersGrpcConfig): WorkersGrpcConfigSnapshot {
    const next = validateConfig(config);
    if (JSON.stringify(next) === JSON.stringify(snapshot)) {
        configured = true;
        return snapshot;
    }
    if (locked) {
        return fail('WGA_CONFIG_LOCKED', 'Configuration is locked by an existing channel');
    }
    if (configured) {
        return fail('WGA_CONFIG_ALREADY_SET', 'Configuration has already been set');
    }
    configured = true;
    return snapshot = next;
}
export function getWorkersGrpcConfig(): WorkersGrpcConfigSnapshot {
    return snapshot;
}
export function lockConfiguration(): WorkersGrpcConfigSnapshot {
    locked = true;
    return snapshot;
}
export function routeFor(target: string, config: WorkersGrpcConfigSnapshot): {
    authority: string;
    origin: string;
    insecure: boolean;
} {
    const authority = normalizeAuthority(target);
    const origin = config.mode === 'cloudflare' ? new URL('https://' + authority).origin : config.endpoints[authority];
    if (!origin) {
        return fail('WGA_UNMAPPED_TARGET', 'No explicitly trusted gateway for this target');
    }
    return { authority, origin, insecure: origin.startsWith('http:') };
}
/** Private brand shared by the per-client adapter and Channel; not a public config field. */
export const INSTANCE_CONFIG = Symbol('workers-grpc-adapter.instance-config');
