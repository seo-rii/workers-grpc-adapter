// One static entry owns the SDK constructors, auth and transport configuration.
// Tokens are injected into the resulting package only at request time.
export { Firestore, Timestamp, v1 as firestoreV1 } from '@google-cloud/firestore';
export { SecretManagerServiceClient } from '@google-cloud/secret-manager';
export { OAuth2Client } from 'google-auth-library';
export { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
export { cancellableCall } from '@grpc/grpc-js/sdk';
