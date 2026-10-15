// SvelteKit enforces the server-only boundary at this facade. The generated
// workspace package owns both SDK constructors and adapter configuration.
export { Datastore, OAuth2Client, createWorkersGrpcTransport, cancellableCall } from '@wga-fixture/google-workers';
