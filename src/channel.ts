import { ChannelCredentials } from './credentials';
import { WorkersCall, CallOptions } from './call';
import { connectivityState, status, WorkersGrpcConfigurationError as ConfigError } from './status';
import { ChannelOptions, validateOptions } from './options';
import { INSTANCE_CONFIG, GAX_CONFIG_OPTION, configFromGaxToken, WorkersGrpcConfigSnapshot, lockConfiguration, routeFor } from './config-internal';
const workersChannels = new WeakSet<object>();
export function isWorkersChannel(value: unknown): value is Channel {
    return typeof value === 'object' && value !== null && workersChannels.has(value);
}
export class Channel {
    private closed = false;
    private active = new Set<WorkersCall>();
    private readonly config: WorkersGrpcConfigSnapshot;
    private readonly route: ReturnType<typeof routeFor>;
    private readonly limits: ReturnType<typeof validateOptions>;
    constructor(private readonly target: string, private readonly creds: ChannelCredentials, options: ChannelOptions = {}) {
        if (!(creds instanceof ChannelCredentials)) {
            throw new TypeError('ChannelCredentials from this package are required');
        }
        const instanceConfig = (options as ChannelOptions & {
            [INSTANCE_CONFIG]?: WorkersGrpcConfigSnapshot;
        })[INSTANCE_CONFIG];
        if (Object.hasOwn(options, GAX_CONFIG_OPTION)) {
            if (instanceConfig !== undefined) {
                throw new ConfigError('WGA_OPTION_CONFLICT', 'Multiple adapter instance options');
            }
            this.config = configFromGaxToken(options[GAX_CONFIG_OPTION]);
            options = { ...options };
            delete options[GAX_CONFIG_OPTION];
        }
        else {
            this.config = instanceConfig ?? lockConfiguration();
        }
        this.route = routeFor(target, this.config);
        this.limits = validateOptions(options, this.route.authority, this.config);
        if (this.route.insecure === creds._isSecure()) {
            throw new ConfigError('WGA_UNSUPPORTED_TLS', 'Credential security must match the route; HTTP is test-only');
        }
        workersChannels.add(this);
    }
    getTarget(): string {
        return this.target;
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
    createCallForMethod(path: string, requestStream: boolean, responseStream: boolean, options: CallOptions): WorkersCall {
        const call = new WorkersCall({ path, requestStream, responseStream, options, ...this.route, credentials: this.creds,
            config: this.config, limits: this.limits, closed: this.closed, onFinish: () => this.active.delete(call) });
        this.active.add(call);
        return call;
    }
    /** Internal resource assertion used by the local suite. */
    activeCallCount(): number {
        return this.active.size;
    }
}
