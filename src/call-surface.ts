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

import { EventEmitter } from 'node:events';
import { Duplex, Readable, Writable } from 'node:stream';

import { StatusObject, MessageContext } from './call-interface';
import { status as Status } from './status';
import { EmitterAugmentation1 } from './events';
import { Metadata } from './metadata';
import { ObjectReadable, ObjectWritable, WriteCallback } from './object-stream';
import { InterceptingCallInterface } from './client-interceptors';
import { AuthContext } from './auth-context';

/**
 * A type extending the built-in Error object with additional fields.
 */
export type ServiceError = StatusObject & Error;

/**
 * A base type for all user-facing values returned by client-side method calls.
 */
export type SurfaceCall = {
  call?: InterceptingCallInterface;
  cancel(): void;
  getPeer(): string;
  getAuthContext(): AuthContext | null;
} & EmitterAugmentation1<'metadata', Metadata> &
  EmitterAugmentation1<'status', StatusObject> &
  EventEmitter;

/**
 * A type representing the return value of a unary method call.
 */
export type ClientUnaryCall = SurfaceCall;

/**
 * A type representing the return value of a server stream method call.
 */
export type ClientReadableStream<ResponseType> = {
  deserialize: (chunk: Buffer) => ResponseType;
} & SurfaceCall &
  ObjectReadable<ResponseType>;

/**
 * A type representing the return value of a client stream method call.
 */
export type ClientWritableStream<RequestType> = {
  serialize: (value: RequestType) => Buffer;
} & SurfaceCall &
  ObjectWritable<RequestType>;

/**
 * A type representing the return value of a bidirectional stream method call.
 */
export type ClientDuplexStream<RequestType, ResponseType> =
  ClientWritableStream<RequestType> & ClientReadableStream<ResponseType>;

/**
 * Construct a ServiceError from a StatusObject. This function exists primarily
 * as an attempt to make the error stack trace clearly communicate that the
 * error is not necessarily a problem in gRPC itself.
 * @param status
 */
export function callErrorFromStatus(
  status: StatusObject,
  callerStack: string
): ServiceError {
  const message = `${status.code} ${Status[status.code]}: ${status.details}`;
  const error = new Error(message);
  const stack = `${error.stack}\nfor call at\n${callerStack}`;
  return Object.assign(new Error(message), status, { stack });
}

const streamLifecycles = new WeakMap<SurfaceCall, ClientStreamLifecycle>();

/** Mark the RPC terminal before invoking user callbacks or stream events. */
export function markCallSurfaceTerminal(surface: SurfaceCall): void {
  streamLifecycles.get(surface)?.finish();
}

/** Node stream destruction and RPC completion are different lifecycle edges. */
class ClientStreamLifecycle {
  private terminal = false;
  private cancellationRequested = false;
  private pendingWrite?: WriteCallback;

  constructor(
    private readonly stream: SurfaceCall & (Readable | Writable | Duplex),
    private readonly writableOnly = false
  ) {
    streamLifecycles.set(stream, this);
  }

  finish(): void {
    this.terminal = true;
    // A Writable has no readable EOF: finish alone only half-closes its RPC.
    // Close its Node resource after the response has completed instead.
    if (this.writableOnly) queueMicrotask(() => this.stream.destroy());
  }

  cancel(): void {
    if (this.terminal || this.cancellationRequested) return;
    this.cancellationRequested = true;
    this.stream.call?.cancelWithStatus(Status.CANCELLED, 'Cancelled on client');
  }

  writeCallback(callback: WriteCallback): WriteCallback {
    const once: WriteCallback = error => {
      if (this.pendingWrite !== once) return;
      this.pendingWrite = undefined;
      callback(error);
    };
    this.pendingWrite = once;
    return once;
  }

  destroy(error: Error | null, callback: (error: Error | null) => void): void {
    try {
      this.cancel();
    } catch {
      // A cancellation interceptor cannot prevent local Node stream cleanup.
    }
    try {
      // Interceptors may retain the write callback without forwarding it. Node
      // cannot release queued writes until its active _write callback settles.
      this.pendingWrite?.(error ?? callErrorFromStatus({
        code: Status.CANCELLED, details: 'Cancelled on client', metadata: new Metadata(),
      }, ''));
    } finally {
      callback(error);
    }
  }
}

export class ClientUnaryCallImpl
  extends EventEmitter
  implements ClientUnaryCall
{
  public call?: InterceptingCallInterface;
  constructor() {
    super();
  }

  cancel(): void {
    this.call?.cancelWithStatus(Status.CANCELLED, 'Cancelled on client');
  }

  getPeer(): string {
    return this.call?.getPeer() ?? 'unknown';
  }

  getAuthContext(): AuthContext | null {
    return this.call?.getAuthContext() ?? null;
  }
}

export class ClientReadableStreamImpl<ResponseType>
  extends Readable
  implements ClientReadableStream<ResponseType>
{
  public call?: InterceptingCallInterface;
  private readonly lifecycle = new ClientStreamLifecycle(this);
  constructor(readonly deserialize: (chunk: Buffer) => ResponseType, readableHighWaterMark?: number) {
    super({ objectMode: true, ...(readableHighWaterMark === undefined ? {} : { highWaterMark: readableHighWaterMark }) });
  }

  cancel(): void {
    this.lifecycle.cancel();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.lifecycle.destroy(error, callback);
  }

  getPeer(): string {
    return this.call?.getPeer() ?? 'unknown';
  }

  getAuthContext(): AuthContext | null {
    return this.call?.getAuthContext() ?? null;
  }

  _read(_size: number): void {
    this.call?.startRead();
  }
}

export class ClientWritableStreamImpl<RequestType>
  extends Writable
  implements ClientWritableStream<RequestType>
{
  public call?: InterceptingCallInterface;
  private readonly lifecycle = new ClientStreamLifecycle(this, true);
  constructor(readonly serialize: (value: RequestType) => Buffer) {
    super({ objectMode: true, autoDestroy: false });
  }

  cancel(): void {
    this.lifecycle.cancel();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.lifecycle.destroy(error, callback);
  }

  getPeer(): string {
    return this.call?.getPeer() ?? 'unknown';
  }

  getAuthContext(): AuthContext | null {
    return this.call?.getAuthContext() ?? null;
  }

  _write(chunk: RequestType, encoding: string, cb: WriteCallback) {
    const context: MessageContext = {
      callback: this.lifecycle.writeCallback(cb),
    };
    const flags = Number(encoding);
    if (!Number.isNaN(flags)) {
      context.flags = flags;
    }
    this.call?.sendMessageWithContext(context, chunk);
  }

  _final(cb: Function) {
    this.call?.halfClose();
    cb();
  }
}

export class ClientDuplexStreamImpl<RequestType, ResponseType>
  extends Duplex
  implements ClientDuplexStream<RequestType, ResponseType>
{
  public call?: InterceptingCallInterface;
  private readonly lifecycle = new ClientStreamLifecycle(this);
  constructor(
    readonly serialize: (value: RequestType) => Buffer,
    readonly deserialize: (chunk: Buffer) => ResponseType,
    readableHighWaterMark?: number
  ) {
    super({ objectMode: true, ...(readableHighWaterMark === undefined ? {} : { readableHighWaterMark }) });
  }

  cancel(): void {
    this.lifecycle.cancel();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.lifecycle.destroy(error, callback);
  }

  getPeer(): string {
    return this.call?.getPeer() ?? 'unknown';
  }

  getAuthContext(): AuthContext | null {
    return this.call?.getAuthContext() ?? null;
  }

  _read(_size: number): void {
    this.call?.startRead();
  }

  _write(chunk: RequestType, encoding: string, cb: WriteCallback) {
    const context: MessageContext = {
      callback: this.lifecycle.writeCallback(cb),
    };
    const flags = Number(encoding);
    if (!Number.isNaN(flags)) {
      context.flags = flags;
    }
    this.call?.sendMessageWithContext(context, chunk);
  }

  _final(cb: Function) {
    this.call?.halfClose();
    cb();
  }
}
