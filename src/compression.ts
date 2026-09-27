import { Buffer } from 'node:buffer';
import { createDeflate, createGzip, createGunzip, createInflate } from 'node:zlib';
import { status, TransportError } from './status';
import type { ByteLease, ResourceScope } from './resources';

export type CompressionEncoding = 'identity' | 'deflate' | 'gzip';

/** Each codec belongs to one message. Neither dictionaries nor output survive it. */
export function transformMessage(bytes: Uint8Array, encoding: Exclude<CompressionEncoding, 'identity'>,
    decompress: boolean, maxBytes: number, signal?: AbortSignal, scope?: ResourceScope): Promise<Buffer> {
    if (signal?.aborted) {
        return Promise.reject(new TransportError(status.CANCELLED, 'WGA_ABORTED'));
    }
    return new Promise((resolve, reject) => {
        // Codec-internal allocations are outside this budget. Reserve emitted
        // chunks before retaining them and the joined output before copying it.
        const partsLease = scope?.reserve(0);
        const options = { chunkSize: 16384 };
        const codec = decompress ? (encoding === 'gzip' ? createGunzip(options) : createInflate(options))
            : (encoding === 'gzip' ? createGzip(options) : createDeflate(options));
        let total = 0, settled = false;
        const parts: Buffer[] = [];
        const finish = (error?: TransportError) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            let result: Buffer | undefined;
            if (!error) {
                let resultLease: ByteLease | undefined;
                try {
                    resultLease = scope?.reserve(total);
                    result = Buffer.concat(parts, total);
                } catch (cause) {
                    resultLease?.release();
                    error = cause instanceof TransportError ? cause : new TransportError(status.INTERNAL, 'WGA_COMPRESSION_ENCODE');
                }
            }
            parts.length = 0;
            partsLease?.release();
            if (error) {
                codec.destroy();
                reject(error);
            }
            else {
                resolve(result!);
            }
        };
        const abort = () => finish(new TransportError(status.CANCELLED, 'WGA_ABORTED'));
        signal?.addEventListener('abort', abort, { once: true });
        codec.on('data', (chunk: Buffer) => {
            if (settled) return;
            total += chunk.length;
            if (total > maxBytes) {
                finish(new TransportError(status.RESOURCE_EXHAUSTED, decompress ? 'WGA_DECOMPRESSED_SIZE' : 'WGA_COMPRESSED_SIZE'));
                return;
            }
            try { partsLease?.resize(total); }
            catch (error) {
                finish(error instanceof TransportError ? error : new TransportError(status.INTERNAL, 'WGA_COMPRESSION_ENCODE'));
                return;
            }
            parts.push(chunk);
        });
        // Never include a codec's message, input or partial output in diagnostics.
        codec.on('error', () => finish(new TransportError(status.INTERNAL, decompress ? 'WGA_COMPRESSION_DATA' : 'WGA_COMPRESSION_ENCODE')));
        codec.once('end', () => finish());
        codec.once('close', () => {
            if (!settled) finish(new TransportError(status.INTERNAL, 'WGA_COMPRESSION_CLOSED'));
        });
        try {
            codec.end(bytes);
        }
        catch {
            finish(new TransportError(status.INTERNAL, decompress ? 'WGA_COMPRESSION_DATA' : 'WGA_COMPRESSION_ENCODE'));
        }
    });
}
