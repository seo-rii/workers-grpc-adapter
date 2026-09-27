import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { benchmarkWorker } from './benchmark-runtime.mjs';
export default benchmarkWorker({ SecretManagerServiceClient });
