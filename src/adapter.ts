import * as grpc from './index';
import { ClientOptions } from './client';
import { WorkersGrpcConfig, validateConfig, INSTANCE_CONFIG, GAX_CONFIG_OPTION, createGaxConfigToken, resourcesFor } from './config-internal';
import { WorkersGrpcConfigurationError } from './status';
export type { ResourceLimits as WorkersGrpcResourceLimits, ResourceDiagnostics as WorkersGrpcResourceUsage } from './resources';
export function createWorkersGrpcTransport(config: WorkersGrpcConfig = {}) {
    const snapshot = validateConfig(config);
    const gaxToken = createGaxConfigToken(snapshot);
    function assertNoInstanceOption(existing: Record<string | symbol, unknown>): void {
        if (Object.hasOwn(existing, INSTANCE_CONFIG) || Object.hasOwn(existing, GAX_CONFIG_OPTION) ||
            Object.hasOwn(existing, `grpc.${GAX_CONFIG_OPTION}`)) {
            throw new WorkersGrpcConfigurationError('WGA_OPTION_CONFLICT', 'An adapter instance option already exists');
        }
    }
    function grpcOptions(existing: ClientOptions = {}): ClientOptions {
        assertNoInstanceOption(existing);
        if (existing.channelFactoryOverride !== undefined || existing.channelOverride !== undefined) {
            throw new WorkersGrpcConfigurationError('WGA_OPTION_CONFLICT', 'A channel override already exists');
        }
        return { ...existing, [INSTANCE_CONFIG]: snapshot };
    }
    return {
        channelCredentials: grpc.credentials.createSsl(), grpcOptions,
        /** Adapter-owned counts only: excludes deserialized objects and platform connection state. */
        resourceUsage() { return resourcesFor(snapshot).diagnostics(); },
        gaxOptions<T extends Record<string, unknown>>(existing: T): T & {
            grpc: typeof grpc;
            fallback: false;
        } {
            assertNoInstanceOption(existing);
            if (existing.grpc !== undefined || existing.sslCreds !== undefined || existing.fallback !== undefined) {
                throw new WorkersGrpcConfigurationError('WGA_OPTION_CONFLICT', 'Existing grpc, sslCreds or fallback option conflicts with this adapter');
            }
            for (const key of ['channelOverride', 'channelFactoryOverride', 'grpc.channelOverride',
                'grpc.channelFactoryOverride', 'grpc.grpc.channelOverride', 'grpc.grpc.channelFactoryOverride']) {
                if (existing[key] !== undefined) {
                    throw new WorkersGrpcConfigurationError('WGA_OPTION_CONFLICT', 'A channel override already exists');
                }
            }
            // GAX caches service constructors across clients. Configuration must
            // travel with each new channel, never with a cached constructor.
            return { ...existing, grpc, fallback: false, [GAX_CONFIG_OPTION]: gaxToken };
        },
    };
}
