import { WorkersGrpcConfigurationError as ConfigError } from './status';
import { normalizeAuthority, WorkersGrpcConfigSnapshot } from './config-internal';
import type { CompressionEncoding } from './compression';
export interface ChannelOptions {
    'grpc.max_send_message_length'?: number;
    'grpc.max_receive_message_length'?: number;
    'grpc.initial_reconnect_backoff_ms'?: number;
    'grpc.default_compression_algorithm'?: number;
    'grpc.enable_retries'?: number;
    'grpc.enable_channelz'?: number;
    'grpc.primary_user_agent'?: string;
    'grpc.secondary_user_agent'?: string;
    'grpc.default_authority'?: string;
    'grpc.ssl_target_name_override'?: string;
    [key: string]: unknown;
}
export interface ValidatedOptions {
    maxSend: number;
    maxReceive: number;
    userAgent: string;
    compression: CompressionEncoding;
}
export function validateOptions(options: ChannelOptions, authority: string, config: WorkersGrpcConfigSnapshot): ValidatedOptions {
    const allowed = ['grpc.max_send_message_length', 'grpc.max_receive_message_length', 'grpc.initial_reconnect_backoff_ms',
        'grpc.default_compression_algorithm', 'grpc.enable_retries', 'grpc.enable_channelz', 'grpc.primary_user_agent', 'grpc.secondary_user_agent',
        'grpc.default_authority', 'grpc.ssl_target_name_override'];
    const fail = (key: string): never => {
        throw new ConfigError('WGA_UNSUPPORTED_OPTION', `Unsupported channel option: ${key}`);
    };
    for (const key of Object.keys(options)) {
        if (!allowed.includes(key)) {
            fail(key);
        }
    }
    for (const key of ['grpc.enable_retries', 'grpc.enable_channelz']) {
        if (options[key] !== undefined && options[key] !== 0) {
            fail(key);
        }
    }
    const compression = options['grpc.default_compression_algorithm'] === undefined ? 0 : options['grpc.default_compression_algorithm'];
    if (typeof compression !== 'number' || ![0, 1, 2].includes(compression)) {
        fail('grpc.default_compression_algorithm');
    }
    if (options['grpc.initial_reconnect_backoff_ms'] !== undefined && options['grpc.initial_reconnect_backoff_ms'] !== 1000) {
        fail('grpc.initial_reconnect_backoff_ms');
    }
    for (const key of ['grpc.default_authority', 'grpc.ssl_target_name_override']) {
        if (options[key] !== undefined && normalizeAuthority(options[key] as string) !== authority) {
            fail(key);
        }
    }
    function limit(key: string, fallback: number, ceiling: number): number {
        const value = options[key] ?? fallback;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1) {
            fail(key);
        }
        return value === -1 ? ceiling : Math.min(value as number, ceiling);
    }
    const agents = ['workers-grpc-adapter/0.0.0-prototype.1'];
    for (const key of ['grpc.primary_user_agent', 'grpc.secondary_user_agent']) {
        const value = options[key];
        if (value !== undefined) {
            if (typeof value !== 'string' || /[^\x20-\x7e]/.test(value) || value.length > 4096) {
                fail(key);
            }
            agents.push(value as string);
        }
    }
    return { maxSend: limit('grpc.max_send_message_length', -1, config.transportMaxSendBytes),
        maxReceive: limit('grpc.max_receive_message_length', 4 * 1024 * 1024, config.transportMaxReceiveBytes), userAgent: agents.join(' '),
        compression: (['identity', 'deflate', 'gzip'] as const)[compression] };
}
