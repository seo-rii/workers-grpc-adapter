import { Firestore, Timestamp, SecretManagerServiceClient, OAuth2Client,
  createWorkersGrpcTransport, cancellableCall } from '@wga-fixture/google-sdks';
import { syntheticPayload, crc32c } from './values.cjs';

const secretParent = 'projects/wga-prebundle-fixture/locations/us-central1';
const secretVersion = `${secretParent}/secrets/synthetic/versions/latest`;
const scenarios = ['firestore-values', 'firestore-stream-error', 'secret-access', 'secret-list',
  'secret-denied', 'secret-unavailable', 'secret-cancel'];
function check(value, diagnostic) {
  if (!value) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic });
}
async function idle(transport, readers) {
  for (let turn = 0; turn < 100; turn++) {
    const usage = transport.resourceUsage();
    if (usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0
      && readers.every(reader => reader.released && !reader.source.locked && !reader.body.locked)) return usage;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  check(false, 'MATRIX_RESOURCES_IDLE');
}
function trailers(error, code) {
  check(error?.code === code && error.details === 'synthetic denied: 한글 %', 'MATRIX_ERROR_STATUS_DETAILS');
  const text = error.metadata?.get('x-fixture-result').flatMap(value => String(value).split(/,\s*/));
  check(JSON.stringify(text) === JSON.stringify(['denied', 'repeated']), 'MATRIX_TEXT_TRAILERS');
  const bytes = error.metadata?.get('x-fixture-result-bin');
  check(bytes?.length === 2 && bytes.every((value, index) => value instanceof Uint8Array
    && value.length === 3 && value.every((byte, offset) => byte === [[0, 255, 128], [13, 0, 254]][index][offset])),
  'MATRIX_BINARY_TRAILERS');
}
function values(snapshot) {
  check(snapshot.exists && snapshot.get('large') === 9007199254740993n, 'MATRIX_INT64');
  const timestamp = snapshot.get('time');
  check(timestamp instanceof Timestamp && timestamp.seconds === 1700000000
    && timestamp.nanoseconds === 123456789, 'MATRIX_TIMESTAMP');
  const bytes = snapshot.get('bytes');
  check(bytes instanceof Uint8Array && bytes.length === 4
    && bytes.every((byte, index) => byte === [0, 255, 128, 7][index]), 'MATRIX_DOCUMENT_BYTES');
}
async function firestoreCase({ scenario, options, caseId }) {
  // Read GAX retries are disabled. Public high-level writes supply their own
  // retry options, so Commit is tested only on success. The partial-stream case
  // uses permanent code 7 and cannot enter the separate cursor-resumption loop.
  const methods = Object.fromEntries(['BatchGetDocuments', 'RunQuery'].map(method =>
    [method, { timeout_millis: 1500, retry_codes_name: 'fixture_no_retry' }]));
  const firestore = new Firestore({ ...options, preferRest: false, useBigInt: true,
    customHeaders: { 'x-wga-case': caseId }, clientConfig: { interfaces: {
      'google.firestore.v1.Firestore': { retry_codes: { fixture_no_retry: [] }, methods },
    } },
  });
  try {
    const collection = firestore.collection('wga_prebundle');
    if (scenario === 'firestore-values') {
      const ref = collection.doc('value');
      const write = await ref.set({ large: 9007199254740993n, time: new Timestamp(1700000000, 123456789),
        bytes: Buffer.from([0, 255, 128, 7]) });
      check(write.writeTime instanceof Timestamp && write.writeTime.nanoseconds === 123456789, 'MATRIX_WRITE_RESULT');
      const document = await ref.get(); values(document);
      const query = await collection.where('large', '==', 9007199254740993n).limit(2).get();
      check(query.size === 1 && query.docs[0].id === 'value', 'MATRIX_QUERY_RESULT'); values(query.docs[0]);
      return { result: { documentRead: true, queryRows: 1, int64Exact: true, timestampExact: true,
        bytesExact: true, byteLength: 4, writeTimePreserved: true }, close: () => firestore.terminate() };
    }
    const events = []; let failure, rowCount = 0, errorCount = 0, endCount = 0, closeCount = 0, release;
    await new Promise((resolve, reject) => {
      const stream = collection.orderBy('large').limit(2).stream();
      stream.on('data', document => {
        try {
          rowCount++; values(document); events.push('data');
          release = fetch('https://sdk-control.fixture.invalid/release', { method: 'POST',
            headers: { 'x-wga-case': caseId } }).then(response => check(response.status === 204, 'MATRIX_RELEASE'));
          release.catch(reject);
        } catch (error) { reject(error); }
      });
      stream.on('error', error => { failure = error; errorCount++; events.push('error'); });
      stream.on('end', () => { endCount++; events.push('end'); });
      stream.on('close', () => { closeCount++; events.push('close'); resolve(); });
    });
    await release;
    check(rowCount === 1 && failure?.code === 7 && errorCount === 1 && endCount === 0 && closeCount === 1
      && JSON.stringify(events) === JSON.stringify(['data', 'error', 'close']), 'MATRIX_PARTIAL_STREAM_STATUS');
    const before = events.length;
    values(await collection.doc('marker').get());
    check(events.length === before, 'MATRIX_STREAM_NO_LATE_EVENTS');
    return { result: { partialRows: rowCount, errorCode: failure.code, errorCount, endCount, closeCount,
      terminalOrder: events, sameClientRecovery: true }, close: () => firestore.terminate() };
  } catch (error) { await firestore.terminate(); throw error; }
}
async function secretCase({ scenario, options, caseId, request, readers }) {
  const client = new SecretManagerServiceClient(options);
  const callOptions = { timeout: 1500, retry: null, otherArgs: { headers: { 'x-wga-case': caseId } } };
  async function access(name = secretVersion) {
    const [response] = await client.accessSecretVersion({ name }, callOptions);
    const bytes = response.payload?.data, expected = syntheticPayload(257);
    check(bytes instanceof Uint8Array && bytes.length === expected.length
      && bytes.every((byte, index) => byte === expected[index]), 'MATRIX_SECRET_BYTES');
    check(String(response.payload.dataCrc32c) === String(crc32c(bytes)), 'MATRIX_SECRET_CHECKSUM');
    // Never put payload bytes, their digest, or a raw SDK response in output.
    return { byteLength: bytes.length, exactBytes: true, checksumVerified: true };
  }
  try {
    let result;
    if (scenario === 'secret-access') result = await access();
    else if (scenario === 'secret-list') {
      const [secrets] = await client.listSecrets({ parent: secretParent, pageSize: 2 }, callOptions);
      check(secrets.length === 4 && secrets.every((secret, index) => secret.name === `${secretParent}/secrets/item-${index}`),
        'MATRIX_SECRET_PAGINATION');
      result = { itemCount: 4, orderedPages: true };
    } else if (scenario === 'secret-cancel') {
      const abort = new AbortController();
      const scopedRequest = new Request(request, { signal: abort.signal });
      const call = cancellableCall(scoped => client.accessSecretVersion({ name: secretVersion }, scoped),
        { signal: scopedRequest.signal, gaxOptions: callOptions });
      // The host acknowledges the actual RPC before the fixture cancels its
      // request signal. This exercises cancellation after lazy SDK startup.
      const observed = call.promise.then(() => ({ resolved: true }), error => ({ error }));
      const ready = await fetch('https://sdk-control.fixture.invalid/started', { method: 'POST',
        headers: { 'x-wga-case': caseId } });
      check(ready.status === 204, 'MATRIX_CANCEL_READY');
      for (let turn = 0; turn < 100 && !readers[0]?.body.locked; turn++) await new Promise(resolve => setTimeout(resolve, 5));
      check(readers.length === 1 && readers[0].body.locked, 'MATRIX_CANCEL_READER_STARTED');
      abort.abort();
      const terminal = await observed;
      check(terminal.error?.code === 1, 'MATRIX_REQUEST_CANCEL_STATUS');
      for (let turn = 0; turn < 100; turn++) {
        const reader = readers[0];
        if (reader.cancellationsStarted === 1 && reader.cancellationsCompleted === 1
          && reader.released && !reader.source.locked && !reader.body.locked) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const readerBeforePeerRelease = {
        cancellationsStarted: readers[0].cancellationsStarted, cancellationsCompleted: readers[0].cancellationsCompleted,
        released: readers[0].released, sourceLocked: readers[0].source.locked, bodyLocked: readers[0].body.locked,
      };
      check(readerBeforePeerRelease.cancellationsStarted === 1
        && readerBeforePeerRelease.cancellationsCompleted === 1
        && readerBeforePeerRelease.released && !readerBeforePeerRelease.sourceLocked
        && !readerBeforePeerRelease.bodyLocked, 'MATRIX_LOCAL_READER_CANCELLED');
      // Miniflare's Node outboundService is a separate boundary. Release its
      // withheld body only after native reader.cancel() fulfilled and both
      // local reader locks were released. A rejection can still release locks
      // through finally, but must never count as successful cancellation;
      // this does not establish cancellation of a deployed backend generator.
      const released = await fetch('https://sdk-control.fixture.invalid/release', { method: 'POST',
        headers: { 'x-wga-case': caseId } });
      check(released.status === 204, 'MATRIX_CANCEL_PEER_RELEASE');
      const recovered = await access(`${secretParent}/secrets/recovery/versions/latest`);
      result = { errorCode: 1, requestSignalAborted: scopedRequest.signal.aborted,
        sameClientRecovery: true, recoveryByteLength: recovered.byteLength,
        localReaderCancelledBeforePeerRelease: true, readerBeforePeerRelease, backendCancellationProven: false };
    } else {
      let failure, resolutions = 0, rejections = 0;
      try { await client.accessSecretVersion({ name: secretVersion }, callOptions); resolutions++; }
      catch (error) { failure = error; rejections++; }
      const code = scenario === 'secret-denied' ? 7 : 14;
      trailers(failure, code);
      check(resolutions === 0 && rejections === 1, 'MATRIX_SECRET_ONE_TERMINAL');
      result = { errorCode: code, detailsPreserved: true, repeatedTextTrailers: true,
        repeatedBinaryTrailers: true, resolutions, rejections };
    }
    return { result, close: () => client.close() };
  } catch (error) { await client.close(); throw error; }
}

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!scenarios.includes(scenario)) return new Response('Not found', { status: 404 });
    const caseId = `${env.PROFILE}/${env.MODE}/${scenario}`, events = [], fetchIntents = [], readers = [];
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: env.RUNTIME_TOKEN, expiry_date: Date.now() + 3600000 });
    const transport = createWorkersGrpcTransport({ observer: event => events.push(event),
      fetcher: { async fetch(input, init) {
        const intent = init.cf?.grpcWeb;
        check(intent === (env.MODE === 'cloudflare' ? 'convert' : 'passthrough')
          && init.redirect === 'manual', 'MATRIX_FETCH_CONVERSION_INTENT');
        fetchIntents.push(intent);
        const response = await fetch(input, init);
        if (!response.body) return response;
        const source = response.body, reader = source.getReader();
        const lifetime = { source, body: null, released: false, cancellationsStarted: 0, cancellationsCompleted: 0 };
        readers.push(lifetime);
        let finished = false;
        const release = () => { reader.releaseLock(); lifetime.released = true; };
        lifetime.body = new ReadableStream({
          async pull(controller) {
            try {
              const item = await reader.read();
              if (finished) return;
              if (item.done) { finished = true; release(); controller.close(); }
              else controller.enqueue(item.value);
            } catch (error) {
              if (finished) return;
              finished = true; release(); controller.error(error);
            }
          },
          async cancel(reason) {
            lifetime.cancellationsStarted++; finished = true;
            try {
              await reader.cancel(reason);
              lifetime.cancellationsCompleted++;
            } finally { release(); }
          },
        }, { highWaterMark: 0 });
        return new Response(lifetime.body, { status: response.status, headers: response.headers });
      } },
      ...(env.MODE === 'cloudflare' ? { mode: 'cloudflare' } : { mode: 'grpc-web', endpoints: {
        'firestore.googleapis.com': 'https://firestore.fixture.invalid',
        'secretmanager.googleapis.com': 'https://secret-manager.fixture.invalid',
      } }),
    });
    let close;
    try {
      const options = transport.gaxOptions({ projectId: 'wga-prebundle-fixture', authClient });
      const operation = await (scenario.startsWith('firestore-') ? firestoreCase : secretCase)(
        { scenario, options, caseId, request, readers });
      close = operation.close;
      const usage = await idle(transport, readers);
      const calls = events.filter(event => event.type === 'call-end').map(event => ({
        statusCode: event.statusCode, attemptCount: event.attemptCount, fetchCount: event.fetchCount,
        responseMessages: event.responseMessages,
      }));
      check(events.filter(event => event.type === 'call-start').length === calls.length
        && calls.every(call => call.attemptCount === 1 && call.fetchCount === 1), 'MATRIX_EXACT_CALL_LIFETIME');
      await close(); close = undefined;
      return Response.json({ status: 'passed', result: operation.result, calls, fetchIntents,
        responseReaders: readers.map(reader => ({ released: reader.released, sourceLocked: reader.source.locked,
          bodyLocked: reader.body.locked, cancellationsStarted: reader.cancellationsStarted,
          cancellationsCompleted: reader.cancellationsCompleted })),
        resourcesBeforeClose: { activeCalls: usage.activeCalls, queuedCalls: usage.queuedCalls, bufferedBytes: usage.bufferedBytes },
        clientClosed: true });
    } catch (error) {
      await close?.();
      const diagnostic = /^MATRIX_[A-Z_]+$/.test(error?.fixtureDiagnostic)
        ? error.fixtureDiagnostic : /^WGA_[A-Z_]+$/.test(error?.code) ? error.code : 'MATRIX_SDK_FAILURE';
      return Response.json({ status: 'failed', diagnostic,
        ...(Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16 ? { sdkErrorCode: error.code } : {}),
        ...(typeof error?.name === 'string' && /^[A-Za-z]+Error$/.test(error.name) ? { sdkErrorName: error.name } : {}),
      }, { status: 500 });
    }
  },
};
