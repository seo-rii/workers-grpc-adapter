import { Datastore } from '@google-cloud/datastore';
import { PassThroughClient } from 'google-auth-library';
export const mutationScenarios = ['save-promise', 'save-callback', 'batch-save', 'batch-error-promise', 'batch-error-callback',
  'insert-existing', 'insert-missing', 'upsert-existing', 'upsert-missing', 'update-existing', 'update-missing',
  'incomplete-key', 'delete-existing', 'delete-missing', 'delete-batch', 'delete-error-promise', 'delete-error-callback', 'allocate-ids'];
function check(condition, message) { if (!condition) throw new Error(`MUTATION_${message}`); }
function keySummary(key) { return { kind: key.kind, ...(key.id ? { id: key.id } : key.name ? { name: key.name } : {}) }; }
function entitySummary(entity) {
  if (!entity) return null;
  if (entity.label === 'before') return { key: keySummary(entity[Datastore.KEY]), label: 'before' };
  check(Buffer.isBuffer(entity.blob) && entity.when instanceof Date && Datastore.isInt(entity.count)
    && Datastore.isInt(entity.list[0]), 'DECODED_RUNTIME_TYPES');
  return { key: keySummary(entity[Datastore.KEY]), label: entity.label, count: String(entity.count.value),
    when: entity.when.toISOString(), blob: entity.blob.toString('hex'), enabled: entity.enabled, nothing: entity.nothing,
    ratio: entity.ratio, nested: entity.nested, list: entity.list.map(item => item?.value !== undefined ? { integer: String(item.value) } : item) };
}
function typed(label) { return { label, count: Datastore.int('9007199254740993'), when: new Date('2026-01-02T03:04:05.000Z'),
  blob: Buffer.from([0, 1, 127, 255]), enabled: true, nothing: null, ratio: Datastore.double(1.25), nested: { label: 'child' }, list: [1, 'two', false] }; }
export async function runDatastoreMutations({ options, namespace, scenario, beforeClose }) {
  check(mutationScenarios.includes(scenario), 'SCENARIO');
  const datastore = new Datastore({ ...options, authClient: new PassThroughClient(), databaseId: 'mutation-db', namespace,
    clientConfig: { interfaces: { 'google.datastore.v1.Datastore': { methods: Object.fromEntries(
      ['Commit', 'Lookup', 'AllocateIds'].map(name => [name, { timeout_millis: 2000, retry_codes: [] }])) } } } });
  const key = name => datastore.key(['MutationValue', ...(name === undefined ? [] : [name])]);
  const gax = { timeout: 2000, retry: null };
  const readOptions = { wrapNumbers: true, consistency: 'strong', gaxOptions: gax };
  const result = { scenario, responses: [], error: null, rows: [], callback: null, allocatedIds: [], reused: false };
  function responseSummary(response, tupleLength) { return { tupleLength, mutationCount: response.mutationResults.length,
    versions: response.mutationResults.map(item => String(item.version)), indexUpdates: response.indexUpdates,
    assignedIds: response.mutationResults.map(item => item.key ? String(item.key.path.at(-1).id) : null) }; }
  function errorSummary(error) { return { code: error.code, details: error.details,
    text: error.metadata.get('x-mutation-error'), binary: error.metadata.get('x-mutation-error-bin').map(value => value.toString('hex')) }; }
  async function operation(method, argument, callback = false) {
    if (callback) {
      await new Promise(resolve => {
        let calls = 0;
        datastore[method](argument, gax, (...args) => {
          calls++;
          if (method === 'delete') check(args.length === 4 && args[2] === undefined && args[3] === undefined, 'DELETE_CALLBACK_TAIL');
          result.callback = { calls, arity: args.length, errorPosition: args[0] ? 0 : null };
          if (args[0]) result.error = errorSummary(args[0]);
          else result.responses.push(responseSummary(args[1], null));
          resolve();
        });
      });
    } else {
      try {
        // insert/upsert/update expose only entity and callback, unlike save.
        const tuple = await (['insert', 'upsert', 'update'].includes(method) ? datastore[method](argument) : datastore[method](argument, gax));
        if (method === 'delete') check(tuple.length === 3 && tuple[1] === undefined && tuple[2] === undefined, 'DELETE_PROMISE_TAIL');
        result.responses.push(responseSummary(tuple[0], tuple.length));
      } catch (error) { result.error = errorSummary(error); }
    }
  }
  try {
    let keys;
    if (scenario === 'allocate-ids') {
      const incomplete = key();
      const tuple = await datastore.allocateIds(incomplete, { allocations: 3, gaxOptions: gax });
      check(tuple.length === 2 && tuple[1].keys.length === 3, 'ALLOCATE_TUPLE');
      result.allocationTupleLength = tuple.length;
      result.incompleteUnchanged = incomplete.id === undefined;
      result.highLevelReserveAvailable = typeof datastore.reserveIds === 'function';
      result.allocatedIds = tuple[0].map(item => item.id);
      keys = tuple[0];
      await operation('save', keys.map((item, index) => ({ key: item, data: typed(`allocated-${index}`) })));
    } else if (scenario === 'incomplete-key') {
      const incomplete = key();
      check(incomplete.id === undefined, 'INCOMPLETE_BEFORE');
      const entity = { key: incomplete, data: typed('assigned') };
      await operation('save', entity);
      check(entity.key === incomplete && incomplete.id !== undefined, 'ASSIGNED_ORIGINAL_KEY');
      result.allocatedIds = [incomplete.id]; result.originalKeyUpdated = true;
      keys = [incomplete];
    } else if (scenario.startsWith('delete-')) {
      keys = scenario === 'delete-batch' ? [key('existing'), key('missing'), key('other')]
        : [key(scenario === 'delete-missing' ? 'missing' : 'existing')];
      await operation('delete', scenario === 'delete-batch' ? keys : keys[0], scenario.endsWith('callback'));
    } else {
      const batch = scenario.startsWith('batch-');
      keys = (batch ? ['third', 'first', 'second'] : [scenario.includes('existing') ? 'existing' : scenario.includes('missing') ? 'missing' : 'single']).map(key);
      const entities = keys.map(item => ({ key: item, data: typed(item.name) }));
      const method = /^(insert|upsert|update)-/.test(scenario) ? scenario.split('-')[0] : 'save';
      await operation(method, batch ? entities : entities[0], scenario.endsWith('callback'));
    }
    const tuple = await datastore.get(keys, readOptions);
    check(tuple.length === 1 && Array.isArray(tuple[0]), 'GET_TUPLE');
    result.rows = tuple[0].map(entitySummary);
    const [marker] = await datastore.get(datastore.key(['MutationMarker', 'alive']), readOptions);
    check(marker.alive === true, 'SAME_CLIENT_RECOVERY'); result.reused = true;
    const snapshot = JSON.stringify(result); await new Promise(resolve => setTimeout(resolve, 0));
    check(snapshot === JSON.stringify(result), 'NO_LATE_CALLBACK');
    return result;
  } finally {
    try { await beforeClose?.(); }
    finally { await Promise.all([...datastore.clients_.values()].map(client => client.close())); }
  }
}
