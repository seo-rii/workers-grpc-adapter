import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { check, withCleanup } from './assert.mjs';

const originalScenarios = [
  'list-manual-promise', 'list-manual-callback', 'list-auto', 'list-async', 'list-async-break',
  'access-promise', 'access-callback', 'access-empty', 'access-bad-crc', 'access-not-found', 'access-denied',
];
export const secretManagerContracts = Object.fromEntries(originalScenarios.map(scenario => [scenario, {
  kind: scenario === 'access-not-found' || scenario === 'access-denied' ? 'error' : 'success',
  method: scenario.startsWith('list-') ? 'ListSecrets' : 'AccessSecretVersion',
  pages: scenario.startsWith('list-') ? scenario === 'list-async-break' ? 1 : 3 : 0,
  rpcCount: scenario.startsWith('list-') ? scenario === 'list-async-break' ? 2 : 4
    : scenario === 'access-not-found' || scenario === 'access-denied' ? 2 : 1,
  ...(scenario === 'access-not-found' ? { errorCode: 5, shape: 'promise' }
    : scenario === 'access-denied' ? { errorCode: 7, shape: 'callback' } : {}),
}]));
for (const [prefix, method, codes] of [
  ['get', 'GetSecret', [3, 5, 7]], ['list', 'ListSecrets', [3, 7, 8, 14]],
  ['access', 'AccessSecretVersion', [3, 5, 7, 9, 14]],
]) for (const errorCode of codes) for (const shape of ['promise', 'callback']) {
  secretManagerContracts[`${prefix}-error-${errorCode}-${shape}`] = {
    kind: 'error', method, errorCode, shape, pages: method === 'ListSecrets' ? 1 : 0, rpcCount: 2,
  };
}
for (const shape of ['manual-promise', 'manual-callback', 'auto-promise', 'auto-callback', 'async']) {
  secretManagerContracts[`list-page-error-${shape}`] = {
    kind: 'page-error', method: 'ListSecrets', errorCode: 14, shape, pages: 2, rpcCount: 3,
  };
}
export const secretManagerScenarios = Object.keys(secretManagerContracts);

// Observer receipts contain identities and counters only, never method names,
// metadata, payloads, credentials, details, or SDK exception objects.
export async function secretManagerObservation(events, transport) {
  for (let turn = 0; turn < 10; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    const resources = transport.resourceUsage();
    if (resources.activeCalls === 0 && resources.queuedCalls === 0 && resources.bufferedBytes === 0) break;
  }
  const resources = transport.resourceUsage();
  check(resources.activeCalls === 0 && resources.queuedCalls === 0 && resources.bufferedBytes === 0,
    'sm-adapter-resource-cleanup');
  const ids = [...new Set(events.map(event => event.logicalCallId))];
  const calls = ids.map(logicalCallId => {
    const call = events.filter(event => event.logicalCallId === logicalCallId);
    const starts = call.filter(event => event.type === 'call-start');
    const ends = call.filter(event => event.type === 'call-end');
    const attempts = call.filter(event => event.type === 'attempt-start');
    const fetches = call.filter(event => event.type === 'fetch-start');
    check(/^wga-[1-9][0-9]*$/.test(logicalCallId) && starts.length === 1 && ends.length === 1
      && attempts.length === 1 && fetches.length === 1 && ends[0].attemptCount === 1
      && ends[0].fetchCount === 1, 'sm-observer-exact-call-lifetime');
    return { logicalCallId, startCount: starts.length, terminalCount: ends.length,
      attemptCount: attempts.length, fetchCount: fetches.length, statusCode: ends[0].statusCode };
  });
  return { calls, resources: { activeCalls: resources.activeCalls, queuedCalls: resources.queuedCalls,
    bufferedBytes: resources.bufferedBytes } };
}

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
export async function runSecretManagerExtended({ options, scenario, caseId, beforeClientClose }) {
  check(secretManagerScenarios.includes(scenario), 'sm-known-scenario');
  const client = new SecretManagerServiceClient({ ...options, fallback: false });
  const callOptions = () => ({ timeout: 5000, retry: null,
    otherArgs: { headers: { 'x-wga-case': caseId, 'x-goog-user-project': 'wga-billing-fixture' } } });
  const contract = secretManagerContracts[scenario];
  return withCleanup(async () => {
    if (contract.kind !== 'success') {
      let callbackCount = 0, rejectionCount = 0, resolutionCount = 0, resultAbsent = false;
      let deliveredItems = 0, completedPages = 0, failure;
      const request = contract.method === 'ListSecrets'
        ? { parent: secretManagerParent, pageSize: 2, filter: 'labels.fixture=synthetic' }
        : { name: contract.method === 'GetSecret' ? `${secretManagerParent}/secrets/synthetic` : secretManagerVersion };
      const method = contract.method[0].toLowerCase() + contract.method.slice(1);
      const invoke = (input, autoPaginate) => {
        const params = { ...callOptions(), ...(autoPaginate === undefined ? {} : { autoPaginate }) };
        if (contract.shape.endsWith('callback')) return new Promise((resolve, reject) => {
          client[method](input, params, (error, ...values) => {
            callbackCount++;
            if (error) {
              resultAbsent = values.every(value => value == null);
              reject(error);
            } else { resolutionCount++; resolve(values); }
          });
        });
        return client[method](input, params).then(value => { resolutionCount++; return value; }, error => {
          rejectionCount++; resultAbsent = true;
          throw error;
        });
      };
      try {
        if (contract.shape === 'async') {
          try {
            for await (const value of client.listSecretsAsync(request, callOptions())) {
              check(value.name === `${secretManagerParent}/secrets/item-${deliveredItems}`, 'sm-error-page-ordered-items');
              deliveredItems++;
            }
          } catch (error) { rejectionCount++; resultAbsent = true; throw error; }
          completedPages = deliveredItems / 2;
        } else if (contract.kind === 'page-error' && contract.shape.startsWith('manual-')) {
          const [values, next] = await invoke(request, false);
          check(values.length === 2 && next.pageToken === 'page-1', 'sm-error-first-page');
          check(values.every((value, index) => value.name === `${secretManagerParent}/secrets/item-${index}`),
            'sm-error-page-ordered-items');
          deliveredItems = values.length; completedPages++;
          await invoke(next, false);
        } else await invoke(request, contract.method === 'ListSecrets' ? contract.kind === 'page-error' : undefined);
      } catch (error) { failure = error; }
      if (contract.shape === 'async') completedPages = deliveredItems / 2;
      check(failure?.code === contract.errorCode, 'sm-error-status');
      check(failure.details === 'synthetic error: 한글 % value', 'sm-error-details');
      const text = failure.metadata?.get('x-wga-result').flatMap(value => String(value).split(/,\s*/));
      check(text?.length === 2 && text[0] === 'synthetic-error' && text[1] === 'synthetic-repeated',
        'sm-error-repeated-text-metadata');
      const binary = failure.metadata?.get('x-wga-result-bin');
      check(binary?.length === 2 && binary.every((bytes, item) => bytes instanceof Uint8Array
        && bytes.length === 4 && bytes.every((byte, index) => byte === [[0, 255, 128, 10], [13, 128, 0, 254]][item][index])),
      'sm-error-repeated-binary-metadata');
      check(resultAbsent, 'sm-error-result-absent');
      const [marker] = await client.getSecret({ name: `${secretManagerParent}/secrets/marker` }, callOptions());
      check(marker.name === `${secretManagerParent}/secrets/marker` && marker.labels.fixture === 'synthetic',
        'sm-client-reuse-after-error');
      await new Promise(resolve => setTimeout(resolve, 0));
      check(callbackCount === (contract.shape.endsWith('callback') ? contract.shape === 'manual-callback' ? 2 : 1 : 0)
        && resolutionCount === (contract.shape.startsWith('manual-') ? 1 : 0)
        && rejectionCount === (contract.shape.endsWith('callback') ? 0 : 1), 'sm-error-exact-terminal');
      const result = { scenario, errorCode: contract.errorCode, errorMetadata: true, detailsPreserved: true, repeatedTextMetadata: true,
        repeatedBinaryMetadata: true, callbackCount, rejectionCount, resolutionCount, resultAbsent, clientReuse: true };
      if (contract.kind === 'page-error') {
        const expected = contract.shape.startsWith('auto-') ? 0 : 2;
        check(deliveredItems === expected && completedPages === expected / 2, 'sm-error-page-delivery');
        return { ...result, deliveredItems, completedPages, nextPageSuppressed: true };
      }
      return result;
    }
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
  }, async () => {
    try { await beforeClientClose?.(); }
    finally { await client.close(); }
  });
}
