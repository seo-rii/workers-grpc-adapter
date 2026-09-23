import * as grpc from './index';
import { ClientOptions } from './client';
import { WorkersGrpcConfig, validateConfig, INSTANCE_CONFIG } from './config-internal';
import { WorkersGrpcConfigurationError } from './status';
export function createWorkersGrpcTransport(config: WorkersGrpcConfig = {}) {
    const snapshot = validateConfig(config);
    function grpcOptions(existing: ClientOptions = {}): ClientOptions {
        if (existing.channelFactoryOverride !== undefined || existing.channelOverride !== undefined) {
            throw new WorkersGrpcConfigurationError('WGA_OPTION_CONFLICT', 'A channel override already exists');
        }
        return { ...existing, [INSTANCE_CONFIG]: snapshot };
    }
    return {
        channelCredentials: grpc.credentials.createSsl(), grpcOptions,
        gaxOptions<T extends Record<string, unknown>>(existing: T): T & {
            grpc: typeof grpc;
            fallback: false;
        } {
            if (existing.grpc !== undefined || existing.sslCreds !== undefined || existing.fallback !== undefined) {
                throw new WorkersGrpcConfigurationError('WGA_OPTION_CONFLICT', 'Existing grpc, sslCreds or fallback option conflicts with this adapter');
            }
            // GAX prepends `grpc.` keys to grpc-js channel options, but symbols are not forwarded.
            // A per-instance facade closes over this snapshot instead of mutating global configuration.
            class BoundClient extends grpc.Client {
                constructor(address: string, creds: grpc.ChannelCredentials, options: ClientOptions = {}) {
                    super(address, creds, grpcOptions(options));
                }
            }
            const make = (methods: grpc.ServiceDefinition, name: string): grpc.ServiceClientConstructor => {
                const Base = grpc.makeGenericClientConstructor(methods, name);
                class Bound extends Base {
                    constructor(address: string, creds: grpc.ChannelCredentials, options: ClientOptions = {}) {
                        super(address, creds, grpcOptions(options));
                    }
                }
                return Bound;
            };
            const facade = { ...grpc, Client: BoundClient, makeGenericClientConstructor: make, makeClientConstructor: make,
                loadPackageDefinition: (defs: Record<string, any>) => {
                    const loaded = grpc.loadPackageDefinition(defs);
                    function visit(node: Record<string, any>): void {
                        for (const [key, value] of Object.entries(node)) {
                            if (typeof value === 'function' && value.service) {
                                node[key] = make(value.service, value.serviceName);
                            }
                            else {
                                if (value && typeof value === 'object' && !value.format) {
                                    visit(value);
                                }
                            }
                        }
                    }
                    visit(loaded);
                    return loaded;
                } };
            return { ...existing, grpc: facade as typeof grpc, fallback: false };
        },
    };
}
