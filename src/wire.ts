import { Buffer } from 'node:buffer';
import { Metadata } from './metadata';
import { status, TransportError } from './status';
export const METADATA_LIMIT = 65536;
export interface StatusObject {
    code: status;
    details: string;
    metadata: Metadata;
}
export interface Frame {
    trailer: boolean;
    payload: Buffer;
}
const owned = new Set(['content-type', 'content-length', 'connection', 'transfer-encoding', 'host', 'te', 'grpc-timeout', 'grpc-encoding', 'grpc-accept-encoding', 'x-grpc-web', 'accept']);
const responseControl = new Set(['content-type', 'content-length', 'grpc-status', 'grpc-message', 'grpc-encoding', 'grpc-accept-encoding', 'transfer-encoding', 'connection', 'date']);
function wireError(code: status, id: string): never {
    throw new TransportError(code, id);
}
export function encodeFrame(payload: Uint8Array, trailer = false): Buffer {
    if (payload.byteLength > 0xffffffff) {
        return wireError(status.RESOURCE_EXHAUSTED, 'WGA_FRAME_SIZE');
    }
    const out = Buffer.allocUnsafe(5 + payload.byteLength);
    out[0] = trailer ? 0x80 : 0;
    out.writeUInt32BE(payload.byteLength, 1);
    out.set(payload, 5);
    return out;
}
/** The parser holds one current Fetch chunk and one frame, never a growing stream array. */
export async function* decodeFrames(body: ReadableStream<Uint8Array>, maxMessageBytes: number, signal?: AbortSignal): AsyncGenerator<Frame> {
    const reader = body.getReader();
    let chunk: Uint8Array = new Uint8Array(0), offset = 0, ended = false;
    const abort = () => {
        void reader.cancel().catch(() => {
        });
    };
    signal?.addEventListener('abort', abort, { once: true });
    async function readExact(count: number, allowEOF = false): Promise<Buffer | null> {
        const out = Buffer.allocUnsafe(count);
        let filled = 0;
        while (filled < count) {
            if (signal?.aborted) {
                return wireError(status.CANCELLED, 'WGA_ABORTED');
            }
            if (offset === chunk.byteLength) {
                const item = await reader.read();
                if (item.done) {
                    ended = true;
                    if (allowEOF && filled === 0) {
                        return null;
                    }
                    return wireError(status.INTERNAL, 'WGA_TRUNCATED_FRAME');
                }
                if (!(item.value instanceof Uint8Array)) {
                    return wireError(status.INTERNAL, 'WGA_INVALID_CHUNK');
                }
                chunk = item.value;
                offset = 0;
                if (chunk.byteLength === 0) {
                    continue;
                }
            }
            const n = Math.min(count - filled, chunk.byteLength - offset);
            out.set(chunk.subarray(offset, offset + n), filled);
            offset += n;
            filled += n;
        }
        return out;
    }
    let hadTrailer = false;
    try {
        for (;;) {
            const header = await readExact(5, true);
            if (header === null) {
                return;
            }
            if (hadTrailer) {
                return wireError(status.INTERNAL, 'WGA_FRAME_AFTER_TRAILER');
            }
            const flag = header[0];
            if (flag !== 0 && flag !== 0x80) {
                if (flag === 1 || flag === 0x81) {
                    return wireError(status.UNIMPLEMENTED, 'WGA_COMPRESSION');
                }
                return wireError(status.INTERNAL, 'WGA_FRAME_FLAGS');
            }
            const trailer = flag === 0x80, length = header.readUInt32BE(1);
            if (length > (trailer ? METADATA_LIMIT : maxMessageBytes)) {
                return wireError(status.RESOURCE_EXHAUSTED, 'WGA_FRAME_SIZE');
            }
            const payload = await readExact(length);
            hadTrailer = trailer;
            yield { trailer, payload: payload! };
        }
    }
    finally {
        signal?.removeEventListener('abort', abort);
        if (!ended) {
            await reader.cancel().catch(() => {
            });
        }
        reader.releaseLock();
        chunk = new Uint8Array(0);
    }
}
function decodeBase64(value: string): Buffer {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1) {
        return wireError(status.INTERNAL, 'WGA_BINARY_METADATA');
    }
    const out = Buffer.from(value, 'base64');
    if (out.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
        return wireError(status.INTERNAL, 'WGA_BINARY_METADATA');
    }
    return out;
}
function addHeader(metadata: Metadata, key: string, value: string): void {
    try {
        if (key.endsWith('-bin')) {
            for (const part of value.split(',')) {
                metadata.add(key, decodeBase64(part.trim()));
            }
        }
        else {
            metadata.add(key, value);
        }
    }
    catch (e) {
        if (e instanceof TransportError) {
            throw e;
        }
        wireError(status.INTERNAL, 'WGA_INVALID_METADATA');
    }
}
function headerBudget(entries: Iterable<[
    string,
    string
]>): [
    string,
    string
][] {
    let size = 0;
    const result: [
        string,
        string
    ][] = [];
    for (const [key, value] of entries) {
        size += Buffer.byteLength(key) + Buffer.byteLength(value) + 32;
        if (size > METADATA_LIMIT) {
            return wireError(status.RESOURCE_EXHAUSTED, 'WGA_METADATA_SIZE');
        }
        result.push([key.toLowerCase(), value]);
    }
    return result;
}
export function metadataFromHeaders(headers: Headers): Metadata {
    const out = new Metadata();
    for (const [key, value] of headerBudget(headers.entries())) {
        if (!responseControl.has(key)) {
            addHeader(out, key, value);
        }
    }
    return out;
}
function statusFromPairs(entries: Iterable<[
    string,
    string
]>): StatusObject | null {
    let code: string | undefined, details = '';
    const metadata = new Metadata();
    for (const [key, value] of headerBudget(entries)) {
        if (key === 'grpc-status') {
            if (code !== undefined) {
                return wireError(status.INTERNAL, 'WGA_DUPLICATE_STATUS');
            }
            code = value;
        }
        else {
            if (key === 'grpc-message') {
                try {
                    details = decodeURIComponent(value);
                }
                catch {
                    details = value;
                }
            }
            else {
                if (!responseControl.has(key)) {
                    addHeader(metadata, key, value);
                }
            }
        }
    }
    if (code === undefined) {
        return null;
    }
    if (!/^(?:[0-9]|1[0-6])$/.test(code)) {
        return wireError(status.INTERNAL, 'WGA_INVALID_STATUS');
    }
    return { code: Number(code), details, metadata };
}
export function statusFromHeaders(headers: Headers): StatusObject | null {
    return statusFromPairs(headers.entries());
}
export function parseTrailers(payload: Buffer): StatusObject | null {
    if (payload.length > METADATA_LIMIT) {
        return wireError(status.RESOURCE_EXHAUSTED, 'WGA_METADATA_SIZE');
    }
    if (payload.some(byte => byte > 127)) {
        return wireError(status.INTERNAL, 'WGA_INVALID_TRAILERS');
    }
    const text = payload.toString('ascii');
    const entries: [
        string,
        string
    ][] = [];
    for (const line of text.split('\r\n')) {
        if (!line) {
            continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0 || /[\r\n]/.test(line)) {
            return wireError(status.INTERNAL, 'WGA_INVALID_TRAILERS');
        }
        entries.push([line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]);
    }
    return statusFromPairs(entries);
}
export function encodeTimeout(milliseconds: number): string {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError('Expected finite nonnegative timeout');
    }
    const units: [
        string,
        number
    ][] = [['m', 1], ['S', 1000], ['M', 60000], ['H', 3600000]];
    for (const [unit, scale] of units) {
        const value = Math.ceil(milliseconds / scale);
        if (value <= 99999999) {
            return `${Math.max(1, value)}${unit}`;
        }
    }
    return '99999999H';
}
export function requestHeaders(metadata: Metadata, timeoutMs?: number, userAgent?: string): Headers {
    const headers = new Headers({ 'content-type': 'application/grpc-web+proto', 'accept': 'application/grpc-web+proto',
        'x-grpc-web': '1', 'grpc-encoding': 'identity', 'grpc-accept-encoding': 'identity' });
    if (metadata.get('authorization').length > 1) {
        return wireError(status.INTERNAL, 'WGA_DUPLICATE_AUTHORIZATION');
    }
    let size = 0;
    for (const [key, values] of metadata.entries()) {
        if (owned.has(key) || key.startsWith(':') || key === 'grpc-status' || key === 'grpc-message') {
            return wireError(status.INTERNAL, 'WGA_RESERVED_METADATA');
        }
        for (const value of values) {
            const encoded = Buffer.isBuffer(value) ? value.toString('base64') : value;
            size += Buffer.byteLength(key) + Buffer.byteLength(encoded) + 32;
            if (size > METADATA_LIMIT) {
                return wireError(status.RESOURCE_EXHAUSTED, 'WGA_METADATA_SIZE');
            }
            headers.append(key, encoded);
        }
    }
    if (timeoutMs !== undefined) {
        headers.set('grpc-timeout', encodeTimeout(timeoutMs));
    }
    if (userAgent) {
        headers.set('x-user-agent', userAgent);
    }
    headerBudget(headers.entries());
    return headers;
}
