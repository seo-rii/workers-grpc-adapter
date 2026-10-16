// This is the only source entry into the SDK and its owned adapter runtime.
// Application routes import the generated $lib/server package instead.
export { Datastore } from '@google-cloud/datastore';
export { OAuth2Client } from 'google-auth-library';
export { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
export { cancellableCall } from '@grpc/grpc-js/sdk';
