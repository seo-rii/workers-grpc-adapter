import { Buffer } from 'node:buffer';
import { frame, trailer, summary } from './wire-vectors.mjs';

const contentType = ['content-type', 'application/grpc-web+proto'];
const payload = Buffer.from([0x0a, 0x02, 0x6f, 0x6b]);
const payloadSummary = summary(payload);
const limit = 65536;
const encodedKorean = '%EA%B6%8C%ED%95%9C%20%EA%B1%B0%EB%B6%80';
// google.rpc.Status { code: 7, message: "denied", details: [Any { type_url: "e", value: 0001ff }] }.
const googleStatusHex = '0807120664656e6965641a080a016512030001ff';
const googleStatusBase64 = Buffer.from(googleStatusHex, 'hex').toString('base64');

// Independent encoded-field budget: no adapter metadata/parser imports.
function budget(fields) {
  return fields.reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value) + 32, 0);
}
function lines(fields) { return fields.map(([key, value]) => `${key}: ${value}\r\n`).join(''); }
function chunks(...bytes) { return () => bytes; }
function metadataFields(location, fields, { code = 7, details = '', binary } = {}) {
  const metadata = binary ? { 'trace-bin': binary.map(hex => ({ hex })) } : {};
  return location === 'headers'
    ? { headers: [contentType, ['grpc-status', String(code)], ['grpc-message', details], ...fields],
      chunks: chunks(), expectInitial: [metadata], expectTrailing: metadata }
    : { chunks: chunks(trailer(lines([['grpc-status', String(code)], ['grpc-message', details], ...fields]))),
      expectInitial: [{}], expectTrailing: metadata };
}

/** Encoded status and metadata fixtures shared unchanged by Node and workerd. */
export function* metadataCases(mode) {
  yield { id: 'WIRE-016', variant: 'data-without-status', kind: 'stream', chunks: chunks(frame(payload)),
    expected: { code: 2, details: 'WGA_MISSING_GRPC_STATUS', messages: [payloadSummary] },
    expectInitial: [{}], expectTrailing: {}, catalogMatch: false };

  yield { id: 'WIRE-017', variant: 'http-200-permission-denied', kind: 'stream',
    chunks: chunks(frame(payload), trailer('grpc-status: 7\r\ngrpc-message: permission%20denied\r\nx-trailing: preserved\r\n')),
    expected: { code: 7, details: 'permission denied', messages: [payloadSummary] },
    expectInitial: [{}], expectTrailing: { 'x-trailing': ['preserved'] } };

  for (const [httpStatus, code] of [[400, 13], [401, 16], [403, 7], [404, 12], [429, 14], [502, 14], [503, 14], [504, 14], [200, 2]]) {
    yield { id: 'WIRE-018', variant: `http-${httpStatus}`, kind: 'stream', httpStatus, chunks: chunks(),
      expected: { code, details: 'WGA_MISSING_GRPC_STATUS', messages: [] }, expectInitial: [{}], expectTrailing: {} };
  }

  // The adapter emits an initial event even for headers-only status. Assert
  // both events explicitly instead of implying native trailers-only parity.
  const headerMetadata = { 'x-only': ['preserved'], 'trace-bin': [{ hex: '0001ff' }] };
  yield { id: 'WIRE-019', variant: 'headers-only-non-ok-preserves-both-events', kind: 'stream',
    headers: [contentType, ['grpc-status', '16'], ['grpc-message', 'no%20auth'], ['x-only', 'preserved'], ['trace-bin', 'AAH/']],
    chunks: chunks(), expected: { code: 16, details: 'no auth', messages: [] },
    expectInitial: [headerMetadata], expectTrailing: headerMetadata };

  for (const location of ['headers', 'trailers']) {
    for (const [name, value] of [['alphabet', 'oops'], ['negative', '-1'], ['out-of-range', '17']]) {
      yield { id: 'WIRE-020', variant: `${location}-${name}`, kind: 'stream',
        ...(location === 'headers' ? { headers: [contentType, ['grpc-status', value]], chunks: chunks(), expectInitial: [] }
          : { chunks: chunks(trailer(`grpc-status: ${value}\r\n`)), expectInitial: [{}] }),
        expected: { code: 13, details: 'WGA_INVALID_STATUS', messages: [] }, expectTrailing: {} };
    }
    for (const [name, second] of [['duplicate', '0'], ['conflicting', '7']]) {
      const fields = [['grpc-status', '0'], ['grpc-status', second]];
      yield { id: 'WIRE-020', variant: `${location}-${name}`, kind: 'stream',
        ...(location === 'headers' ? { headers: [contentType, ...fields], chunks: chunks(), expectInitial: [] }
          : { chunks: chunks(trailer(lines(fields))), expectInitial: [{}] }),
        expected: { code: 13, details: location === 'headers' ? 'WGA_INVALID_STATUS' : 'WGA_DUPLICATE_STATUS', messages: [] },
        expectTrailing: {} };
    }
  }
  for (const [name, first, second] of [['same', '7', '7'], ['conflicting', '7', '0']]) {
    yield { id: 'WIRE-020', variant: `header-and-body-status-${name}`, kind: 'stream',
      headers: [contentType, ['grpc-status', first]], chunks: chunks(trailer(`grpc-status: ${second}\r\n`)),
      expected: { code: 13, details: 'WGA_BODY_AFTER_HEADER_STATUS', messages: [] }, expectInitial: [{}], expectTrailing: {} };
  }

  for (const location of ['headers', 'trailers']) {
    for (const [name, encoded, binary] of [
      ['padded', 'AQI=', ['0102']], ['unpadded', 'AwQ', ['0304']],
      ['comma-combined', 'AQI=, AwQ, AAH/', ['0102', '0304', '0001ff']],
    ]) {
      yield { id: 'WIRE-021', variant: `${location}-${name}`, kind: 'stream',
        ...metadataFields(location, [['trace-bin', encoded]], { binary }),
        expected: { code: 7, details: '', messages: [] } };
    }
  }

  for (const binary of [false, true]) {
    yield { id: 'WIRE-022', variant: binary ? 'request-repeated-text-and-binary' : 'request-repeated-text', kind: 'unary',
      requestMetadata(grpc) {
        const value = new grpc.Metadata(); value.add('x-repeat', 'first'); value.add('x-repeat', 'second');
        if (binary) { value.add('trace-bin', Buffer.from([1, 2])); value.add('trace-bin', Buffer.from([3, 4])); }
        return value;
      },
      expectRequestHeaders: { 'x-repeat': 'first, second', ...(binary ? { 'trace-bin': 'AQI=, AwQ=' } : {}) },
      chunks: chunks(frame(payload), trailer()), expected: { code: 0, details: '', messages: [payloadSummary] },
      expectInitial: [{}], expectTrailing: {} };
  }

  for (const location of ['headers', 'trailers']) {
    for (const [name, encoded] of [['alphabet', 'A@I='], ['excess-padding', 'AQI==='],
      ['embedded-padding', 'A=QI'], ['noncanonical-trailing-bits', 'AQJ='], ['extra-padding', 'AQI==']]) {
      yield { id: 'WIRE-023', variant: `${location}-${name}`, kind: 'stream',
        ...metadataFields(location, [['trace-bin', encoded]]),
        expected: { code: 13, details: 'WGA_BINARY_METADATA', messages: [] },
        expectInitial: location === 'headers' ? [] : [{}], expectTrailing: {} };
    }
  }

  for (const location of ['headers', 'trailers']) {
    for (const [name, encoded, decoded] of [['korean', encodedKorean, '권한 거부'],
      ['malformed-percent', 'bad%XX%2', 'bad%XX%2'], ['incomplete-utf8', '%ED%95', '%ED%95']]) {
      yield { id: 'WIRE-024', variant: `${location}-${name}`, kind: 'stream',
        ...metadataFields(location, [], { details: encoded }),
        expected: { code: 7, details: decoded, messages: [] } };
    }
  }

  for (const location of ['headers', 'trailers']) {
    const metadata = { 'grpc-status-details-bin': [{ hex: googleStatusHex }] };
    yield { id: 'WIRE-025', variant: `${location}-google-status-details`, kind: 'stream',
      ...metadataFields(location, [['grpc-status-details-bin', googleStatusBase64]], { details: 'denied' }),
      expected: { code: 7, details: 'denied', messages: [] },
      expectInitial: location === 'headers' ? [metadata] : [{}], expectTrailing: metadata };
  }

  for (const location of ['headers', 'trailers']) {
    // Controls count too: percent-encoded details and base64 text consume their
    // transmitted bytes rather than decoded string or Buffer lengths.
    const fixed = [['grpc-status', '7'], ['grpc-message', encodedKorean], ['trace-bin', 'AQI=']];
    const prefix = location === 'headers' ? [contentType, ...fixed] : fixed;
    const padding = limit - budget([...prefix, ['x-pad', '']]);
    for (const excess of [0, 1]) {
      const fields = [...prefix, ['x-pad', 'a'.repeat(padding + excess)]];
      const metadata = { 'trace-bin': [{ hex: '0102' }], 'x-pad': ['a'.repeat(padding + excess)] };
      yield { id: 'WIRE-026', variant: `${location}-budget-${excess ? 'limit-plus-one' : 'limit'}`, kind: 'stream',
        ...(location === 'headers' ? { headers: fields, chunks: chunks(), expectFinalHeaderBudget: limit + excess }
          : { chunks: chunks(trailer(lines(fields))), expectFinalTrailerBudget: limit + excess }),
        expected: { code: excess ? 8 : 7, details: excess ? 'WGA_METADATA_SIZE' : '권한 거부', messages: [] },
        expectInitial: location === 'headers' ? (excess ? [] : [metadata]) : [{}],
        expectTrailing: excess ? {} : metadata };
    }
  }

  const requestType = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
  const requestControls = [['content-type', requestType], ['accept', requestType], ['x-grpc-web', '1'],
    ['grpc-encoding', 'identity'], ['grpc-accept-encoding', 'identity,deflate,gzip'],
    ['x-user-agent', 'workers-grpc-adapter/0.0.1 wire-boundary']];
  const requestPadding = limit - budget([...requestControls, ['trace-bin', 'AQI='], ['x-pad', '']]);
  for (const excess of [0, 1]) {
    yield { id: 'WIRE-026', variant: `request-budget-${excess ? 'limit-plus-one' : 'limit'}`, kind: 'unary',
      channelOptions: { 'grpc.primary_user_agent': 'wire-boundary' },
      requestMetadata(grpc) {
        const value = new grpc.Metadata(); value.add('trace-bin', Buffer.from([1, 2]));
        value.add('x-pad', 'a'.repeat(requestPadding + excess)); return value;
      },
      expectFetchCount: excess ? 0 : 1,
      ...(excess ? {} : { expectFinalRequestHeaderBudget: limit, expectRequestHeaders: {
        ...Object.fromEntries(requestControls), 'trace-bin': 'AQI=', 'x-pad': 'a'.repeat(requestPadding) } }),
      chunks: chunks(frame(payload), trailer()),
      expected: { code: excess ? 8 : 0, details: excess ? 'WGA_METADATA_SIZE' : '', messages: excess ? [] : [payloadSummary] },
      expectInitial: excess ? [] : [{}], expectTrailing: {} };
  }

  for (const [name, type, body] of [['html', 'text/html', '<html><body>gateway error</body></html>'],
    ['json', 'application/json', '{"error":"gateway error"}'],
    ['grpc-web-text', 'application/grpc-web-text+proto', Buffer.concat([frame(payload), trailer()]).toString('base64')]]) {
    yield { id: 'WIRE-027', variant: name, kind: 'stream', headers: [['content-type', type]], chunks: chunks(Buffer.from(body)),
      expected: { code: 2, details: 'WGA_NOT_GRPC_WEB', messages: [] }, expectInitial: [], expectTrailing: {} };
  }
}
