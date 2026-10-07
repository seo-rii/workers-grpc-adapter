/*
 * Copyright 2019 gRPC authors.
 *
 * Modified by workers-grpc-adapter contributors for the Fetch-based Workers
 * transport. See vendor/UPSTREAM.json and vendor/patches for provenance.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

export { HealthClient, HealthWatch, HealthServingStatus } from './health';
export type { HealthCheckResponse, HealthCallOptions, HealthWatchOptions, HealthWaitOptions, HealthWatchState } from './health';
export { status, connectivityState, compressionAlgorithms, propagate, WorkersGrpcConfigurationError } from './status';
export { Metadata } from './metadata';
export type { MetadataValue, MetadataOptions } from './metadata';
export { ChannelCredentials, CallCredentials, credentials } from './credentials';
export type { CallMetadataOptions, MetadataGenerator, GoogleCredential, LegacyGoogleCredential } from './credentials';
export { Client, closeClient, getClientChannel, waitForClientReady } from './client';
export type { ClientUnaryCall, ClientReadableStream, ClientWritableStream, ClientDuplexStream } from './call-surface';
export type { ParentCall } from './call';
export type { ClientOptions, CallOptions, UnaryCallback, ServiceError, Deadline, StatusObject, CallProperties, CallInvocationTransformer, ClientMethodDefinition } from './client';
export { Channel } from './channel';
export type { ChannelOptions } from './options';
export { makeGenericClientConstructor, makeClientConstructor, loadPackageDefinition } from './factory';
export type { MethodDefinition, ServiceDefinition, ServiceClient, ServiceClientConstructor, GrpcObject, ProtobufTypeDefinition, PackageDefinition, ServerMethodDefinition, Serialize as serialize, Deserialize as deserialize } from './factory';
export type { UnaryCallback as requestCallback } from './client';
export type { Channel as ChannelInterface } from './channel';
export type { AuthContext } from './auth-context';
export { StatusBuilder } from './status-builder';
export { InterceptingCall, InterceptorConfigurationError, ListenerBuilder, RequesterBuilder } from './client-interceptors';
export type { Requester, FullRequester, Interceptor, InterceptorOptions, InterceptorProvider, InterceptingCallInterface, NextCall, MetadataRequester, MessageRequester, CloseRequester, CancelRequester } from './client-interceptors';
export type { Listener, InterceptingListener, MetadataListener, MessageListener, StatusListener } from './call-interface';
export type Call = import('./call-surface').ClientUnaryCall | import('./call-surface').ClientReadableStream<any> | import('./call-surface').ClientWritableStream<any> | import('./call-surface').ClientDuplexStream<any, any>;
import { WorkersGrpcConfigurationError } from './status';
export class Server {
    constructor(..._args: unknown[]) {
        throw new WorkersGrpcConfigurationError('WGA_SERVER_UNSUPPORTED', 'This package is client-only');
    }
}
export class ServerCredentials {
    static createInsecure(): never {
        throw new WorkersGrpcConfigurationError('WGA_SERVER_UNSUPPORTED', 'This package is client-only');
    }
    static createSsl(..._args: unknown[]): never {
        return this.createInsecure();
    }
}
