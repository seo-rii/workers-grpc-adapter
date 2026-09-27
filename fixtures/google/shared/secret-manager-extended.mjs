import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { check, withCleanup } from './assert.mjs';

export const secretManagerScenarios = [
  'list-manual-promise', 'list-manual-callback', 'list-auto', 'list-async', 'list-async-break',
  'access-promise', 'access-callback', 'access-empty', 'access-bad-crc', 'access-not-found', 'access-denied',
];
export const secretManagerParent = 'projects/wga-sm-fixture/locations/us-central1';
export const secretManagerVersion = `${secretManagerParent}/secrets/synthetic/versions/latest`;

// Synthetic bytes are created only at runtime. Never return a payload, hash,
// checksum, raw SDK response or exception to a Worker response or test report.
export function syntheticPayload(size) {
  return Uint8Array.from({ length: size }, (_, index) => (index * 73 + (index >>> 8) * 19 + 17) & 255);
}

export function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function safeSecretManagerError(error) {
  return error?.code === 'WGA_FIXTURE_ASSERTION' && /^sm-[a-z0-9-]+$/.test(error.message)
    ? error.message : 'sm-unexpected-failure';
}

// Run exactly this source with native grpc-js, the installed Node adapter and
// the bundled Worker. These are controlled service fixtures, not Google IAM.
export async function runSecretManagerExtended({ options, scenario, caseId }) {
  check(secretManagerScenarios.includes(scenario), 'sm-known-scenario');
  const client = new SecretManagerServiceClient({ ...options, fallback: false });
  const callOptions = () => ({ timeout: 5000, retry: null,
    otherArgs: { headers: { 'x-wga-case': caseId, 'x-goog-user-project': 'wga-billing-fixture' } } });
  return withCleanup(async () => {
    if (scenario.startsWith('list-')) {
      const names = [], pages = [];
      const collect = value => {
        check(value.labels?.fixture === 'synthetic' && value.replication?.automatic,
          'sm-list-response-metadata');
        names.push(value.name);
      };
      const request = { parent: secretManagerParent, pageSize: 2, filter: 'labels.fixture=synthetic' };
      if (scenario.startsWith('list-manual')) {
        let next = request;
        while (next) {
          const params = { ...callOptions(), autoPaginate: false };
          const result = scenario === 'list-manual-promise' ? await client.listSecrets(next, params)
            : await new Promise((resolve, reject) => client.listSecrets(next, params,
              (error, values, following, raw) => error ? reject(error) : resolve([values, following, raw])));
          const [values, following, raw] = result;
          check(values.length === 2 && raw.secrets.length === 2, 'sm-manual-page-size');
          check(raw.totalSize === 6, 'sm-manual-total-size');
          pages.push(raw.nextPageToken);
          check(raw.nextPageToken === (pages.length === 3 ? '' : `page-${pages.length}`), 'sm-manual-next-token');
          if (following) {
            check(following.parent === secretManagerParent && following.pageSize === 2
              && following.filter === request.filter && following.pageToken === raw.nextPageToken,
            'sm-manual-following-request');
          } else check(pages.length === 3, 'sm-manual-terminal-page');
          values.forEach(collect);
          next = following;
          check(pages.length <= 3, 'sm-manual-bounded-pages');
        }
      } else if (scenario === 'list-auto') {
        const [values] = await client.listSecrets(request, callOptions());
        values.forEach(collect);
      } else {
        for await (const value of client.listSecretsAsync(request, callOptions())) {
          collect(value);
          if (scenario === 'list-async-break') break;
        }
      }
      const expected = scenario === 'list-async-break' ? 1 : 6;
      check(names.length === expected && names.every((name, index) => name === `${secretManagerParent}/secrets/item-${index}`),
        'sm-list-ordered-items');
      // A same-client RPC provides a barrier after iterator break and proves
      // that stopping iteration does not poison later calls.
      const [marker] = await client.getSecret({ name: `${secretManagerParent}/secrets/marker` }, callOptions());
      check(marker.name === `${secretManagerParent}/secrets/marker` && marker.labels.fixture === 'synthetic',
        'sm-client-reuse-after-pagination');
      return { scenario, items: names.length, manualPages: pages.length, clientReuse: true };
    }
    if (scenario === 'access-not-found' || scenario === 'access-denied') {
      let failure;
      try {
        if (scenario === 'access-denied') await new Promise((resolve, reject) =>
          client.accessSecretVersion({ name: secretManagerVersion }, callOptions(),
            (error, response) => error ? reject(error) : resolve(response)));
        else await client.accessSecretVersion({ name: secretManagerVersion }, callOptions());
      }
      catch (error) { failure = error; }
      const code = scenario === 'access-not-found' ? 5 : 7;
      check(failure?.code === code, 'sm-error-status');
      check(failure.details === 'synthetic error: 한글 % value', 'sm-error-details');
      check(failure.metadata?.get('x-wga-result')[0] === 'synthetic-error', 'sm-error-text-metadata');
      const binary = failure.metadata?.get('x-wga-result-bin')[0];
      check(binary instanceof Uint8Array && binary.length === 4
        && binary.every((byte, index) => byte === [0, 255, 128, 10][index]), 'sm-error-binary-metadata');
      return { scenario, errorCode: code, errorMetadata: true };
    }
    const result = scenario === 'access-callback'
      ? await new Promise((resolve, reject) => client.accessSecretVersion({ name: secretManagerVersion }, callOptions(),
        (error, response) => error ? reject(error) : resolve(response)))
      : (await client.accessSecretVersion({ name: secretManagerVersion }, callOptions()))[0];
    const size = scenario === 'access-callback' ? 65536 : scenario === 'access-empty' ? 0 : scenario === 'access-bad-crc' ? 257 : 1024;
    const expected = syntheticPayload(size);
    check(result.name === secretManagerVersion, 'sm-access-resource-name');
    check(result.payload?.data instanceof Uint8Array, 'sm-access-binary-type');
    check(result.payload.data.length === expected.length
      && result.payload.data.every((byte, index) => byte === expected[index]), 'sm-access-binary-roundtrip');
    check(crc32c(new TextEncoder().encode('123456789')) === 0xe3069283 && crc32c(new Uint8Array()) === 0, 'sm-checksum-reference-vector');
    const checksumMatches = String(crc32c(result.payload.data)) === String(result.payload.dataCrc32c);
    // Secret Manager 7.1.0 forwards checksum data. Its generated method does
    // not validate it; applications must reject mismatches before using data.
    let consumerRejectedChecksum = false;
    try { check(checksumMatches, 'sm-checksum-mismatch'); }
    catch (error) {
      check(error.code === 'WGA_FIXTURE_ASSERTION' && error.message === 'sm-checksum-mismatch', 'sm-checksum-error-contract');
      consumerRejectedChecksum = true;
    }
    check(consumerRejectedChecksum === (scenario === 'access-bad-crc'), 'sm-consumer-checksum-decision');
    return { scenario, bytesChecked: size, sdkReturnedPayload: true, checksumMatches, consumerRejectedChecksum };
  }, () => client.close());
}
