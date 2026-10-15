import { firestoreV1, SecretManagerServiceClient, OAuth2Client,
  createWorkersGrpcTransport } from './generated/index.mjs';

// This is an expected-negative compilation, not an executable consumer. The
// runner requires exactly the profile-specific authClient incompatibility.
// No cast, ignore directive, compiler relaxation, or private SDK import is used.
const transport = createWorkersGrpcTransport({ mode: 'cloudflare' });
const options = transport.gaxOptions({ projectId: 'wga-prebundle-fixture', authClient: new OAuth2Client() });
new firestoreV1.FirestoreClient(options);
new SecretManagerServiceClient(options);
