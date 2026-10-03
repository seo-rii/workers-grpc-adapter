// Test-only instrumentation for the installed adapter. These internal hooks
// are not a supported SDK or adapter API. The business modules remain shared
// with native grpc-js; only the Fetch execution harness installs this tracker.
const active = new WeakSet();
const header = 'x-wga-sdk-call-id';
const zero = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
function check(condition, label) { if (!condition) throw new Error(`SDK_ACCOUNTING_${label}`); }

export function startSdkCallAccounting(grpc) {
  const prototype = grpc.Channel.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'createCallForMethod');
  check(typeof descriptor?.value === 'function', 'ADAPTER_REQUIRED');
  check(!active.has(prototype), 'ALREADY_TRACKING');
  active.add(prototype);
  const events = [], captured = new Map(), channels = new Set();
  let restored = false;
  function create(...args) {
    const call = descriptor.value.apply(this, args);
    // Read the actual observation ID; do not infer identity from timing or
    // aggregate request order. TypeScript-private fields are inspected only
    // in this fixture, alongside the existing internal diagnostics methods.
    const logicalCallId = call.observation?.id;
    check(typeof logicalCallId === 'string' && !captured.has(logicalCallId), 'OBSERVED_CALL_ID');
    const record = { call, channel: this, method: args[0], fetches: [] };
    captured.set(logicalCallId, record); channels.add(this);
    const start = call.start;
    call.start = function(metadata, listener) {
      const tagged = metadata.clone();
      tagged.set(header, logicalCallId);
      return start.call(this, tagged, listener);
    };
    return call;
  }
  Object.defineProperty(prototype, 'createCallForMethod', { ...descriptor, value: create });
  return {
    observer(event) { events.push(event); },
    wrapFetcher(forward) {
      check(typeof forward === 'function', 'FETCHER_REQUIRED');
      return async (input, init) => {
        const logicalCallId = new Headers(init?.headers).get(header);
        const record = captured.get(logicalCallId);
        check(record && !restored, 'FETCH_CALL_ID');
        const url = new URL(input);
        check(url.pathname === record.method && init.method === 'POST', 'FETCH_METHOD');
        record.fetches.push({ method: url.pathname });
        return forward(input, init);
      };
    },
    async snapshot(transport) {
      check(!restored, 'SNAPSHOT_BEFORE_RESTORE');
      for (let turn = 0; turn < 200; turn++) {
        const usage = transport.resourceUsage();
        if (usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0
          && [...captured.values()].every(({ call }) => Object.entries(zero).every(([key, value]) => call.executionDiagnostics()[key] === value))) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      // Observer delivery uses microtasks. Drain them before joining immutable
      // events to the captured call and its independently counted Fetches.
      await Promise.resolve();
      const usage = transport.resourceUsage();
      const resources = Object.fromEntries(['activeCalls', 'queuedCalls', 'bufferedBytes'].map(key => [key, usage[key]]));
      check(Object.values(resources).every(value => value === 0), 'RESOURCE_IDLE');
      check([...channels].every(channel => !channel.closed && channel.activeCallCount() === 0), 'CHANNEL_IDLE_BEFORE_CLOSE');
      check(events.every(event => captured.has(event.logicalCallId)), 'UNCAPTURED_OBSERVATION');
      const calls = [...captured].map(([logicalCallId, record]) => {
        const own = events.filter(event => event.logicalCallId === logicalCallId);
        const count = type => own.filter(event => event.type === type).length;
        const ends = own.filter(event => event.type === 'call-end');
        const diagnostics = record.call.diagnostics(), execution = record.call.executionDiagnostics();
        check(count('call-start') === 1 && ends.length === 1 && count('attempt-start') === 1
          && count('attempt-end') === 1 && count('auth-end') === 1 && count('fetch-start') === 1
          && ends[0].attemptCount === 1 && ends[0].fetchCount === 1 && record.fetches.length === 1, 'ONE_FETCH_PER_CALL');
        check(diagnostics.terminal && diagnostics.fetchCount === 1 && diagnostics.requestBytes === 0
          && diagnostics.responseBytes === 0 && diagnostics.timerActive === false, 'CALL_IDLE');
        check(Object.entries(zero).every(([key, value]) => execution[key] === value), 'OWNERS_RELEASED');
        return { logicalCallId, method: record.method, startCount: count('call-start'), terminalCount: ends.length,
          attemptCount: count('attempt-start'), fetchCount: record.fetches.length, fetchEventCount: count('fetch-start'),
          authCount: count('auth-end'), statusCode: ends[0].statusCode, responseMessages: ends[0].responseMessages,
          diagnostics, execution };
      });
      return { calls, resources, channelCount: channels.size,
        activeChannels: [...channels].filter(channel => channel.activeCallCount() > 0).length, beforeClose: true };
    },
    restore() {
      if (restored) return;
      check(prototype.createCallForMethod === create, 'HOOK_OWNERSHIP');
      Object.defineProperty(prototype, 'createCallForMethod', descriptor);
      active.delete(prototype); restored = true;
    },
  };
}
