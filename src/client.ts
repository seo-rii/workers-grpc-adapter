/*
 * Copyright 2019 gRPC authors.
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

import {
  ClientDuplexStream,
  ClientDuplexStreamImpl,
  ClientReadableStream,
  ClientReadableStreamImpl,
  ClientUnaryCall,
  ClientUnaryCallImpl,
  ClientWritableStream,
  ClientWritableStreamImpl,
  ServiceError,
  callErrorFromStatus,
  SurfaceCall,
} from './call-surface';
import { CallCredentials } from './credentials';
import { StatusObject } from './call-interface';
import { Channel } from './channel';
import { WorkersGrpcConfigurationError } from './status';
import { ChannelCredentials } from './credentials';
import { ChannelOptions } from './options';
import { status as Status } from './status';
import { Metadata } from './metadata';
import { ClientMethodDefinition } from './factory';
import {
  getInterceptingCall,
  Interceptor,
  InterceptorProvider,
  InterceptorArguments,
  InterceptingCallInterface,
} from './client-interceptors';
import type { Deadline } from './call';

const CHANNEL_SYMBOL = Symbol();
const INTERCEPTOR_SYMBOL = Symbol();
const INTERCEPTOR_PROVIDER_SYMBOL = Symbol();
const CALL_INVOCATION_TRANSFORMER_SYMBOL = Symbol();

function isFunction<ResponseType>(
  arg: Metadata | CallOptions | UnaryCallback<ResponseType> | undefined
): arg is UnaryCallback<ResponseType> {
  return typeof arg === 'function';
}

export interface UnaryCallback<ResponseType> {
  (err: ServiceError | null, value?: ResponseType): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CallOptions {
  deadline?: Deadline;
  host?: string;
  /** Parent/server call propagation is unsupported by the Workers transport. */
  parent?: unknown;
  propagate_flags?: number;
  credentials?: CallCredentials;
  interceptors?: Interceptor[];
  interceptor_providers?: InterceptorProvider[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface CallProperties<RequestType, ResponseType> {
  argument?: RequestType;
  metadata: Metadata;
  call: SurfaceCall;
  channel: Channel;
  methodDefinition: ClientMethodDefinition<RequestType, ResponseType>;
  callOptions: CallOptions;
  callback?: UnaryCallback<ResponseType>;
}

export interface CallInvocationTransformer {
  (callProperties: CallProperties<any, any>): CallProperties<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type ClientOptions = Partial<ChannelOptions> & {
  channelOverride?: Channel;
  channelFactoryOverride?: (
    address: string,
    credentials: ChannelCredentials,
    options: ClientOptions
  ) => Channel;
  interceptors?: Interceptor[];
  interceptor_providers?: InterceptorProvider[];
  callInvocationTransformer?: CallInvocationTransformer;
};

function getErrorStackString(error: Error): string {
  return error.stack?.split('\n').slice(1).join('\n') || 'no stack trace available';
}

/**
 * A generic gRPC client. Primarily useful as a base class for all generated
 * clients.
 */
export class Client {
  private readonly [CHANNEL_SYMBOL]: Channel;
  private readonly [INTERCEPTOR_SYMBOL]: Interceptor[];
  private readonly [INTERCEPTOR_PROVIDER_SYMBOL]: InterceptorProvider[];
  private readonly [CALL_INVOCATION_TRANSFORMER_SYMBOL]?: CallInvocationTransformer;
  constructor(
    address: string,
    credentials: ChannelCredentials,
    options: ClientOptions = {}
  ) {
    options = Object.assign({}, options);
    this[INTERCEPTOR_SYMBOL] = options.interceptors ?? [];
    delete options.interceptors;
    this[INTERCEPTOR_PROVIDER_SYMBOL] = options.interceptor_providers ?? [];
    delete options.interceptor_providers;
    if (
      this[INTERCEPTOR_SYMBOL].length > 0 &&
      this[INTERCEPTOR_PROVIDER_SYMBOL].length > 0
    ) {
      throw new Error(
        'Both interceptors and interceptor_providers were passed as options ' +
          'to the client constructor. Only one of these is allowed.'
      );
    }
    this[CALL_INVOCATION_TRANSFORMER_SYMBOL] =
      options.callInvocationTransformer;
    delete options.callInvocationTransformer;
    if (options.channelOverride !== undefined || options.channelFactoryOverride !== undefined) {
      throw new WorkersGrpcConfigurationError('WGA_UNSUPPORTED_OPTION', 'Foreign channel overrides are not supported');
    }
    this[CHANNEL_SYMBOL] = new Channel(address, credentials, options);
  }

  close(): void {
    this[CHANNEL_SYMBOL].close();
  }

  getChannel(): Channel {
    return this[CHANNEL_SYMBOL];
  }

  waitForReady(deadline: Deadline, callback: (error?: Error) => void): void {
    // Workers fetch has no persistent connection readiness state.
    queueMicrotask(() => callback(Object.assign(new Error('WGA_CONNECTIVITY_UNSUPPORTED'), { code: Status.UNIMPLEMENTED })));
  }

  private checkOptionalUnaryResponseArguments<ResponseType>(
    arg1: Metadata | CallOptions | UnaryCallback<ResponseType>,
    arg2?: CallOptions | UnaryCallback<ResponseType>,
    arg3?: UnaryCallback<ResponseType>
  ): {
    metadata: Metadata;
    options: CallOptions;
    callback: UnaryCallback<ResponseType>;
  } {
    if (isFunction(arg1)) {
      return { metadata: new Metadata(), options: {}, callback: arg1 };
    } else if (isFunction(arg2)) {
      if (arg1 instanceof Metadata) {
        return { metadata: arg1, options: {}, callback: arg2 };
      } else {
        return { metadata: new Metadata(), options: arg1, callback: arg2 };
      }
    } else {
      if (
        !(
          arg1 instanceof Metadata &&
          arg2 instanceof Object &&
          isFunction(arg3)
        )
      ) {
        throw new Error('Incorrect arguments passed');
      }
      return { metadata: arg1, options: arg2, callback: arg3 };
    }
  }

  makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    argument: RequestType,
    metadata: Metadata,
    options: CallOptions,
    callback: UnaryCallback<ResponseType>
  ): ClientUnaryCall;
  makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    argument: RequestType,
    metadata: Metadata,
    callback: UnaryCallback<ResponseType>
  ): ClientUnaryCall;
  makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    argument: RequestType,
    options: CallOptions,
    callback: UnaryCallback<ResponseType>
  ): ClientUnaryCall;
  makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    argument: RequestType,
    callback: UnaryCallback<ResponseType>
  ): ClientUnaryCall;
  makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    argument: RequestType,
    metadata: Metadata | CallOptions | UnaryCallback<ResponseType>,
    options?: CallOptions | UnaryCallback<ResponseType>,
    callback?: UnaryCallback<ResponseType>
  ): ClientUnaryCall {
    const checkedArguments =
      this.checkOptionalUnaryResponseArguments<ResponseType>(
        metadata,
        options,
        callback
      );
    const methodDefinition: ClientMethodDefinition<RequestType, ResponseType> =
      {
        path: method,
        requestStream: false,
        responseStream: false,
        requestSerialize: serialize,
        responseDeserialize: deserialize,
      };
    let callProperties: CallProperties<RequestType, ResponseType> = {
      argument: argument,
      metadata: checkedArguments.metadata,
      call: new ClientUnaryCallImpl(),
      channel: this[CHANNEL_SYMBOL],
      methodDefinition: methodDefinition,
      callOptions: checkedArguments.options,
      callback: checkedArguments.callback,
    };
    if (this[CALL_INVOCATION_TRANSFORMER_SYMBOL]) {
      callProperties = this[CALL_INVOCATION_TRANSFORMER_SYMBOL]!(
        callProperties
      ) as CallProperties<RequestType, ResponseType>;
    }
    const emitter: ClientUnaryCall = callProperties.call;
    const interceptorArgs: InterceptorArguments = {
      clientInterceptors: this[INTERCEPTOR_SYMBOL],
      clientInterceptorProviders: this[INTERCEPTOR_PROVIDER_SYMBOL],
      callInterceptors: callProperties.callOptions.interceptors ?? [],
      callInterceptorProviders:
        callProperties.callOptions.interceptor_providers ?? [],
    };
    const call: InterceptingCallInterface = getInterceptingCall(
      interceptorArgs,
      callProperties.methodDefinition,
      callProperties.callOptions,
      callProperties.channel
    );
    /* This needs to happen before the emitter is used. Unfortunately we can't
     * enforce this with the type system. We need to construct this emitter
     * before calling the CallInvocationTransformer, and we need to create the
     * call after that. */
    emitter.call = call;
    let responseMessage: ResponseType | null = null;
    let receivedStatus = false;
    let callerStackError: Error | null = new Error();
    call.start(callProperties.metadata, {
      onReceiveMetadata: metadata => {
        emitter.emit('metadata', metadata);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onReceiveMessage(message: any) {
        if (responseMessage !== null) {
          call.cancelWithStatus(Status.UNIMPLEMENTED, 'Too many responses received');
        }
        responseMessage = message;
      },
      onReceiveStatus(status: StatusObject) {
        if (receivedStatus) {
          return;
        }
        receivedStatus = true;
        if (status.code === Status.OK) {
          if (responseMessage === null) {
            const callerStack = getErrorStackString(callerStackError!);
            callProperties.callback!(
              callErrorFromStatus(
                {
                  code: Status.UNIMPLEMENTED,
                  details: 'No message received',
                  metadata: status.metadata,
                },
                callerStack
              )
            );
          } else {
            callProperties.callback!(null, responseMessage);
          }
        } else {
          const callerStack = getErrorStackString(callerStackError!);
          callProperties.callback!(callErrorFromStatus(status, callerStack));
        }
        /* Avoid retaining the callerStackError object in the call context of
         * the status event handler. */
        callerStackError = null;
        emitter.emit('status', status);
      },
    });
    call.sendMessage(callProperties.argument);
    call.halfClose();
    return emitter;
  }

  makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    metadata: Metadata,
    options: CallOptions,
    callback: UnaryCallback<ResponseType>
  ): ClientWritableStream<RequestType>;
  makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    metadata: Metadata,
    callback: UnaryCallback<ResponseType>
  ): ClientWritableStream<RequestType>;
  makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    options: CallOptions,
    callback: UnaryCallback<ResponseType>
  ): ClientWritableStream<RequestType>;
  makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    callback: UnaryCallback<ResponseType>
  ): ClientWritableStream<RequestType>;
  makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    metadata: Metadata | CallOptions | UnaryCallback<ResponseType>,
    options?: CallOptions | UnaryCallback<ResponseType>,
    callback?: UnaryCallback<ResponseType>
  ): ClientWritableStream<RequestType> {
    const checkedArguments =
      this.checkOptionalUnaryResponseArguments<ResponseType>(
        metadata,
        options,
        callback
      );
    const methodDefinition: ClientMethodDefinition<RequestType, ResponseType> =
      {
        path: method,
        requestStream: true,
        responseStream: false,
        requestSerialize: serialize,
        responseDeserialize: deserialize,
      };
    let callProperties: CallProperties<RequestType, ResponseType> = {
      metadata: checkedArguments.metadata,
      call: new ClientWritableStreamImpl<RequestType>(serialize),
      channel: this[CHANNEL_SYMBOL],
      methodDefinition: methodDefinition,
      callOptions: checkedArguments.options,
      callback: checkedArguments.callback,
    };
    if (this[CALL_INVOCATION_TRANSFORMER_SYMBOL]) {
      callProperties = this[CALL_INVOCATION_TRANSFORMER_SYMBOL]!(
        callProperties
      ) as CallProperties<RequestType, ResponseType>;
    }
    const emitter: ClientWritableStream<RequestType> =
      callProperties.call as ClientWritableStream<RequestType>;
    const interceptorArgs: InterceptorArguments = {
      clientInterceptors: this[INTERCEPTOR_SYMBOL],
      clientInterceptorProviders: this[INTERCEPTOR_PROVIDER_SYMBOL],
      callInterceptors: callProperties.callOptions.interceptors ?? [],
      callInterceptorProviders:
        callProperties.callOptions.interceptor_providers ?? [],
    };
    const call: InterceptingCallInterface = getInterceptingCall(
      interceptorArgs,
      callProperties.methodDefinition,
      callProperties.callOptions,
      callProperties.channel
    );
    /* This needs to happen before the emitter is used. Unfortunately we can't
     * enforce this with the type system. We need to construct this emitter
     * before calling the CallInvocationTransformer, and we need to create the
     * call after that. */
    emitter.call = call;
    let responseMessage: ResponseType | null = null;
    let receivedStatus = false;
    let callerStackError: Error | null = new Error();
    call.start(callProperties.metadata, {
      onReceiveMetadata: metadata => {
        emitter.emit('metadata', metadata);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onReceiveMessage(message: any) {
        if (responseMessage !== null) {
          call.cancelWithStatus(Status.UNIMPLEMENTED, 'Too many responses received');
        }
        responseMessage = message;
        call.startRead();
      },
      onReceiveStatus(status: StatusObject) {
        if (receivedStatus) {
          return;
        }
        receivedStatus = true;
        if (status.code === Status.OK) {
          if (responseMessage === null) {
            const callerStack = getErrorStackString(callerStackError!);
            callProperties.callback!(
              callErrorFromStatus(
                {
                  code: Status.UNIMPLEMENTED,
                  details: 'No message received',
                  metadata: status.metadata,
                },
                callerStack
              )
            );
          } else {
            callProperties.callback!(null, responseMessage);
          }
        } else {
          const callerStack = getErrorStackString(callerStackError!);
          callProperties.callback!(callErrorFromStatus(status, callerStack));
        }
        /* Avoid retaining the callerStackError object in the call context of
         * the status event handler. */
        callerStackError = null;
        emitter.emit('status', status);
      },
    });
    return emitter;
  }

  private checkMetadataAndOptions(
    arg1?: Metadata | CallOptions,
    arg2?: CallOptions
  ): { metadata: Metadata; options: CallOptions } {
    let metadata: Metadata;
    let options: CallOptions;
    if (arg1 instanceof Metadata) {
      metadata = arg1;
      if (arg2) {
        options = arg2;
      } else {
        options = {};
      }
    } else {
      if (arg1) {
        options = arg1;
      } else {
        options = {};
      }
      metadata = new Metadata();
    }
    return { metadata, options };
  }

  makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    argument: RequestType,
    metadata: Metadata,
    options?: CallOptions
  ): ClientReadableStream<ResponseType>;
  makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    argument: RequestType,
    options?: CallOptions
  ): ClientReadableStream<ResponseType>;
  makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    argument: RequestType,
    metadata?: Metadata | CallOptions,
    options?: CallOptions
  ): ClientReadableStream<ResponseType> {
    const checkedArguments = this.checkMetadataAndOptions(metadata, options);
    const methodDefinition: ClientMethodDefinition<RequestType, ResponseType> =
      {
        path: method,
        requestStream: false,
        responseStream: true,
        requestSerialize: serialize,
        responseDeserialize: deserialize,
      };
    let callProperties: CallProperties<RequestType, ResponseType> = {
      argument: argument,
      metadata: checkedArguments.metadata,
      call: new ClientReadableStreamImpl<ResponseType>(deserialize),
      channel: this[CHANNEL_SYMBOL],
      methodDefinition: methodDefinition,
      callOptions: checkedArguments.options,
    };
    if (this[CALL_INVOCATION_TRANSFORMER_SYMBOL]) {
      callProperties = this[CALL_INVOCATION_TRANSFORMER_SYMBOL]!(
        callProperties
      ) as CallProperties<RequestType, ResponseType>;
    }
    const stream: ClientReadableStream<ResponseType> =
      callProperties.call as ClientReadableStream<ResponseType>;
    const interceptorArgs: InterceptorArguments = {
      clientInterceptors: this[INTERCEPTOR_SYMBOL],
      clientInterceptorProviders: this[INTERCEPTOR_PROVIDER_SYMBOL],
      callInterceptors: callProperties.callOptions.interceptors ?? [],
      callInterceptorProviders:
        callProperties.callOptions.interceptor_providers ?? [],
    };
    const call: InterceptingCallInterface = getInterceptingCall(
      interceptorArgs,
      callProperties.methodDefinition,
      callProperties.callOptions,
      callProperties.channel
    );
    /* This needs to happen before the emitter is used. Unfortunately we can't
     * enforce this with the type system. We need to construct this emitter
     * before calling the CallInvocationTransformer, and we need to create the
     * call after that. */
    stream.call = call;
    let receivedStatus = false;
    let callerStackError: Error | null = new Error();
    call.start(callProperties.metadata, {
      onReceiveMetadata(metadata: Metadata) {
        stream.emit('metadata', metadata);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onReceiveMessage(message: any) {
        stream.push(message);
      },
      onReceiveStatus(status: StatusObject) {
        if (receivedStatus) {
          return;
        }
        receivedStatus = true;
        stream.push(null);
        if (status.code !== Status.OK) {
          const callerStack = getErrorStackString(callerStackError!);
          stream.emit('error', callErrorFromStatus(status, callerStack));
        }
        /* Avoid retaining the callerStackError object in the call context of
         * the status event handler. */
        callerStackError = null;
        stream.emit('status', status);
      },
    });
    call.sendMessage(callProperties.argument);
    call.halfClose();
    return stream;
  }

  makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    metadata: Metadata,
    options?: CallOptions
  ): ClientDuplexStream<RequestType, ResponseType>;
  makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    options?: CallOptions
  ): ClientDuplexStream<RequestType, ResponseType>;
  makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    serialize: (value: RequestType) => Buffer,
    deserialize: (value: Buffer) => ResponseType,
    metadata?: Metadata | CallOptions,
    options?: CallOptions
  ): ClientDuplexStream<RequestType, ResponseType> {
    const checkedArguments = this.checkMetadataAndOptions(metadata, options);
    const methodDefinition: ClientMethodDefinition<RequestType, ResponseType> =
      {
        path: method,
        requestStream: true,
        responseStream: true,
        requestSerialize: serialize,
        responseDeserialize: deserialize,
      };
    let callProperties: CallProperties<RequestType, ResponseType> = {
      metadata: checkedArguments.metadata,
      call: new ClientDuplexStreamImpl<RequestType, ResponseType>(
        serialize,
        deserialize
      ),
      channel: this[CHANNEL_SYMBOL],
      methodDefinition: methodDefinition,
      callOptions: checkedArguments.options,
    };
    if (this[CALL_INVOCATION_TRANSFORMER_SYMBOL]) {
      callProperties = this[CALL_INVOCATION_TRANSFORMER_SYMBOL]!(
        callProperties
      ) as CallProperties<RequestType, ResponseType>;
    }
    const stream: ClientDuplexStream<RequestType, ResponseType> =
      callProperties.call as ClientDuplexStream<RequestType, ResponseType>;
    const interceptorArgs: InterceptorArguments = {
      clientInterceptors: this[INTERCEPTOR_SYMBOL],
      clientInterceptorProviders: this[INTERCEPTOR_PROVIDER_SYMBOL],
      callInterceptors: callProperties.callOptions.interceptors ?? [],
      callInterceptorProviders:
        callProperties.callOptions.interceptor_providers ?? [],
    };
    const call: InterceptingCallInterface = getInterceptingCall(
      interceptorArgs,
      callProperties.methodDefinition,
      callProperties.callOptions,
      callProperties.channel
    );
    /* This needs to happen before the emitter is used. Unfortunately we can't
     * enforce this with the type system. We need to construct this emitter
     * before calling the CallInvocationTransformer, and we need to create the
     * call after that. */
    stream.call = call;
    let receivedStatus = false;
    let callerStackError: Error | null = new Error();
    call.start(callProperties.metadata, {
      onReceiveMetadata(metadata: Metadata) {
        stream.emit('metadata', metadata);
      },
      onReceiveMessage(message: Buffer) {
        stream.push(message);
      },
      onReceiveStatus(status: StatusObject) {
        if (receivedStatus) {
          return;
        }
        receivedStatus = true;
        stream.push(null);
        if (status.code !== Status.OK) {
          const callerStack = getErrorStackString(callerStackError!);
          stream.emit('error', callErrorFromStatus(status, callerStack));
        }
        /* Avoid retaining the callerStackError object in the call context of
         * the status event handler. */
        callerStackError = null;
        stream.emit('status', status);
      },
    });
    return stream;
  }
}

export type { Deadline } from './call';
export type { StatusObject } from './call-interface';
export type { ClientMethodDefinition } from './factory';
export type { ClientUnaryCall, ClientReadableStream, ClientWritableStream, ClientDuplexStream, ServiceError, SurfaceCall } from './call-surface';
export { callErrorFromStatus } from './call-surface';
export function closeClient(client: Client): void { client.close(); }
export function getClientChannel(client: Client): Channel { return Client.prototype.getChannel.call(client); }
export function waitForClientReady(client: Client, deadline: Deadline, callback: (error?: Error) => void): void { client.waitForReady(deadline, callback); }
