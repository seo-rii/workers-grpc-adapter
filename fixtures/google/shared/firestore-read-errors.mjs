import { Firestore } from '@google-cloud/firestore';
import { PassThroughClient } from 'google-auth-library';

export const readScenarios = ['batch-permanent-partial', 'batch-transient-before', 'batch-transient-partial',
  'query-get-permanent-partial', 'query-get-transient-before', 'query-get-transient-partial',
  'query-stream-permanent-partial', 'query-stream-transient-before', 'query-stream-transient-partial', 'query-stream-destroy'];
export function readCheck(condition, diagnostic) {
  if (!condition) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic });
}
export function safeReadError(error) {
  return /^READ_[A-Z_]+$/.test(error?.fixtureDiagnostic) ? error.fixtureDiagnostic : 'READ_HARNESS_FAILURE';
}
export async function observeReadCalls(events, transport) {
  for (let turn = 0; turn < 100; turn++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    const usage = transport.resourceUsage();
    if (usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0) break;
  }
  const usage = transport.resourceUsage();
  readCheck(usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0, 'READ_RESOURCE_IDLE');
  const calls = [...new Set(events.map(event => event.logicalCallId))].map(logicalCallId => {
    const call = events.filter(event => event.logicalCallId === logicalCallId);
    const starts = call.filter(event => event.type === 'call-start');
    const ends = call.filter(event => event.type === 'call-end');
    const attempts = call.filter(event => event.type === 'attempt-start');
    const fetches = call.filter(event => event.type === 'fetch-start');
    readCheck(starts.length === 1 && ends.length === 1 && attempts.length === 1 && fetches.length === 1
      && ends[0].attemptCount === 1 && ends[0].fetchCount === 1, 'READ_OBSERVER_LIFETIME');
    return { logicalCallId, startCount: starts.length, terminalCount: ends.length,
      attemptCount: attempts.length, fetchCount: fetches.length, statusCode: ends[0].statusCode,
      responseMessages: ends[0].responseMessages };
  });
  return { calls, resources: { activeCalls: usage.activeCalls, queuedCalls: usage.queuedCalls, bufferedBytes: usage.bufferedBytes } };
}

// These exact bytes run against native grpc-js and both installed adapters.
// clientConfig bounds RPC deadlines without changing SDK retry classification.
export async function runFirestoreReadErrors({ options, scenario, caseId, beforeTerminate, advanceProgress }) {
  readCheck(readScenarios.includes(scenario), 'READ_KNOWN_SCENARIO');
  const firestore = new Firestore({ ...options, authClient: new PassThroughClient(), preferRest: false,
    customHeaders: { 'x-wga-case': caseId, 'x-wga-invocation': caseId },
    clientConfig: { interfaces: { 'google.firestore.v1.Firestore': { methods: {
      BatchGetDocuments: { timeout_millis: 1500 }, RunQuery: { timeout_millis: 1500 },
    } } } },
  });
  const partial = scenario.endsWith('partial');
  const progressTarget = scenario.startsWith('batch-') ? 2 : 1;
  let progressSnapshots = 0, progressAcknowledgements = 0, progressFailure = false;
  let acknowledgement;
  const originalSnapshot = firestore.snapshot_;
  // Pinned fixture instrumentation only: preserve the original implementation,
  // arguments and return value. Release peer errors after the current SDK stack
  // has committed partial progress, not after a wall-clock delay.
  firestore.snapshot_ = function (...args) {
    const result = originalSnapshot.apply(this, args);
    const name = typeof args[0] === 'string' ? args[0] : args[0]?.name;
    if (partial && !acknowledgement && (name?.endsWith('/a') || scenario.startsWith('batch-') && name?.endsWith('/b'))) {
      progressSnapshots++;
      if (progressSnapshots === progressTarget) {
        acknowledgement = Promise.resolve().then(() => advanceProgress()).then(() => { progressAcknowledgements++; }, () => { progressFailure = true; });
      }
    }
    return result;
  };
  const collection = firestore.collection('wga_read_errors');
  const events = [], rows = [];
  let resolved = 0, rejected = 0, errorCode = null, streamErrorCount = 0, streamEndCount = 0, streamCloseCount = 0;
  const normalize = document => ({ id: document.id, exists: document.exists,
    value: document.exists ? document.get('value') : null });
  try {
    if (scenario.startsWith('query-stream')) {
      await new Promise(resolve => {
        const stream = collection.orderBy('value').limit(3).stream();
        stream.on('data', document => {
          rows.push(normalize(document)); events.push(`data:${document.id}`);
          if (scenario === 'query-stream-destroy') stream.destroy();
        });
        stream.on('error', error => { streamErrorCount++; errorCode = error.code; events.push(`error:${error.code}`); });
        stream.on('end', () => { streamEndCount++; events.push('end'); });
        stream.on('close', () => { streamCloseCount++; events.push('close'); resolve(); });
      });
    } else {
      try {
        const result = scenario.startsWith('batch-')
          ? await firestore.getAll(collection.doc('b'), collection.doc('a'), collection.doc('c'))
          : (await collection.orderBy('value').limit(3).get()).docs;
        resolved++; events.push('resolve'); rows.push(...result.map(normalize));
      } catch (error) { rejected++; errorCode = error.code; events.push(`reject:${error.code}`); }
    }
    const permanent = scenario.includes('permanent'), destroyed = scenario === 'query-stream-destroy';
    readCheck(errorCode === (permanent ? 7 : null), 'READ_APPLICATION_STATUS');
    const expected = destroyed ? [{ id: 'a', exists: true, value: 1 }] : permanent ? scenario.startsWith('query-stream') ? [{ id: 'a', exists: true, value: 1 }] : []
      : scenario.startsWith('batch-') ? [{ id: 'b', exists: true, value: 2 }, { id: 'a', exists: false, value: null }, { id: 'c', exists: true, value: 3 }]
        : ['a', 'b', 'c'].map((id, index) => ({ id, exists: true, value: index + 1 }));
    readCheck(JSON.stringify(rows) === JSON.stringify(expected), 'READ_EXACT_DOCUMENTS');
    if (scenario.startsWith('query-stream')) {
      readCheck(streamCloseCount === 1 && streamEndCount === (permanent || destroyed ? 0 : 1)
        && streamErrorCount === (permanent ? 1 : 0), 'READ_STREAM_TERMINAL_COUNTS');
      const expectedEvents = destroyed ? ['data:a', 'close'] : permanent ? ['data:a', 'error:7', 'close'] : ['data:a', 'data:b', 'data:c', 'end', 'close'];
      readCheck(JSON.stringify(events) === JSON.stringify(expectedEvents), 'READ_STREAM_EVENT_ORDER');
    } else readCheck(resolved === (permanent ? 0 : 1) && rejected === (permanent ? 1 : 0), 'READ_PROMISE_TERMINAL_COUNTS');
    await acknowledgement;
    readCheck(!progressFailure && progressSnapshots === (partial ? progressTarget : 0)
      && progressAcknowledgements === (partial ? 1 : 0), 'READ_PROGRESS_ACKNOWLEDGED');
    const before = JSON.stringify({ events, resolved, rejected, streamErrorCount, streamEndCount, streamCloseCount });
    const marker = await collection.doc('marker').get();
    readCheck(marker.exists && marker.get('value') === 99, 'READ_SAME_CLIENT_RECOVERY');
    if (destroyed) await advanceProgress();
    await new Promise(resolve => setTimeout(resolve, 0));
    readCheck(JSON.stringify({ events, resolved, rejected, streamErrorCount, streamEndCount, streamCloseCount }) === before,
      'READ_NO_LATE_APPLICATION_EVENTS');
    return { scenario, rows, events, resolved, rejected, errorCode, streamErrorCount, streamEndCount, streamCloseCount,
      sameClientRecovery: true, noLateEvents: true, progressSnapshots, progressAcknowledgements,
      ...(destroyed ? { destroyRetainedUntilRelease: true } : {}) };
  } finally {
    try { await beforeTerminate?.(); }
    finally { await firestore.terminate(); }
  }
}
