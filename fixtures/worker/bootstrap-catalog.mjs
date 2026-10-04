import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { registry, schemas, gaxCopies, sdk, applicationProtobuf, loader, loaderProtobuf, profileId } from 'wga:bootstrap-inputs';
import { probeApplicationProtobuf } from './bootstrap-app-probe.mjs';

const firstMethods = ['fromObject', 'toObject', 'encode', 'decode'];
const appMethods = [applicationProtobuf.Root.fromJSON, applicationProtobuf.Type.prototype.setup,
  applicationProtobuf.Type.prototype.fromObject, applicationProtobuf.Type.generateConstructor];
// One isolate-wide verification hook observes actual adapter Call objects. It
// never replaces SDK codecs/stubs, and concurrent requests never install or
// restore competing hooks. Tagging a cloned Metadata ties each Fetch to its
// originating Call instead of inferring identity from completion order.
const capturedCalls = new Map(), originalCreateCall = grpc.Channel.prototype.createCallForMethod;
grpc.Channel.prototype.createCallForMethod = function (...args) {
  const call = originalCreateCall.apply(this, args), id = call.observation?.id;
  check(typeof id === 'string' && !capturedCalls.has(id), 'ACTUAL_CALL_ID');
  capturedCalls.set(id, { call, channel: this, method: args[0] });
  const start = call.start;
  call.start = function (metadata, listener) {
    const tagged = metadata.clone(); tagged.set('x-wga-bootstrap-call-id', id);
    return start.call(this, tagged, listener);
  };
  return call;
};
let isolateId, requestCount = 0, activeRequests = 0, peakRequests = 0, auditStage;
function check(value, label) { if (!value) throw new Error(`BOOTSTRAP_${label}`); }
function canonical(value) {
  if (value instanceof Uint8Array) return { bytes: Array.from(value) };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function equal(actual, expected, label) {
  const a = JSON.stringify(canonical(actual)), b = JSON.stringify(canonical(expected));
  check(a === b, `${label}: actual=${a?.slice(0, 1200)} expected=${b?.slice(0, 1200)}`);
}
function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex'); }
const options = () => gaxCopies[0].gax.GrpcClient.defaultOptions();

function auditCodecs() {
  const calibration = {};
  // Positive controls test the runtime restriction without replacing Function,
  // eval, protobuf prototypes, SDK stubs, or generated serializer methods.
  for (const [name, generate] of [['Function', () => Function('return 17')()], ['eval', () => globalThis.eval('17')]]) {
    try { generate(); calibration[name] = 'unexpected-success'; }
    catch (error) { calibration[name] = error.name; }
    check(calibration[name] === 'EvalError', `CODEGEN_RESTRICTION_${name}`);
  }
  const results = [];
  for (const schema of schemas) {
    const { P, json, types } = schema;
    const first = Object.fromEntries(firstMethods.map(method => [method, []]));
    // Each type/entrypoint gets an untouched root. No earlier entrypoint or
    // nested codec can warm that type before its selected first call.
    for (const method of firstMethods) for (const item of types) {
      auditStage = `${schema.path}:${item.name}:first:${method}`;
      const root = registry.fromJSON(P, json), type = root.lookupType(item.name);
      check(Object.hasOwn(type, method), `STATIC_FIRST_${method}_${item.name}`);
      let value;
      if (method === 'fromObject') value = type.fromObject(item.input);
      else if (method === 'toObject') value = type.toObject(item.message, options());
      else if (method === 'encode') value = type.encode(item.message).finish();
      else value = type.decode(Buffer.from(item.wire, 'base64'));
      if (method === 'encode') equal(Array.from(value), Array.from(Buffer.from(item.wire, 'base64')), `FIRST_WIRE_${item.name}`);
      else if (method === 'toObject') equal(value, item.object, `FIRST_OBJECT_${item.name}`);
      else equal(type.toObject(value, options()), item.object, `FIRST_CONVERSION_${method}_${item.name}`);
      first[method].push(item.name);
    }
    const root = registry.fromJSON(P, json), reflected = [];
    for (const item of types) {
      auditStage = `${schema.path}:${item.name}:reflection`;
      const type = root.lookupType(item.name), ctor = type.ctor;
      check(typeof ctor === 'function' && type.ctor === ctor, 'CTOR_BEFORE_CODECS');
      const ownCodecs = ['fromObject', 'toObject', 'encode', 'decode', 'verify'].map(name => type[name]);
      const created = type.create(item.message), message = type.fromObject(item.input);
      check(created instanceof ctor && message instanceof ctor && type.verify(message) === null, `CTOR_VERIFY_${item.name}`);
      const wire = type.encode(message).finish(), delimited = type.encodeDelimited(message).finish();
      equal(type.toObject(type.decode(wire), options()), item.object, `ORDERED_CODEC_${item.name}`);
      equal(type.toObject(type.decodeDelimited(delimited), options()), item.object, `DELIMITED_${item.name}`);
      check(root.lookup(item.name) === type && root.lookupTypeOrEnum(item.name) === type, 'LOOKUP_IDENTITY');
      check(type.parent.get(type.name) === type && type.resolve() === type && type.resolveAll() === type, 'RESOLVE_IDENTITY');
      for (const field of type.fieldsArray) check(type.fieldsById[field.id] === field && type.get(field.name) === field && field.resolve() === field, 'FIELD_REFLECTION');
      for (const oneof of type.oneofsArray) check(type.get(oneof.name) === oneof && oneof.resolve() === oneof, 'ONEOF_REFLECTION');
      equal(type.toJSON(), item.reflection, `REFLECTION_JSON_${item.name}`);
      check(ownCodecs.every((fn, index) => fn === type[['fromObject', 'toObject', 'encode', 'decode', 'verify'][index]]), 'NO_LAZY_CODEC_REPLACEMENT');
      reflected.push(item.name);
    }
    const namespaces = schema.namespaces.map(item => {
      auditStage = `${schema.path}:${item.name}:namespace`;
      const reflected = item.kind === 'enum' ? root.lookupEnum(item.name) : root.lookupService(item.name);
      if (item.kind === 'enum') {
        equal(reflected.parent.getEnum(reflected.name), reflected.values, 'ENUM_VALUES');
        for (const value of Object.values(reflected.values)) check(typeof reflected.valuesById[value] === 'string', 'ENUM_REFLECTION');
      } else {
        for (const method of reflected.methodsArray) check(reflected.get(method.name) === method && method.resolve() === method, 'SERVICE_METHOD_REFLECTION');
      }
      equal(reflected.toJSON(), item.json, 'NAMESPACE_REFLECTION_JSON');
      return { name: item.name, kind: item.kind, jsonSha256: hash(reflected.toJSON()) };
    });
    // A schema's build-time generator dependency can differ from the protobuf
    // copy actually used by @grpc/proto-loader. Nested messages are not loader
    // exports, so compare them through the loader's own runtime copy too.
    const definition = loader.fromJSON(json, options()), matrixRoot = registry.fromJSON(loaderProtobuf, json), matrix = [];
    for (const item of types) for (const variant of item.variants) {
      auditStage = `${schema.path}:${item.name}:matrix:${variant.label}`;
      const def = definition[item.name.slice(1)], type = matrixRoot.lookupType(item.name);
      check(variant.oracle === (def ? 'native-proto-loader' : 'native-protobuf-reflection'), 'REAL_LOADER_EXPORT_SURFACE');
      const bytes = def ? def.serialize(variant.input) : type.encode(type.fromObject(variant.input)).finish();
      const decoded = def ? def.deserialize(bytes) : type.toObject(type.decode(bytes), options());
      equal(Array.from(bytes), Array.from(Buffer.from(variant.wire, 'base64')), `LOADER_BYTES_${item.name}_${variant.label}`);
      equal(decoded, variant.object, `LOADER_OPTIONS_${item.name}_${variant.label}`);
      matrix.push({ type: item.name, label: variant.label, oracle: variant.oracle, wireSha256: hash(bytes), objectSha256: hash(decoded) });
    }
    results.push({ path: schema.path, typeNames: types.map(item => item.name), first, reflected,
      matrix, namespaces, methods: ['ctor', 'create', 'verify', 'fromObject', 'toObject', 'encode', 'decode', 'encodeDelimited',
        'decodeDelimited', 'lookup', 'lookupType', 'lookupTypeOrEnum', 'lookupEnum', 'lookupService', 'getEnum', 'get',
        'fieldsArray', 'fieldsById', 'oneofsArray', 'resolve', 'resolveAll', 'toJSON'] });
  }
  return { calibration, schemas: results };
}

function auth(token) {
  const client = new sdk.auth.OAuth2Client();
  client.setCredentials({ access_token: token, expiry_date: Date.now() + 3600000 });
  return client;
}
function transportFor(token) {
  const events = [], fetches = [];
  const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: {
    'datastore.googleapis.com': 'https://bootstrap-peer.invalid',
    'firestore.googleapis.com': 'https://bootstrap-peer.invalid',
    'secretmanager.googleapis.com': 'https://bootstrap-peer.invalid',
    'bootstrap.googleapis.com': 'https://bootstrap-peer.invalid',
  }, observer: event => events.push(event), fetcher: { fetch: (url, init) => {
    const headers = new Headers(init.headers);
    check(headers.get('authorization') === `Bearer ${token}`, 'REQUEST_AUTH_ISOLATED');
    const logicalCallId = headers.get('x-wga-bootstrap-call-id'), record = capturedCalls.get(logicalCallId), method = new URL(url).pathname;
    check(record?.method === method, 'FETCH_ACTUAL_CALL_ID');
    fetches.push({ logicalCallId, method, contentType: headers.get('content-type'), tokenSha256: hash(token) });
    return fetch(url, init);
  } } });
  return { transport, events, fetches };
}
async function accounting(state) {
  for (let index = 0; index < 100; index++) {
    const usage = state.transport.resourceUsage();
    if (usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0) break;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await Promise.resolve();
  const usage = state.transport.resourceUsage();
  const resources = Object.fromEntries(['activeCalls', 'queuedCalls', 'bufferedBytes'].map(key => [key, usage[key]]));
  equal(resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }, 'IDLE_BEFORE_CLOSE');
  const calls = state.events.filter(event => event.type === 'call-start').map(start => {
    const record = capturedCalls.get(start.logicalCallId);
    check(record && !record.channel.closed && record.channel.activeCallCount() === 0, 'CHANNEL_IDLE_BEFORE_CLOSE');
    const events = state.events.filter(event => event.logicalCallId === start.logicalCallId);
    const count = name => events.filter(event => event.type === name).length;
    const end = events.find(event => event.type === 'call-end');
    check(count('call-start') === 1 && count('call-end') === 1 && count('auth-end') === 1 && count('fetch-start') === 1
      && end.statusCode === 0 && end.fetchCount === 1, 'ONE_CALL_LIFECYCLE');
    const diagnostics = record.call.diagnostics(), execution = record.call.executionDiagnostics();
    check(diagnostics.terminal && diagnostics.fetchCount === 1 && diagnostics.requestBytes === 0 && diagnostics.responseBytes === 0
      && diagnostics.timerActive === false && Object.values(execution).every(value => value === 0), 'CALL_EXECUTION_RELEASED');
    check(state.fetches.filter(fetch => fetch.logicalCallId === start.logicalCallId).length === 1, 'ONE_ACTUAL_FETCH_PER_CALL');
    capturedCalls.delete(start.logicalCallId);
    return { logicalCallId: start.logicalCallId, method: record.method, start: 1, terminal: 1, auth: 1, fetch: 1, status: end.statusCode,
      diagnostics, execution };
  });
  check(calls.length === state.fetches.length, 'ACTUAL_FETCH_COUNT');
  return { calls, fetches: state.fetches, resources, beforeClose: true };
}
async function closure() {
  const token = 'closure', state = transportFor(token), clients = [], rows = [];
  const base = state.transport.gaxOptions({ projectId: 'bootstrap-project', authClient: auth(token) });
  try {
    const datastore = new sdk.datastore.Datastore(base), secret = new sdk.secret.SecretManagerServiceClient(base);
    const data = new sdk.datastore.v1.DatastoreClient(base), admin = new sdk.datastore.v1.DatastoreAdminClient(base);
    const firestore = new sdk.firestore.Firestore({ ...base, preferRest: false });
    clients.push(secret, data, admin);
    for (const [name, client] of [['datastore', data], ['datastore-admin', admin], ['secret-manager', secret]]) {
      const first = client.initialize(), second = client.initialize();
      check(first === second, 'INITIALIZE_MEMOIZED');
      const stub = await first;
      check(typeof stub.getChannel === 'function' && client._gaxGrpc.fallback === false, 'REAL_GRPC_STUB');
      rows.push({ name, initialized: true, memoized: true, grpcStub: true });
    }
    check(datastore instanceof sdk.datastore.Datastore && firestore instanceof sdk.firestore.Firestore, 'HIGH_LEVEL_CONSTRUCTORS');
    const documents = await firestore.getAll(firestore.doc('bootstrap/closure'));
    check(documents.length === 1 && documents[0].exists === false, 'FIRESTORE_LAZY_INITIALIZE');
    for (const copy of gaxCopies) {
      const opts = { ...base, servicePath: 'bootstrap.googleapis.com', apiEndpoint: 'bootstrap.googleapis.com', port: 443 };
      const gaxGrpc = new copy.gax.GrpcClient(opts);
      const operations = copy.gax.lro(opts).operationsClient(opts);
      const locations = new copy.gax.LocationsClient(gaxGrpc, opts), iam = new copy.IamClient(gaxGrpc, opts);
      clients.push(locations, iam);
      const operationStub = await operations.operationsStub;
      const locationPromise = locations.initialize(), iamPromise = iam.initialize();
      check(locationPromise === locations.initialize() && iamPromise === iam.initialize(), 'COMMON_LAZY_MEMOIZED');
      const stubs = await Promise.all([locationPromise, iamPromise]);
      check([operationStub, ...stubs].every(stub => typeof stub.getChannel === 'function'), 'COMMON_REAL_STUBS');
      const callOptions = { retry: null, timeout: 10000 };
      const [operation] = await operations.getOperation({ name: `operations/${copy.name}` }, callOptions);
      const [location] = await locations.getLocation({ name: `projects/bootstrap-project/locations/${copy.name}` }, callOptions);
      const [policy] = await iam.getIamPolicy({ resource: `projects/bootstrap-project/${copy.name}` }, callOptions);
      check(operation.name === `operations/${copy.name}` && operation.done === true, 'OPERATIONS_ROUNDTRIP');
      check(location.locationId === copy.name && policy.version === 3 && policy.bindings[0].role === `roles/${copy.name}`, 'COMMON_ROUNDTRIP');
      const decoder = new copy.GoogleErrorDecoder();
      const decodedStatus = decoder.decodeRpcStatus(Buffer.from(copy.statusWire, 'base64'));
      check(decodedStatus.code === 7 && decodedStatus.message === 'bootstrap-status', 'COMMON_STATUS_DECODE');
      rows.push({ name: copy.name, initialized: true, memoized: true, grpcStub: true,
        operations: operation.name, location: location.locationId, iam: policy.bindings[0].role, statusCode: decodedStatus.code });
      clients.push({ close: () => operationStub.close() });
    }
    const observed = await accounting(state);
    await firestore.terminate();
    return { rows, accounting: observed, gaxCopies: gaxCopies.map(copy => copy.name), highLevelConstructors: ['datastore', 'firestore'],
      highLevelInitialized: ['firestore-batch-get'] };
  } finally { await Promise.all(clients.map(client => client.close())); }
}

async function requestIsolation(token) {
  isolateId ||= crypto.randomUUID();
  const ordinal = ++requestCount;
  activeRequests++; peakRequests = Math.max(peakRequests, activeRequests);
  const state = transportFor(token), options = state.transport.gaxOptions({ projectId: 'bootstrap-project', authClient: auth(token) });
  const datastore = new sdk.datastore.Datastore(options), secret = new sdk.secret.SecretManagerServiceClient(options);
  try {
    const key = datastore.key(['BootstrapRequest', token]);
    const [entity] = await datastore.get(key, { gaxOptions: { retry: null, timeout: 10000 } });
    const [value] = await secret.getSecret({ name: `projects/bootstrap-project/secrets/${token}` }, { retry: null, timeout: 10000 });
    check(entity?.marker === token && value.name === `projects/bootstrap-project/secrets/${token}`, 'REQUEST_RESULT_ISOLATED');
    const observed = await accounting(state);
    return { token, ordinal, isolateId, peakRequests, entity: entity.marker, secret: value.name, accounting: observed };
  } finally {
    await Promise.all([secret.close(), ...[...datastore.clients_.values()].map(client => client.close())]);
    activeRequests--;
  }
}

export default { async fetch(request) {
  try {
    const route = new URL(request.url).pathname;
    auditStage = route;
    let result;
    if (route === '/codecs') result = auditCodecs();
    else if (route === '/closure') result = await closure();
    else if (route === '/application') result = { probe: probeApplicationProtobuf(applicationProtobuf),
      independentCopies: schemas.every(schema => schema.P !== applicationProtobuf && schema.P.Type.prototype !== applicationProtobuf.Type.prototype),
      prototypesUnchanged: appMethods.every((method, index) => method === [applicationProtobuf.Root.fromJSON,
        applicationProtobuf.Type.prototype.setup, applicationProtobuf.Type.prototype.fromObject, applicationProtobuf.Type.generateConstructor][index]) };
    else if (route.startsWith('/request/')) result = await requestIsolation(route.slice('/request/'.length));
    else return new Response('Not found', { status: 404 });
    return Response.json({ status: 'passed', profile: profileId, result });
  } catch (error) { return Response.json({ status: 'failed', message: error.message, name: error.name, auditStage, stack: error.stack }, { status: 500 }); }
} };
