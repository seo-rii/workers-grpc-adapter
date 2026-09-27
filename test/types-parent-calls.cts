import { ParentCall, Client, credentials, propagate } from '@grpc/grpc-js';
import { GrpcWebServerContext } from '@grpc/grpc-js/server';
import { ServerUnaryCall, ServerReadableStream, ServerWritableStream, ServerDuplexStream } from 'native-grpc-js';
import { Buffer } from 'node:buffer';
declare const nativeUnary: ServerUnaryCall<string, string>;
declare const nativeReadable: ServerReadableStream<string, string>;
declare const nativeWritable: ServerWritableStream<string, string>;
declare const nativeDuplex: ServerDuplexStream<string, string>;
declare const context: GrpcWebServerContext;
const parents: ParentCall[] = [nativeUnary, nativeReadable, nativeWritable, nativeDuplex, context];
const c = new Client('child.test', credentials.createSsl());
for (const parent of parents) c.makeUnaryRequest('/fixture.Child/Echo', Buffer.from, value => value, 'value', {
    parent, propagate_flags: propagate.DEADLINE | propagate.CANCELLATION,
}, () => {});
c.makeUnaryRequest('/fixture.Child/Echo', Buffer.from, value => value, 'value', { parent: null }, () => {});
// @ts-expect-error AbortSignal alone is not a grpc-js-compatible parent surface
const incomplete: ParentCall = new AbortController().signal;
// @ts-expect-error deadline-only objects cannot provide cancellation cleanup
const noEvents: ParentCall = { cancelled: false, getDeadline: () => Infinity };
