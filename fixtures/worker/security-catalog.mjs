import * as installedGrpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport as installedTransport } from '@grpc/grpc-js/adapter';
import { Buffer } from 'node:buffer';
import { env } from 'node:process';
import assert from 'node:assert/strict';
import oauth from '../google/node_modules/google-auth-library/build/src/auth/oauth2client.js';

const rpcPath = '/security.Catalog/Unary';
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));
export async function runSecurityCatalog({ grpc = installedGrpc, createWorkersGrpcTransport = installedTransport,
  runtime, mode, authMarker, payloadMarker, network = fetch }) {
  const rows = [], logs = [], observer = [];
  const savedConsole = Object.fromEntries(['log', 'warn', 'error', 'debug', 'info'].map(key => [key, console[key]]));
  for (const key of Object.keys(savedConsole)) console[key] = (...args) => logs.push({ level: key, text: args.map(String).join(' ') });
  function transport(fetcher, route = mode) {
    return createWorkersGrpcTransport({ mode: route,
      ...(route === 'grpc-web' ? { endpoints: { 'security-gateway.test': 'https://security-gateway.test' } } : {}),
      fetcher: { fetch: fetcher }, observer: event => observer.push(event) });
  }
  function bearer(counter) {
    return grpc.credentials.createFromMetadataGenerator((_options, callback) => {
      counter.authCalls++;
      const metadata = new grpc.Metadata(); metadata.set('authorization', `Bearer ${authMarker}`); callback(null, metadata);
    });
  }
  async function invoke(client, { method = rpcPath, payload = payloadMarker, metadata = new grpc.Metadata(), credentials } = {}) {
    const result = { callbacks: 0, statuses: [], errors: [], values: 0 };
    await new Promise(resolve => {
      const call = client.makeUnaryRequest(method, value => Buffer.from(value), value => value, payload, metadata,
        { deadline: Date.now() + 5000, ...(credentials ? { credentials } : {}) }, (error, value) => {
          result.callbacks++;
          if (error) result.errors.push({ code: error.code, details: error.details, message: error.message });
          if (value !== undefined) result.values++;
        });
      call.on('status', status => { result.statuses.push({ code: status.code, details: status.details }); resolve(); });
    });
    await nextTurn();
    assert.equal(result.callbacks, 1); assert.equal(result.statuses.length, 1);
    assert.equal(client.getChannel().activeCallCount(), 0);
    return { ...result, activeCalls: 0 };
  }
  function row(id, variant, data) { rows.push({ id, variant, status: 'passed', ...data }); }
  try {
    for (const httpStatus of [301, 302, 307, 308]) {
      const counter = { fetchCount: 0, authCalls: 0 };
      const channel = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), bearer(counter));
      const factory = transport(async (url, init) => {
        counter.fetchCount++;
        assert.equal(init.redirect, 'manual');
        assert.equal(init.headers.get('authorization') === `Bearer ${authMarker}`, true);
        const headers = new Headers(init.headers);
        headers.set('x-security-redirect', String(httpStatus)); headers.set('x-security-runtime', runtime); headers.set('x-security-mode', mode);
        return network(url, { ...init, headers });
      });
      const client = new grpc.Client('security-gateway.test', channel, factory.grpcOptions());
      try {
        const call = await invoke(client);
        assert.deepEqual(call.statuses, [{ code: 2, details: 'WGA_REDIRECT_BLOCKED' }]);
        assert.deepEqual(counter, { fetchCount: 1, authCalls: 1 });
        row('SEC-001', `redirect-${httpStatus}`, { httpStatus, ...counter, manualRedirect: true, call });
      } finally { client.close(); }
    }
    const methods = ['/security.Catalog/Unary?x=1', '/security.Catalog/../Unary', '/security.Catalog/%2fUnary',
      '/security.Catalog/%2FUnary', '/security.Catalog/%252fUnary', '/security.Catalog/%2e%2e', '//attacker.test/Unary',
      '/security.Catalog/Unary#x', '/security.Catalog\\Unary', '/security.Catalog/Unary@attacker.test'];
    for (const [index, method] of methods.entries()) {
      const counter = { fetchCount: 0, authCalls: 0, outgoingHeaders: 0 };
      const factory = transport(async () => { counter.fetchCount++; counter.outgoingHeaders++; throw new Error('UNEXPECTED_NETWORK'); });
      const channel = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), bearer(counter));
      const client = new grpc.Client('security-gateway.test', channel, factory.grpcOptions());
      try {
        const call = await invoke(client, { method });
        assert.deepEqual(call.statuses, [{ code: 13, details: 'WGA_INVALID_METHOD' }]);
        assert.deepEqual(counter, { fetchCount: 0, authCalls: 0, outgoingHeaders: 0 });
        row('SEC-002', `method-${index}`, { vector: method, ...counter, call });
      } finally { client.close(); }
    }
    const targets = ['security-gateway.test?x=1', 'security-gateway.test/..', 'security-gateway.test%2fescape',
      'security-gateway.test%2Fescape', 'security-gateway.test%252fescape', 'user@security-gateway.test',
      'user:pass@security-gateway.test', 'security-gateway.test#x', 'security-gateway.test\\escape'];
    for (const [index, target] of targets.entries()) {
      const counter = { fetchCount: 0, authCalls: 0, outgoingHeaders: 0 };
      const factory = transport(async () => { counter.fetchCount++; counter.outgoingHeaders++; throw new Error('UNEXPECTED_NETWORK'); });
      const channel = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), bearer(counter));
      assert.throws(() => new grpc.Client(target, channel, factory.grpcOptions()), { code: 'WGA_INVALID_TARGET' });
      assert.deepEqual(counter, { fetchCount: 0, authCalls: 0, outgoingHeaders: 0 });
      row('SEC-002', `target-${index}`, { vector: target, ...counter, errorCode: 'WGA_INVALID_TARGET' });
    }
    for (const [variant, key, value] of [['crlf-key', 'x-safe\r\nx-injected', 'value'],
      ['crlf-value', 'x-safe', 'value\r\nx-injected: yes']]) {
      const counter = { fetchCount: 0, outgoingHeaders: 0, authCalls: 0 };
      assert.throws(() => new grpc.Metadata().set(key, value));
      const factory = transport(async () => { counter.fetchCount++; counter.outgoingHeaders++; throw new Error('UNEXPECTED_NETWORK'); });
      const calls = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
        counter.authCalls++;
        try { const metadata = new grpc.Metadata(); metadata.set('authorization', `Bearer ${authMarker}`); metadata.set(key, value); callback(null, metadata); }
        catch (error) { callback(error); }
      });
      const client = new grpc.Client('security-gateway.test', grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), calls), factory.grpcOptions());
      try {
        const call = await invoke(client);
        assert.deepEqual(call.statuses, [{ code: 2, details: 'WGA_AUTH_METADATA' }]);
        assert.deepEqual(counter, { fetchCount: 0, outgoingHeaders: 0, authCalls: 1 });
        row('SEC-003', variant, { ...counter, directMetadataRejected: true, call });
      } finally { client.close(); }
    }
    if (mode === 'grpc-web') for (const expired of [false, true]) {
      const counter = { fetchCount: 0, tokenRequests: 0, credentialCalls: 0, tokenTransmissions: 0 };
      const auth = new oauth.OAuth2Client({ clientId: 'security-fixture', clientSecret: authMarker });
      auth.setCredentials({ access_token: authMarker, refresh_token: authMarker, expiry_date: Date.now() + (expired ? -1000 : 3600000) });
      const original = auth.getRequestHeaders.bind(auth);
      auth.getRequestHeaders = (...args) => { counter.credentialCalls++; return original(...args); };
      auth.transporter.request = async () => { counter.tokenRequests++; throw new Error('UNEXPECTED_TOKEN_REQUEST'); };
      const calls = grpc.credentials.createFromGoogleCredential(auth);
      const factory = createWorkersGrpcTransport({ mode: 'grpc-web', allowInsecureLocalhost: true,
        endpoints: { 'security-gateway.test': 'http://127.0.0.1:17777' },
        fetcher: { async fetch(_url, init) { counter.fetchCount++; counter.tokenTransmissions += Number(new Headers(init.headers).has('authorization')); throw new Error('UNEXPECTED_NETWORK'); } } });
      assert.throws(() => grpc.credentials.combineChannelCredentials(grpc.credentials.createInsecure(), calls), { code: 'WGA_UNSUPPORTED_TLS' });
      const secure = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), calls);
      assert.throws(() => new grpc.Client('security-gateway.test', secure, factory.grpcOptions()), { code: 'WGA_UNSUPPORTED_TLS' });
      const client = new grpc.Client('security-gateway.test', grpc.credentials.createInsecure(), factory.grpcOptions());
      try {
        const call = await invoke(client, { credentials: calls });
        assert.deepEqual(call.statuses, [{ code: 16, details: 'WGA_INSECURE_AUTH' }]);
        assert.deepEqual(counter, { fetchCount: 0, tokenRequests: 0, credentialCalls: 0, tokenTransmissions: 0 });
        row('SEC-004', expired ? 'expired-google-credential' : 'cached-google-credential', {
          ...counter, realGoogleCredential: true, insecureCompositionRejected: true, secureHttpRouteRejected: true, call });
      } finally { client.close(); }
    }
    for (const stage of ['auth', 'fetch']) {
      const counter = { fetchCount: 0, authCalls: 0, payloadMatched: false, bearerMatched: false };
      const calls = stage === 'auth' ? grpc.credentials.createFromMetadataGenerator((_options, callback) => {
        counter.authCalls++; callback(Object.assign(new Error(`${authMarker}:${payloadMarker}`), { code: 16 }));
      }) : bearer(counter);
      const factory = transport(async (_url, init) => {
        counter.fetchCount++;
        counter.payloadMatched = Buffer.from(init.body).subarray(5).toString() === payloadMarker;
        counter.bearerMatched = new Headers(init.headers).get('authorization') === `Bearer ${authMarker}`;
        throw new Error(`${authMarker}:${payloadMarker}`);
      });
      const client = new grpc.Client('security-gateway.test', grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), calls), factory.grpcOptions());
      try {
        const call = await invoke(client);
        assert.deepEqual(call.statuses, [{ code: stage === 'auth' ? 16 : 14, details: stage === 'auth' ? 'WGA_AUTH_METADATA' : 'WGA_FETCH_FAILED' }]);
        assert.equal(counter.fetchCount, stage === 'auth' ? 0 : 1);
        if (stage === 'fetch') { assert.equal(counter.payloadMatched, true); assert.equal(counter.bearerMatched, true); }
        const text = JSON.stringify({ call, observer, logs });
        assert.equal(text.includes(authMarker) || text.includes(payloadMarker), false, 'sensitive diagnostic redaction');
        row('SEC-006', `${stage}-failure`, { ...counter, call, redacted: true });
      } finally { client.close(); }
    }
    const savedEnv = [env.GOOGLE_API_USE_CLIENT_CERTIFICATE, env.GOOGLE_API_USE_MTLS_ENDPOINT];
    const setEnv = (certificate, endpoint) => {
      for (const [key, value] of [['GOOGLE_API_USE_CLIENT_CERTIFICATE', certificate], ['GOOGLE_API_USE_MTLS_ENDPOINT', endpoint]]) {
        if (value === undefined) delete env[key]; else env[key] = value;
      }
    };
    try {
      for (const [variant, certificate, endpoint] of [['client-certificate-required', 'true', 'auto'],
        ['mtls-endpoint-required', 'false', 'always'], ['both-required', 'true', 'always']]) {
        setEnv(undefined, undefined);
        const counter = { fetchCount: 0, tokenRequests: 0, credentialCalls: 0 };
        const factory = transport(async () => { counter.fetchCount++; throw new Error('UNEXPECTED_NETWORK'); });
        const auth = new oauth.OAuth2Client();
        auth.setCredentials({ access_token: authMarker, expiry_date: Date.now() + 3600000 });
        const original = auth.getRequestHeaders.bind(auth);
        auth.getRequestHeaders = (...args) => { counter.credentialCalls++; return original(...args); };
        auth.transporter.request = async () => { counter.tokenRequests++; throw new Error('UNEXPECTED_TOKEN_REQUEST'); };
        const calls = grpc.credentials.createFromGoogleCredential(auth);
        setEnv(certificate, endpoint);
        assert.throws(() => grpc.credentials.createSsl(), { code: 'WGA_UNSUPPORTED_TLS' });
        assert.throws(() => createWorkersGrpcTransport(), { code: 'WGA_UNSUPPORTED_TLS' });
        assert.throws(() => new grpc.Client('security-gateway.test', grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), calls), factory.grpcOptions()), { code: 'WGA_UNSUPPORTED_TLS' });
        assert.deepEqual(counter, { fetchCount: 0, tokenRequests: 0, credentialCalls: 0 });
        row('SEC-007', variant, { errorCode: 'WGA_UNSUPPORTED_TLS', ...counter, environmentRejected: true, realGoogleCredential: true });
      }
      setEnv(undefined, undefined);
      for (const [variant, args] of [['private-key-and-certificate', [null, Buffer.from(payloadMarker), Buffer.from(payloadMarker)]],
        ['root-certificate', [Buffer.from(payloadMarker)]], ['verification-options', [null, null, null, {}]]]) {
        assert.throws(() => grpc.credentials.createSsl(...args), { code: 'WGA_UNSUPPORTED_TLS' });
        row('SEC-007', variant, { errorCode: 'WGA_UNSUPPORTED_TLS', fetchCount: 0, tokenRequests: 0, credentialRejected: true });
      }
      for (const [variant, certificate, endpoint] of [['default-environment', undefined, undefined], ['mtls-disabled', 'false', 'never'], ['auto-without-certificate', 'false', 'auto']]) {
        setEnv(certificate, endpoint); assert.doesNotThrow(() => grpc.credentials.createSsl());
        row('SEC-007', variant, { acceptedControl: true, fetchCount: 0, tokenRequests: 0 });
      }
    } finally { setEnv(...savedEnv); }
    return { runtime, mode, status: 'passed', rows, logs, observer };
  } finally { for (const [key, method] of Object.entries(savedConsole)) console[key] = method; }
}

export default {
  async fetch(request) {
    const input = await request.json();
    try { return Response.json(await runSecurityCatalog({ ...input, runtime: 'workerd' })); }
    catch (error) {
      const diagnostic = [input.authMarker, input.payloadMarker].reduce((text, marker) => text.split(marker).join('[redacted]'), String(error.stack ?? error));
      return Response.json({ status: 'failed', diagnostic: diagnostic.slice(0, 6000) }, { status: 500 });
    }
  },
};
