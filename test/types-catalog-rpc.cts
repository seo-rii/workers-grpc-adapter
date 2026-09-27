import { Client, Metadata, credentials, type CallOptions, type ClientUnaryCall, type ClientReadableStream, type ServiceError, type StatusObject, type requestCallback } from '@grpc/grpc-js';
import { Client as DeepClient } from '@grpc/grpc-js/build/src/client.js';
import type { EchoClient } from './generated/demo/Echo.js';
import type { Message__Output } from './generated/demo/Message.js';

type Request = { text: string };
type Response = { text: string };
type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
const client: DeepClient = new Client('example.test', credentials.createSsl());
const metadata = new Metadata();
const options: CallOptions = { deadline: new Date() };
const request: Request = { text: 'typed' };
const serialize = (value: Request): Buffer => Buffer.from(value.text);
const deserialize = (value: Buffer): Response => ({ text: value.toString() });
const callback: requestCallback<Response> = (error, response) => {
  const typedError: ServiceError | null = error;
  const text: string | undefined = response?.text;
  type ResponseIsTyped = Assert<NotAny<typeof response>>;
  // @ts-expect-error response fields retain their actual type
  const wrong: number | undefined = response?.text;
  void [typedError, text, wrong];
};
const directUnary = [
  client.makeUnaryRequest('/demo.Echo/Unary', serialize, deserialize, request, callback),
  client.makeUnaryRequest('/demo.Echo/Unary', serialize, deserialize, request, metadata, callback),
  client.makeUnaryRequest('/demo.Echo/Unary', serialize, deserialize, request, options, callback),
  client.makeUnaryRequest('/demo.Echo/Unary', serialize, deserialize, request, metadata, options, callback),
];
const directReadable = [
  client.makeServerStreamRequest('/demo.Echo/Stream', serialize, deserialize, request),
  client.makeServerStreamRequest('/demo.Echo/Stream', serialize, deserialize, request, metadata),
  client.makeServerStreamRequest('/demo.Echo/Stream', serialize, deserialize, request, options),
  client.makeServerStreamRequest('/demo.Echo/Stream', serialize, deserialize, request, metadata, options),
];
// This declaration is the unmodified client interface emitted by the pinned
// proto-loader generator. Native server handler declarations are not imported.
declare const generated: EchoClient;
const generatedCallback: requestCallback<Message__Output> = (error, response) => {
  const typed: ServiceError | null = error;
  const text: string | undefined = response?.text;
  type ResponseIsTyped = Assert<NotAny<typeof response>>;
  void [typed, text];
};
const generatedUnary = [
  generated.Unary(request, generatedCallback),
  generated.Unary(request, metadata, generatedCallback),
  generated.Unary(request, options, generatedCallback),
  generated.Unary(request, metadata, options, generatedCallback),
];
const generatedReadable = [
  generated.Stream(request), generated.Stream(request, metadata),
  generated.Stream(request, options), generated.Stream(request, metadata, options),
];
const checkedUnary: ClientUnaryCall[] = [...directUnary, ...generatedUnary];
const checkedReadable: ClientReadableStream<Response>[] = directReadable;
const checkedGeneratedReadable: ClientReadableStream<Message__Output>[] = generatedReadable;
type DirectCallIsTyped = Assert<NotAny<(typeof directUnary)[number]>>;
type GeneratedCallIsTyped = Assert<NotAny<(typeof generatedUnary)[number]>>;
client.makeUnaryRequest('/demo.Echo/Unary', serialize, deserialize, request, (error, response) => {
  type InferredResponseIsTyped = Assert<NotAny<typeof response>>;
  const value: string | undefined = response?.text;
  // @ts-expect-error direct inferred callback response retains its field type
  const invalid: number | undefined = response?.text;
  void [error, value, invalid];
});
generated.Unary(request, (error, response) => {
  type InferredResponseIsTyped = Assert<NotAny<typeof response>>;
  const value: string | undefined = response?.text;
  // @ts-expect-error generated inferred callback response retains its field type
  const invalid: number | undefined = response?.text;
  void [error, value, invalid];
});
void [checkedUnary, checkedReadable, checkedGeneratedReadable];
for (const stream of [...directReadable, ...generatedReadable]) {
  const decoded = stream.deserialize(Buffer.alloc(0));
  type MessageIsTyped = Assert<NotAny<typeof decoded>>;
  // The upstream EventEmitter fallback is permissive for a union of streams.
  // Match its supported explicit data listener contract instead of inventing inference.
  stream.on('data', (value: Response) => {
    const text: string = value.text;
    // @ts-expect-error inferred message data remains a string
    const wrong: number = value.text;
    void [text, wrong];
  });
  stream.on('metadata', received => {
    type MetadataIsTyped = Assert<NotAny<typeof received>>;
    const typed: Metadata = received;
    typed.get('x-example');
  });
  stream.on('status', received => {
    type StatusIsTyped = Assert<NotAny<typeof received>>;
    const typed: StatusObject = received;
    typed.details.toUpperCase();
  });
  // Upstream EventEmitter has a permissive error fallback, so the handler's
  // ServiceError annotation is explicit; this does not claim inferred errors.
  stream.on('error', (error: ServiceError) => { const code: number = error.code; error.metadata.get('x-error'); void code; });
  const cancel: () => void = () => stream.cancel();
  const peer: string = stream.getPeer();
  void [cancel, peer];
}
for (const call of [...directUnary, ...generatedUnary]) call.cancel();
// @ts-expect-error direct unary requires a callback
client.makeUnaryRequest('/demo.Echo/Unary', serialize, deserialize, request);
// @ts-expect-error generated unary requires a callback
generated.Unary(request);
// @ts-expect-error generated requests must match the protobuf message
generated.Unary({ text: 123 }, generatedCallback);
// @ts-expect-error generated streaming requests must match the protobuf message
generated.Stream({ text: 123 });
// @ts-expect-error direct requests must match the serializer input
client.makeUnaryRequest('/demo.Echo/Unary', serialize, deserialize, { text: 123 }, callback);
// @ts-expect-error direct streaming requests must match the serializer input
client.makeServerStreamRequest('/demo.Echo/Stream', serialize, deserialize, { text: 123 });
