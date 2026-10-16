import { Hono } from 'hono';
import { Datastore, OAuth2Client, createWorkersGrpcTransport, cancellableCall } from '../generated/google-workers/index.mjs';

type Usage = ReturnType<ReturnType<typeof createWorkersGrpcTransport>['resourceUsage']>;
type Receipt = { id: string; trace: string[]; finished: boolean; incomingAborted: boolean;
  terminalStatuses: number[]; code?: number; resources?: Usage; closedClients: number;
  resourcesBeforeClose?: Usage; closedClientsAtIdle?: number; backendReaderCancelledBeforeClose?: boolean; cleanupFailure?: string };
type Environment = { Bindings: { WGA_FIXTURE_TOKEN: string; WGA_FIXTURE_CONTROL: string; WGA_FIXTURE_PEER: string;
  WGA_FIXTURE_NETWORK: { fetch: typeof fetch } };
  Variables: { trace: string[] } };
const receipts = new Map<string, Receipt>();
const app = new Hono<Environment>();
function check(condition: unknown, diagnostic: string): asserts condition {
  if (!condition) throw new Error(diagnostic);
}

app.use('*', async (context, next) => {
  if (!context.env.WGA_FIXTURE_TOKEN || !context.env.WGA_FIXTURE_CONTROL
    || !/^https:\/\/127\.0\.0\.1:[0-9]+$/.test(context.env.WGA_FIXTURE_PEER)
    || context.req.header('x-fixture-control') !== context.env.WGA_FIXTURE_CONTROL) return context.notFound();
  const trace = ['before'];
  context.set('trace', trace);
  await next();
  trace.push('after');
  context.header('x-hono-middleware', trace.join(','));
});
app.get('/health', context => context.json({ status: 'ready' }));
app.get('/control/:id', context => {
  const receipt = receipts.get(context.req.param('id'));
  return receipt ? context.json(receipt) : context.json({ status: 'missing' }, 404);
});
app.get('/probe/:scenario', async context => {
  const scenario = context.req.param('scenario');
  const id = context.req.header('x-fixture-id');
  if (!['success', 'denied', 'cancel'].includes(scenario) || !id || !/^[a-z-]{1,24}$/.test(id)
    || receipts.has(id) || receipts.size >= 8) return context.json({ status: 'invalid' }, 400);
  const receipt: Receipt = { id, trace: context.get('trace'), finished: false, incomingAborted: false,
    terminalStatuses: [], closedClients: 0 };
  receipt.trace.push('route');
  receipts.set(id, receipt);
  const incoming = context.req.raw.signal;
  const aborted = () => { receipt.incomingAborted = true; };
  incoming.addEventListener('abort', aborted, { once: true });
  const transport = createWorkersGrpcTransport({ mode: 'grpc-web',
    endpoints: { 'datastore.googleapis.com': context.env.WGA_FIXTURE_PEER },
    fetcher: context.env.WGA_FIXTURE_NETWORK,
    defaultTimeoutMs: 5000,
    observer: event => { if (event.type === 'call-end') receipt.terminalStatuses.push(event.statusCode); } });
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: context.env.WGA_FIXTURE_TOKEN });
  const datastore = new Datastore(transport.gaxOptions({ projectId: 'wga-hono-fixture', namespace: id, authClient }));
  const key = datastore.key(['FixtureRoot', 'parent', 'FixtureValue', datastore.int('9007199254740993')]);
  const task = (async () => {
    try {
      const result = await cancellableCall(async gaxOptions => {
        const options = { gaxOptions };
        if (scenario === 'cancel') {
          // The controlled peer holds this real Lookup response until the
          // incoming client disconnects. No timer or test endpoint cancels it.
          await datastore.get(key, options);
          throw new Error('HONO_CANCEL_NOT_OBSERVED');
        }
        await datastore.save({ key, data: { count: 1, label: id } }, gaxOptions);
        const [entity] = await datastore.get(key, options);
        check(entity?.count === 1 && entity.label === id, 'HONO_LOOKUP');
        const entityKey = entity[Datastore.KEY];
        check(entityKey.id === '9007199254740993' && entityKey.parent?.name === 'parent', 'HONO_KEY_SYMBOL');
        const [rows] = await datastore.runQuery(datastore.createQuery('FixtureValue').limit(2), options);
        check(rows.length === 1 && rows[0][Datastore.KEY].id === entityKey.id, 'HONO_QUERY_KEY');
        const transaction = datastore.transaction();
        await transaction.run(options);
        const [before] = await transaction.get(key, options);
        check(before.count === 1, 'HONO_TRANSACTION_READ');
        transaction.save({ key, data: { count: 2, label: id } });
        const [commit] = await transaction.commit(gaxOptions);
        const [after] = await datastore.get(key, options);
        check(after.count === 2 && commit.mutationResults?.length === 1, 'HONO_TRANSACTION_COMMIT');
        return { key: { id: entityKey.id, parent: entityKey.parent.name, namespace: entityKey.namespace },
          queryRows: rows.length, count: after.count, commitMutations: commit.mutationResults.length };
      }, { signal: incoming, gaxOptions: { timeout: 5000, retry: null } }).promise;
      return { status: 'passed', ...result };
    } catch (error) {
      const failure = error as { code?: number; metadata?: { get(key: string): unknown[] }; message?: string };
      receipt.code = failure.code;
      return { status: 'failed', code: failure.code ?? null, trailingStatus: failure.metadata?.get('x-fixture-status') || [],
        diagnostic: failure.message?.startsWith('HONO_') ? failure.message : undefined };
    } finally {
      incoming.removeEventListener('abort', aborted);
      try {
        for (let i = 0; i < 50; i++) {
          const usage = transport.resourceUsage();
          if (usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        receipt.resourcesBeforeClose = transport.resourceUsage();
        check(receipt.resourcesBeforeClose.activeCalls === 0 && receipt.resourcesBeforeClose.queuedCalls === 0
          && receipt.resourcesBeforeClose.bufferedBytes === 0, 'HONO_PRE_CLOSE_IDLE');
        receipt.closedClientsAtIdle = receipt.closedClients;
        if (scenario === 'cancel') {
          const acknowledgementDeadline = Date.now() + 750;
          for (let i = 0; i < 50 && Date.now() < acknowledgementDeadline; i++) {
            const response = await context.env.WGA_FIXTURE_NETWORK.fetch(context.env.WGA_FIXTURE_PEER + '/__control/cancel', {
              headers: { 'x-fixture-control': context.env.WGA_FIXTURE_CONTROL },
              signal: AbortSignal.timeout(Math.max(1, Math.min(250, acknowledgementDeadline - Date.now()))),
            });
            const state = await response.json() as { activeHeld: number; readerCancelled: boolean; socketDisconnected: boolean };
            if (state.activeHeld === 0 && state.readerCancelled && state.socketDisconnected) { receipt.backendReaderCancelledBeforeClose = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          check(receipt.backendReaderCancelledBeforeClose, 'HONO_PRE_CLOSE_READER_CANCELLED');
        }
      } catch (error) {
        receipt.cleanupFailure = error instanceof Error && error.message.startsWith('HONO_') ? error.message : 'HONO_PRE_CLOSE_CLEANUP';
      }
      // The pinned SDK has no aggregate close(). This test-only private cleanup
      // closes the generated clients without retaining request I/O globally.
      const clients = (datastore as unknown as { clients_: Map<string, { close(): Promise<void> }> }).clients_;
      for (const client of clients.values()) { await client.close(); receipt.closedClients++; }
      receipt.resources = transport.resourceUsage();
      receipt.finished = true;
    }
  })();
  // Keep bounded cancellation cleanup observable after the HTTP client leaves.
  // This is an invocation lifetime extension, not a durable background job.
  context.executionCtx.waitUntil(task.then(() => {}));
  if (scenario === 'cancel') {
    // Return headers before the client disconnects, as in Cloudflare's
    // documented Request.signal streaming-response cancellation pattern.
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    return context.body(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('ready\n'));
        heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode('ping\n')); }
          catch { clearInterval(heartbeat); }
        }, 10);
        task.then(value => {
          clearInterval(heartbeat);
          try { controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); controller.close(); }
          catch { /* The client already cancelled the response body. */ }
        }, () => {
          clearInterval(heartbeat);
          try { controller.error(new Error('HONO_TASK_FAILURE')); } catch { /* Already closed. */ }
        });
      },
      cancel() { clearInterval(heartbeat); },
    }), 200, { 'content-type': 'application/x-ndjson' });
  }
  const result = await task;
  return context.json({ ...result, terminalStatuses: receipt.terminalStatuses, resources: receipt.resources,
    resourcesBeforeClose: receipt.resourcesBeforeClose, closedClientsAtIdle: receipt.closedClientsAtIdle, cleanupFailure: receipt.cleanupFailure },
    result.status === 'passed' ? 200 : 502);
});

export default app;
