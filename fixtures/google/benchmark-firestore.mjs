import { Firestore } from '@google-cloud/firestore';
import { benchmarkWorker } from './benchmark-runtime.mjs';
export default benchmarkWorker({ Firestore });
