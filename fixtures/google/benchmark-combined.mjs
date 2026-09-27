import { Datastore } from '@google-cloud/datastore';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { benchmarkWorker } from './benchmark-runtime.mjs';
export default benchmarkWorker({ Datastore, Firestore, SecretManagerServiceClient });
