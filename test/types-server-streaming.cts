import { Buffer } from 'node:buffer';
import { createGrpcWebHandler, GrpcWebUnaryHandler, GrpcWebServerStreamingHandler,
    GrpcWebClientStreamingHandler, GrpcWebBidiStreamingHandler } from '@grpc/grpc-js/server';
const codec = { requestDeserialize: (bytes: Buffer) => ({ text: bytes.toString() }),
    responseSerialize: (value: { reply: string }) => Buffer.from(value.reply) };
const definition = {
    unary: { ...codec, path: '/test.Service/Unary', requestStream: false, responseStream: false },
    server: { ...codec, path: '/test.Service/Server', requestStream: false, responseStream: true },
    client: { ...codec, path: '/test.Service/Client', requestStream: true, responseStream: false },
    bidi: { ...codec, path: '/test.Service/Bidi', requestStream: true, responseStream: true },
} as const;
createGrpcWebHandler(definition, {
    unary: value => ({ reply: value.text }),
    async *server(value) { yield { reply: value.text }; },
    async client(input) { let reply = ''; for await (const value of input) reply += value.text; return { reply }; },
    async *bidi(input) { for await (const value of input) yield { reply: value.text }; },
});
createGrpcWebHandler({ call: definition.unary }, {
    // @ts-expect-error unary response cannot be an async iterable
    async *call(value) { yield { reply: value.text }; },
});
createGrpcWebHandler({ call: definition.server }, {
    // @ts-expect-error server-stream response must be an async iterable
    call(value) { return { reply: value.text }; },
});
createGrpcWebHandler({ call: definition.client }, {
    // @ts-expect-error client-stream input is AsyncIterable<Request>, not one Request
    call(value: { text: string }) { return { reply: value.text }; },
});
createGrpcWebHandler({ call: definition.bidi }, {
    // @ts-expect-error bidi response must be an async iterable
    async call(input) { for await (const value of input) return { reply: value.text }; return { reply: '' }; },
});
createGrpcWebHandler({ call: { ...codec, path: '/test.Service/Inline', requestStream: true, responseStream: true } }, {
    async *call(input) { for await (const value of input) yield { reply: value.text }; },
});
const unary: GrpcWebUnaryHandler<string, string> = value => value;
const server: GrpcWebServerStreamingHandler<string, string> = async function* (value) { yield value; };
const client: GrpcWebClientStreamingHandler<string, string> = async input => { for await (const value of input) return value; return ''; };
const bidi: GrpcWebBidiStreamingHandler<string, string> = async function* (input) { yield* input; };
void [unary, server, client, bidi];
