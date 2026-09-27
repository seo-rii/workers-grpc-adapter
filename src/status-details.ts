import { Buffer } from 'node:buffer';

/** Structural surface accepts both grpc-js StatusObject and ServiceError. */
export interface GrpcStatusDetailsSource {
    readonly code: number;
    readonly details: string;
    readonly metadata: { get(key: string): readonly unknown[] };
}
export interface GrpcStatusDetail {
    readonly typeUrl: string;
    /** An owned copy, independent of the source Metadata. */
    readonly value: Buffer;
    readonly decoded?: unknown;
    readonly diagnostic?: 'decoder-failed';
}
export interface DecodedGrpcStatusDetails {
    readonly code: number;
    readonly message: string;
    readonly details: readonly GrpcStatusDetail[];
}
export interface GrpcStatusDetailsOptions {
    /** Encoded google.rpc.Status ceiling; default 64 KiB, maximum 4 MiB. */
    maxBytes?: number;
    /** Maximum Any entries; default 64, maximum 1024. */
    maxDetails?: number;
    /** Exact type URL keys. Decoders are synchronous and isolated on failure. */
    decoders?: Readonly<Record<string, (value: Buffer) => unknown>>;
}
export interface GrpcStatusDetailsResult<T> {
    /** Always the identical original object; its code/details are never replaced. */
    readonly status: T;
    readonly details?: DecodedGrpcStatusDetails;
    readonly diagnostic?: 'absent' | 'multiple-values' | 'invalid-protobuf' | 'limit-exceeded' | 'code-mismatch';
}
class DecodeFailure extends Error {
    constructor(readonly diagnostic: 'invalid-protobuf' | 'limit-exceeded') { super(diagnostic); }
}
const malformed = (): never => { throw new DecodeFailure('invalid-protobuf'); };
const exceeded = (): never => { throw new DecodeFailure('limit-exceeded'); };
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Bounded protobuf reader. Unknown fields, including matched groups, are skipped. */
class Reader {
    private offset = 0;
    constructor(private readonly bytes: Uint8Array) {}
    get ended(): boolean { return this.offset === this.bytes.length; }
    varint(): bigint {
        let value = 0n;
        for (let i = 0; i < 10; i++) {
            if (this.offset >= this.bytes.length) return malformed();
            const byte = this.bytes[this.offset++];
            if (i === 9 && byte > 1) return malformed();
            value |= BigInt(byte & 127) << BigInt(7 * i);
            if (!(byte & 128)) return value;
        }
        return malformed();
    }
    tag(): { field: number; wire: number } {
        const tag = this.varint();
        if (tag < 8n || tag > 0xffffffffn) return malformed();
        return { field: Number(tag >> 3n), wire: Number(tag & 7n) };
    }
    block(): Uint8Array {
        const length = this.varint();
        if (length > BigInt(this.bytes.length - this.offset)) return malformed();
        const start = this.offset; this.offset += Number(length);
        return this.bytes.subarray(start, this.offset);
    }
    skip(field: number, wire: number, depth = 0): void {
        let count = 0;
        switch (wire) {
            case 0: this.varint(); return;
            case 1: count = 8; break;
            case 2: this.block(); return;
            case 3:
                if (depth >= 32) return exceeded();
                while (!this.ended) {
                    const next = this.tag();
                    if (next.wire === 4) { if (next.field !== field) return malformed(); return; }
                    this.skip(next.field, next.wire, depth + 1);
                }
                return malformed();
            case 5: count = 4; break;
            default: return malformed();
        }
        if (count > this.bytes.length - this.offset) return malformed();
        this.offset += count;
    }
}
function decodeAny(bytes: Uint8Array): { typeUrl: string; value: Buffer } {
    const reader = new Reader(bytes);
    let typeUrl = '', value: Uint8Array = new Uint8Array(0);
    while (!reader.ended) {
        const { field, wire } = reader.tag();
        if (field === 1 || field === 2) {
            if (wire !== 2) return malformed();
            const block = reader.block();
            if (field === 1) typeUrl = utf8.decode(block); else value = block;
        } else reader.skip(field, wire);
    }
    return { typeUrl, value: Buffer.from(value) };
}
/** Decode the optional rich status without mutating or overriding the RPC status. */
export function decodeGrpcStatusDetails<T extends GrpcStatusDetailsSource>(original: T,
    options: GrpcStatusDetailsOptions = {}): GrpcStatusDetailsResult<T> {
    const maxBytes = options.maxBytes ?? 65536, maxDetails = options.maxDetails ?? 64;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4194304
        || !Number.isSafeInteger(maxDetails) || maxDetails < 1 || maxDetails > 1024) {
        throw new TypeError('WGA_INVALID_STATUS_DETAILS_LIMIT');
    }
    const result = (diagnostic: GrpcStatusDetailsResult<T>['diagnostic']): GrpcStatusDetailsResult<T> => Object.freeze({ status: original, diagnostic });
    try {
        const values = original.metadata.get('grpc-status-details-bin');
        if (values.length === 0) return result('absent');
        if (values.length !== 1) return result('multiple-values');
        const bytes = values[0];
        if (!(bytes instanceof Uint8Array)) return result('invalid-protobuf');
        if (bytes.length > maxBytes) return result('limit-exceeded');
        const reader = new Reader(bytes);
        let code = 0, message = '';
        const details: GrpcStatusDetail[] = [];
        while (!reader.ended) {
            const { field, wire } = reader.tag();
            if (field === 1) {
                if (wire !== 0) return malformed();
                code = Number(BigInt.asIntN(32, reader.varint()));
            } else if (field === 2 || field === 3) {
                if (wire !== 2) return malformed();
                const block = reader.block();
                if (field === 2) message = utf8.decode(block);
                else {
                    if (details.length >= maxDetails) return exceeded();
                    details.push(decodeAny(block));
                }
            } else reader.skip(field, wire);
        }
        // A mismatched payload is not authoritative over grpc-status. Validate
        // the full envelope before invoking application-owned detail decoders.
        if (code !== original.code) return result('code-mismatch');
        const decoded = details.map(detail => {
            try {
                const decoder = options.decoders && Object.hasOwn(options.decoders, detail.typeUrl) ? options.decoders[detail.typeUrl] : undefined;
                if (decoder !== undefined) {
                    // Give the decoder another copy so it cannot alter the raw detail.
                    const value = decoder(Buffer.from(detail.value));
                    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
                        let nativePromise = false;
                        try {
                            // A native rejected Promise can override its own then
                            // getter. Handle its rejection before inspecting that
                            // property; both handlers return void so the child settles.
                            Promise.prototype.then.call(value, () => {}, () => {});
                            nativePromise = true;
                        } catch { /* Non-Promise objects fail the intrinsic brand check. */ }
                        if (nativePromise) return Object.freeze({ ...detail, diagnostic: 'decoder-failed' as const });
                        if (typeof (value as { then?: unknown }).then === 'function') {
                            void Promise.resolve(value).catch(() => {});
                            return Object.freeze({ ...detail, diagnostic: 'decoder-failed' as const });
                        }
                    }
                    return Object.freeze({ ...detail, decoded: value });
                }
                return Object.freeze(detail);
            } catch { return Object.freeze({ ...detail, diagnostic: 'decoder-failed' as const }); }
        });
        return Object.freeze({ status: original, details: Object.freeze({ code, message, details: Object.freeze(decoded) }) });
    } catch (error) {
        return result(error instanceof DecodeFailure ? error.diagnostic : 'invalid-protobuf');
    }
}
