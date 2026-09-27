import { ChannelCredentials } from './credentials';
import { WorkersCall, CallOptions } from './call';
import { CallLifetime } from './call-lifetime';
import { connectivityState, status, WorkersGrpcConfigurationError as ConfigError } from './status';
import { ChannelOptions, validateOptions } from './options';
import { INSTANCE_CONFIG, GAX_CONFIG_OPTION, configFromGaxToken, WorkersGrpcConfigSnapshot, getWorkersGrpcConfig, lockConfiguration, routeFor, resourcesFor } from './config-internal';
import type { ResourceBudget } from './resources';
const workersChannels = new WeakSet<object>();
export function isWorkersChannel(value: unknown): value is Channel {
    return typeof value === 'object' && value !== null && workersChannels.has(value);
}
export class Channel {
    private closed = false;
    private active = new Set<Pick<WorkersCall, 'cancelWithStatus'>>();
    private readonly config: WorkersGrpcConfigSnapshot;
    private readonly route: ReturnType<typeof routeFor>;
    private readonly limits: ReturnType<typeof validateOptions>;
    private readonly resources: ResourceBudget;
    constructor(private readonly target: string, private readonly creds: ChannelCredentials, options: ChannelOptions = {}) {
        if (!(creds instanceof ChannelCredentials)) {
            throw new TypeError('ChannelCredentials from this package are required');
        }
        const instanceConfig = (options as ChannelOptions & {
            [INSTANCE_CONFIG]?: WorkersGrpcConfigSnapshot;
        })[INSTANCE_CONFIG];
        const usesGlobalConfig = instanceConfig === undefined && !Object.hasOwn(options, GAX_CONFIG_OPTION);
        if (Object.hasOwn(options, GAX_CONFIG_OPTION)) {
            if (instanceConfig !== undefined) {
                throw new ConfigError('WGA_OPTION_CONFLICT', 'Multiple adapter instance options');
            }
            this.config = configFromGaxToken(options[GAX_CONFIG_OPTION]);
            options = { ...options };
            delete options[GAX_CONFIG_OPTION];
        }
        else {
            this.config = instanceConfig ?? getWorkersGrpcConfig();
        }
        this.route = routeFor(target, this.config);
        this.limits = validateOptions(options, this.route.authority, this.config);
        if (this.route.insecure === creds._isSecure()) {
            throw new ConfigError('WGA_UNSUPPORTED_TLS', 'Credential security must match the route; HTTP is test-only');
        }
        this.resources = resourcesFor(this.config);
        // A rejected constructor must not prevent correcting the global config.
        if (usesGlobalConfig) lockConfiguration();
        workersChannels.add(this);
    }
    getTarget(): string {
        return this.target;
    }
    /** Object count, independent of encoded-byte accounting. */
    getReadQueueLimit(): number | undefined {
        return this.resources.limits.readableHighWaterMark;
    }
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const call of [...this.active]) {
            call.cancelWithStatus(status.UNAVAILABLE, 'WGA_CHANNEL_CLOSED');
        }
    }
    getConnectivityState(_tryToConnect = false): connectivityState {
        return this.closed ? connectivityState.SHUTDOWN : connectivityState.IDLE;
    }
    watchConnectivityState(_current: connectivityState, _deadline: Date | number, callback: (error?: Error) => void): void {
        queueMicrotask(() => callback(Object.assign(new Error('WGA_CONNECTIVITY_UNSUPPORTED'), { code: status.UNIMPLEMENTED })));
    }
    getChannelzRef(): {
        kind: string;
        id: number;
        name: string;
    } {
        return { kind: 'channel', id: 0, name: 'unregistered-workers-channel' };
    }
    createCall(): never {
        throw new ConfigError('WGA_METHOD_CONTEXT_REQUIRED', 'A generated client method is required');
    }
    /** Internal bridge: the method kind is passed per call, never cached by method name. */
    createCallForMethod(path: string, requestStream: boolean, responseStream: boolean, options: CallOptions, lifetime?: CallLifetime): WorkersCall {
        const call = new WorkersCall({ path, requestStream, responseStream, options, ...this.route, credentials: this.creds,
            config: this.config, limits: this.limits, resources: this.resources, closed: this.closed, lifetime, onFinish: () => { if (!lifetime) this.active.delete(call); } });
        if (lifetime) lifetime.addTransport(call);
        else this.active.add(call);
        return call;
    }
    /** The logical call stays registered through asynchronous interceptors. */
    createCallLifetime(options: CallOptions): CallLifetime {
        const lifetime = new CallLifetime(options, this.config.defaultTimeoutMs, () => { this.active.delete(lifetime); }, this.resources);
        this.active.add(lifetime);
        if (this.closed) lifetime.cancelWithStatus(status.UNAVAILABLE, 'WGA_CHANNEL_CLOSED');
        return lifetime;
    }
    /** Internal resource assertion used by the local suite. */
    activeCallCount(): number {
        return this.active.size;
    }
}
