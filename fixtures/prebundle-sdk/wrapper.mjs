// One static entry owns the SDK constructors, auth and transport configuration.
// Tokens are injected into the resulting package only at request time.
import { v1 } from '@google-cloud/firestore';
export { Firestore, Timestamp } from '@google-cloud/firestore';
// Own a stable snapshot of the SDK's lazily memoized namespace getter.
export const firestoreV1 = v1;
export { SecretManagerServiceClient } from '@google-cloud/secret-manager';
export { OAuth2Client } from 'google-auth-library';
export { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
export { cancellableCall } from '@grpc/grpc-js/sdk';
