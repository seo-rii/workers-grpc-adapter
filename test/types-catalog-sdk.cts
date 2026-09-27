import { Datastore, Query, Transaction } from '@google-cloud/datastore';
import type { entity } from '@google-cloud/datastore/build/src/entity.js';
import type { GetResponse } from '@google-cloud/datastore/build/src/request.js';
import type { RunQueryResponse } from '@google-cloud/datastore/build/src/query.js';
import type { RunResponse } from '@google-cloud/datastore/build/src/transaction.js';
import { Firestore, type DocumentSnapshot, type Query as FirestoreQuery } from '@google-cloud/firestore';
import { SecretManagerServiceClient, protos } from '@google-cloud/secret-manager';

type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
const datastore = new Datastore({ projectId: 'type-contract' });
const key = datastore.key(['Kind', 'name']);
const query = datastore.createQuery('Kind').filter('name', '=', 'value').limit(2);
const transaction = datastore.transaction({ readOnly: true });
const get = datastore.get(key);
const entities = datastore.runQuery(query);
const begun = transaction.run();
const txGet = transaction.get(key);
const txQuery = transaction.runQuery(query);
const checkedKey: entity.Key = key;
const checkedQuery: Query = query;
const checkedTransaction: Transaction = transaction;
const checkedGet: Promise<GetResponse> = get;
const checkedEntities: Promise<RunQueryResponse> = entities;
const checkedBegun: Promise<RunResponse> = begun;
const checkedTxGet: Promise<GetResponse> = txGet;
const checkedTxQuery: Promise<RunQueryResponse> = txQuery;
type GetIsTyped = Assert<NotAny<Awaited<typeof get>>>;
type QueryResponseIsTyped = Assert<NotAny<Awaited<typeof entities>>>;
type BeginResponseIsTyped = Assert<NotAny<Awaited<typeof begun>>>;
type BegunTransactionIsTyped = Assert<NotAny<Awaited<typeof begun>[0]>>;
type TxGetIsTyped = Assert<NotAny<Awaited<typeof txGet>>>;
type TxQueryIsTyped = Assert<NotAny<Awaited<typeof txQuery>>>;
get.then(tuple => {
  const tupleLength: 1 = tuple.length;
  // @ts-expect-error Datastore get is a one-element tuple
  void tuple[1];
  void tupleLength;
});
entities.then(([rows, info]) => { const cursor: string | undefined = info.endCursor; void [rows, cursor]; });
begun.then(([active, response]) => { const exact: Transaction = active; void [exact, response.transaction]; });
const firestore = new Firestore({ projectId: 'type-contract', preferRest: false });
const firestoreQuery = firestore.collection('typed').where('name', '==', 'value').limit(2);
const document = firestore.doc('typed/one').get();
const firestoreTransaction = firestore.runTransaction(async active => {
  const snapshot = await active.get(firestore.doc('typed/one'));
  return snapshot.exists ? 1 : 0;
});
const checkedFirestoreQuery: FirestoreQuery = firestoreQuery;
const checkedDocument: Promise<DocumentSnapshot> = document;
const checkedFirestoreTransaction: Promise<number> = firestoreTransaction;
type FirestoreQueryIsTyped = Assert<NotAny<typeof firestoreQuery>>;
type DocumentIsTyped = Assert<NotAny<Awaited<typeof document>>>;
type FirestoreTransactionIsTyped = Assert<NotAny<Awaited<typeof firestoreTransaction>>>;
const secrets = new SecretManagerServiceClient({ fallback: false, projectId: 'type-contract' });
const secretTuple = secrets.getSecret({ name: 'projects/type-contract/secrets/one' });
const exactSecretTuple: Promise<[protos.google.cloud.secretmanager.v1.ISecret, protos.google.cloud.secretmanager.v1.IGetSecretRequest | undefined, {} | undefined]> = secretTuple;
secretTuple.then(tuple => {
  const name: string | null | undefined = tuple[0].name;
  const tupleLength: 3 = tuple.length;
  // @ts-expect-error Secret Manager response is a three-element tuple
  void tuple[3];
  void [name, tupleLength];
});
type KeyIsTyped = Assert<NotAny<typeof key>>;
type QueryIsTyped = Assert<NotAny<typeof query>>;
type TransactionIsTyped = Assert<NotAny<typeof transaction>>;
type SecretIsTyped = Assert<NotAny<Awaited<typeof secretTuple>[0]>>;
// @ts-expect-error a plain object is not a Datastore Key
const invalidKey: entity.Key = { kind: 'Kind' };
// @ts-expect-error a string is not a Query
const invalidQuery: Query = 'Kind';
// @ts-expect-error numeric limit is required
query.limit('2');
void [txGet, txQuery, firestoreQuery, document, firestoreTransaction, exactSecretTuple, invalidKey, invalidQuery];

void [checkedKey, checkedQuery, checkedTransaction, checkedGet, checkedEntities, checkedBegun, checkedTxGet, checkedTxQuery, checkedFirestoreQuery, checkedDocument, checkedFirestoreTransaction];
