import { Firestore, Timestamp, firestoreV1, SecretManagerServiceClient, OAuth2Client,
  createWorkersGrpcTransport, cancellableCall } from './generated/index.mjs';
import type { DocumentSnapshot, QuerySnapshot, WriteResult } from '@google-cloud/firestore';

// noEmit only: the declarations must resolve from the generated package while
// the original exact SDK types are still installed in this build project.
async function consumer(): Promise<void> {
  const transport = createWorkersGrpcTransport({ mode: 'cloudflare' });
  const options = transport.gaxOptions({ projectId: 'wga-prebundle-fixture' });
  // Different SDKs in each inspected graph own different auth majors and
  // nominal AnyAuthClient types. Check OAuth's public API independently;
  // sharing runtime auth structurally is covered by the workerd scenario.
  const auth: OAuth2Client = new OAuth2Client();
  await auth.getRequestHeaders();
  const firestore = new Firestore({ ...options, preferRest: false, useBigInt: true });
  const timestamp: Timestamp = new Timestamp(1700000000, 123456789);
  const write: WriteResult = await firestore.doc('fixture/value').set({ large: 9007199254740993n, time: timestamp });
  const document: DocumentSnapshot = await firestore.doc('fixture/value').get();
  const query: QuerySnapshot = await firestore.collection('fixture').where('time', '==', timestamp).get();
  const secret = new SecretManagerServiceClient(options);
  const generatedFirestore = new firestoreV1.FirestoreClient(options);
  const operation = cancellableCall(scoped => secret.accessSecretVersion({ name: 'fixture-version' }, scoped),
    { signal: new AbortController().signal, gaxOptions: { timeout: 1500, retry: null } });
  const [response] = await operation.promise;
  const name: string | null | undefined = response.name;
  // @ts-expect-error Timestamp nanoseconds are numeric.
  new Timestamp(1700000000, '123456789');
  // @ts-expect-error Secret Manager resource names are strings.
  secret.accessSecretVersion({ name: 123 });
  void [write, document, query, name, generatedFirestore];
}
void consumer;
