import { Datastore } from '@google-cloud/datastore';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Client, Metadata, credentials, Interceptor, InterceptorProvider, InterceptorOptions, InterceptingCallInterface, InterceptingCall, ListenerBuilder, RequesterBuilder, ClientOptions, CallOptions, CallProperties, CallInvocationTransformer, ClientUnaryCall, ClientReadableStream, ClientWritableStream, ClientDuplexStream, requestCallback, propagate } from '@grpc/grpc-js';
import { Client as DeepClient, ClientOptions as DeepClientOptions, CallOptions as DeepCallOptions, CallProperties as DeepCallProperties, CallInvocationTransformer as DeepCallInvocationTransformer } from '@grpc/grpc-js/build/src/client.js';

// Declaration-only consumers: the compiler does not execute these SDK/RPC calls.
// Runtime ordering, transport behavior and unsupported streaming use separate tests.

const datastore = new Datastore({ projectId: 'local-test-project' });
const key = datastore.key(['Compatibility', 'typed']);
datastore.get(key).then(([entity]) => entity);
const firestore = new Firestore({ projectId: 'local-test-project', preferRest: false });
firestore.doc('compatibility/typed').get().then(snapshot => snapshot.exists);
const secrets = new SecretManagerServiceClient({ fallback: false, projectId: 'local-test-project' });
secrets.getSecret({ name: 'projects/local-test-project/secrets/typed' }).then(([secret]) => secret.name);
const interceptor: Interceptor = (options, nextCall) => {
    const interceptorOptions: InterceptorOptions = options;
    const downstream: InterceptingCallInterface = nextCall(interceptorOptions);
    downstream.getAuthContext()?.transportSecurityType?.toUpperCase();
    const requester = new RequesterBuilder()
        .withStart((metadata, listener, next) => next(metadata, new ListenerBuilder()
            .withOnReceiveMetadata((receivedMetadata, forward) => forward(receivedMetadata))
            .withOnReceiveMessage((message, forward) => forward(message))
            .withOnReceiveStatus((receivedStatus, forward) => forward(receivedStatus))
            .build()))
        .withSendMessage((message, next) => next(message))
        .withHalfClose(next => next())
        .withCancel(next => next())
        .build();
    return new InterceptingCall(downstream, requester);
};
const provider: InterceptorProvider = method => {
    method.path.toUpperCase();
    const requestStream: boolean = method.requestStream;
    const responseStream: boolean = method.responseStream;
    void [requestStream, responseStream];
    return interceptor;
};
const transformer: CallInvocationTransformer = properties => {
    const rootProperties: CallProperties<Buffer, Buffer> = properties;
    const deepProperties: DeepCallProperties<Buffer, Buffer> = rootProperties;
    const transformedMetadata = deepProperties.metadata.clone();
    transformedMetadata.set('x-transformed', deepProperties.methodDefinition.path);
    deepProperties.call.getAuthContext()?.sslPeerCertificate?.subject.CN?.toUpperCase();
    return {
        ...deepProperties,
        metadata: transformedMetadata,
        callOptions: { ...deepProperties.callOptions, propagate_flags: propagate.DEADLINE | propagate.CANCELLATION },
    };
};
const deepTransformer: DeepCallInvocationTransformer = transformer;
const options: ClientOptions = { interceptors: [interceptor], callInvocationTransformer: deepTransformer };
const deepOptions: DeepClientOptions = options;
const rootClientConstructor: typeof Client = DeepClient;
const client = new Client('localhost:443', credentials.createSsl(), options);
const providerClient = new rootClientConstructor('localhost:443', credentials.createSsl(), { ...deepOptions, interceptors: undefined, interceptor_providers: [provider] });
const metadata: Metadata = new Metadata();
metadata.set('x-typed', 'value');

const callOptions: CallOptions = {
    deadline: new Date(Date.now() + 1000),
    interceptors: [interceptor],
    propagate_flags: propagate.DEFAULTS | propagate.CENSUS_STATS_CONTEXT | propagate.CENSUS_TRACING_CONTEXT,
    credentials: credentials.createEmpty(),
};
const deepCallOptions: DeepCallOptions = callOptions;
const providerCallOptions: CallOptions = { interceptor_providers: [provider], propagate_flags: propagate.DEADLINE };
const serialize = (value: Buffer): Buffer => value;
const deserialize = (value: Buffer): Buffer => value;
const callback: requestCallback<Buffer> = (error, response) => {
    error?.metadata.get('x-error');
    response?.readUInt8(0);
};
const unary: ClientUnaryCall = client.makeUnaryRequest('/fixture.Types/Unary', serialize, deserialize, Buffer.from('request'), metadata, deepCallOptions, callback);
const readable: ClientReadableStream<Buffer> = client.makeServerStreamRequest('/fixture.Types/ServerStream', serialize, deserialize, Buffer.from('request'), metadata, callOptions);
const writable: ClientWritableStream<Buffer> = providerClient.makeClientStreamRequest('/fixture.Types/ClientStream', serialize, deserialize, metadata, providerCallOptions, callback);
const duplex: ClientDuplexStream<Buffer, Buffer> = providerClient.makeBidiStreamRequest('/fixture.Types/Bidi', serialize, deserialize, metadata, providerCallOptions);
for (const call of [unary, readable, writable, duplex]) {
    call.getAuthContext()?.transportSecurityType?.toUpperCase();
    call.getAuthContext()?.sslPeerCertificate?.subject.CN?.toUpperCase();
    call.getPeer().toUpperCase();
    call.on('metadata', received => received.get('x-typed'));
    call.on('status', result => result.metadata.get('x-status'));
}
// grpc-js exposes per-message flags through the intercepting-call context.
unary.call?.sendMessageWithContext({ flags: 2, callback: error => error?.message.toUpperCase() }, Buffer.from('request'));
readable.on('data', (value: Buffer) => value.readUInt8(0));
duplex.on('data', (value: Buffer) => value.readUInt8(0));
void writable.write(Buffer.from('request'));
void duplex.write(Buffer.from('request'));
client.close();
providerClient.close();
