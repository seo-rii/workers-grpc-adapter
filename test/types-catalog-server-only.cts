import type { Datastore } from '@google-cloud/datastore';
import type { Server, ServerCredentials, ServerMethodDefinition } from '@grpc/grpc-js';
import type { Client as DeepClient } from '@grpc/grpc-js/build/src/client.js';
// A SDK-facing module uses the supported server declaration surface only.
// The compiler must resolve every declaration and erase every imported type.
export interface SdkServerTypes {
  sdk: Datastore;
  client: DeepClient;
  server: Server;
  credentials: ServerCredentials;
  definition: ServerMethodDefinition<{ text: string }, { text: string }>;
}
export const typeOnlySentinel = 'server-types-erased';
