import { Datastore } from '@google-cloud/datastore';
import { benchmarkWorker } from './benchmark-runtime.mjs';
export default benchmarkWorker({ Datastore });
