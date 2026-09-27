import { Buffer } from 'node:buffer';
import { Metadata } from './metadata';
import { WorkersGrpcConfigurationError as ConfigError } from './status';
export interface CallMetadataOptions {
    service_url: string;
    method_name: string;
}
export type MetadataGenerator = (options: CallMetadataOptions, callback: (error: Error | null, metadata?: Metadata) => void) => void;
export class CallCredentials {
    private constructor(private readonly generators: readonly MetadataGenerator[]) {
    }
    static createEmpty(): CallCredentials {
        return new CallCredentials([]);
    }
    static createFromMetadataGenerator(generator: MetadataGenerator): CallCredentials {
        if (typeof generator !== 'function') {
            throw new TypeError('Expected metadata generator');
        }
        return new CallCredentials([generator]);
    }
    compose(other: CallCredentials): CallCredentials {
        if (!(other instanceof CallCredentials)) {
            throw new TypeError('Foreign CallCredentials');
        }
        return new CallCredentials([...this.generators, ...other.generators]);
    }
    async generateMetadata(options: CallMetadataOptions): Promise<Metadata> {
        const results = await Promise.all(this.generators.map(generator => new Promise<Metadata>((resolve, reject) => {
            let completed = false;
            const done = (err: Error | null, metadata?: Metadata) => {
                if (completed) {
                    return;
                }
                completed = true;
                if (err) {
                    reject(err);
                }
                else {
                    if (!(metadata instanceof Metadata)) {
                        reject(new Error('Invalid authentication metadata'));
                    }
                    else {
                        resolve(metadata.clone());
                    }
                }
            };
            try {
                const returned: unknown = generator(options, done);
                if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
                    Promise.resolve(returned).catch(error => done(error instanceof Error ? error : new Error('Authentication generator failed')));
                }
            }
            catch (e) {
                done(e instanceof Error ? e : new Error('Authentication generator failed'));
            }
        })));
        const out = new Metadata();
        for (const m of results) {
            out.merge(m);
        }
        return out;
    }
    /** Internal security check for unencrypted test routes. */
    isEmpty(): boolean {
        return this.generators.length === 0;
    }
}
export class ChannelCredentials {
    private constructor(private readonly secure: boolean, private readonly calls: CallCredentials) {
    }
    static createSsl(rootCerts?: Buffer | null, privateKey?: Buffer | null, certChain?: Buffer | null, verifyOptions?: unknown): ChannelCredentials {
        if (rootCerts != null || privateKey != null || certChain != null || verifyOptions != null) {
            throw new ConfigError('WGA_UNSUPPORTED_TLS', 'Custom CA, mTLS and TLS verification options are not supported');
        }
        return new ChannelCredentials(true, CallCredentials.createEmpty());
    }
    static createInsecure(): ChannelCredentials {
        return new ChannelCredentials(false, CallCredentials.createEmpty());
    }
    compose(calls: CallCredentials): ChannelCredentials {
        if (!(calls instanceof CallCredentials)) {
            throw new TypeError('Foreign CallCredentials');
        }
        if (!this.secure && !calls.isEmpty()) {
            throw new ConfigError('WGA_UNSUPPORTED_TLS', 'Credentials cannot be sent over an insecure channel');
        }
        return new ChannelCredentials(this.secure, this.calls.compose(calls));
    }
    _isSecure(): boolean {
        return this.secure;
    }
    _getCallCredentials(): CallCredentials {
        return this.calls;
    }
}
type HeaderRecord = Record<string, string | string[] | undefined>;
export interface GoogleCredential {
    getRequestHeaders(url?: string): Promise<Headers | HeaderRecord> | Headers | HeaderRecord;
}
export interface LegacyGoogleCredential {
    getRequestMetadata(url: string, callback: (error: Error | null, headers?: Record<string, string>) => void): void;
}
function createFromGoogleCredential(auth: GoogleCredential | LegacyGoogleCredential): CallCredentials {
    if (!auth || (typeof (auth as GoogleCredential).getRequestHeaders !== 'function' && typeof (auth as LegacyGoogleCredential).getRequestMetadata !== 'function')) {
        throw new TypeError('getRequestHeaders or getRequestMetadata is required');
    }
    return CallCredentials.createFromMetadataGenerator((options, callback) => {
        return Promise.resolve().then(() => {
            // Keep modern credentials first, including clients exposing both APIs.
            if (typeof (auth as GoogleCredential).getRequestHeaders === 'function') {
                return (auth as GoogleCredential).getRequestHeaders(options.service_url);
            }
            return new Promise<HeaderRecord>((resolve, reject) => {
                const returned: unknown = (auth as LegacyGoogleCredential).getRequestMetadata(options.service_url, (error, headers) => {
                    if (error) {
                        reject(error);
                    }
                    else if (!headers) {
                        reject(new Error('Headers not set by metadata plugin'));
                    }
                    else {
                        resolve(headers);
                    }
                });
                // The legacy contract requires the callback. Ignore returned values,
                // but contain a rejected promise from an accidentally async provider.
                if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
                    Promise.resolve(returned).catch(reject);
                }
            }).then(headers => {
                if (typeof headers !== 'object' || Array.isArray(headers) || headers instanceof Headers) {
                    throw new Error('Invalid authentication metadata');
                }
                // Native legacy clients enumerate own record properties. Snapshot
                // those values once; inherited helpers must not act like Headers.
                const normalized: HeaderRecord = Object.create(null);
                for (const [key, value] of Object.entries(headers)) {
                    if (typeof value !== 'string') {
                        throw new Error('Invalid authentication metadata');
                    }
                    normalized[key] = value;
                }
                return normalized;
            });
        }).then(headers => {
            const metadata = new Metadata();
            if (headers && typeof (headers as Headers).forEach === 'function') {
                (headers as Headers).forEach((value, key) => metadata.add(key, value));
            }
            else {
                for (const [key, value] of Object.entries(headers)) {
                    if (value !== undefined) {
                        for (const item of Array.isArray(value) ? value : [value]) {
                            metadata.add(key, item);
                        }
                    }
                }
            }
            callback(null, metadata);
        }).catch(error => callback(error));
    });
}
export const credentials = {
    createSsl: ChannelCredentials.createSsl, createInsecure: ChannelCredentials.createInsecure,
    createEmpty: CallCredentials.createEmpty,
    createFromMetadataGenerator: CallCredentials.createFromMetadataGenerator, createFromGoogleCredential,
    combineChannelCredentials(channel: ChannelCredentials, ...calls: CallCredentials[]): ChannelCredentials {
        if (!(channel instanceof ChannelCredentials)) {
            throw new TypeError('Foreign ChannelCredentials');
        }
        return calls.reduce((c, x) => c.compose(x), channel);
    },
    combineCallCredentials(...calls: CallCredentials[]): CallCredentials {
        return calls.reduce((c, x) => c.compose(x), CallCredentials.createEmpty());
    },
};
