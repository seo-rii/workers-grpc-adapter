'use strict';
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
function need(value, reason) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: wire-catalog ${reason}`); }
const same = (actual, expected, label) => need(isDeepStrictEqual(actual, expected), label);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const modes = ['cloudflare', 'grpc-web'], runtimes = ['node', 'workerd'];
const ids = Array.from({ length: 27 }, (_, index) => `WIRE-${String(index + 1).padStart(3, '0')}`);
const zero = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
  parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
const sources = ['scripts/test-wire-catalog.cjs', 'scripts/wire-allocation.cjs', 'scripts/wire-catalog-evidence.cjs',
  'fixtures/shared/wire-vectors.mjs', 'fixtures/shared/wire-harness.mjs', 'fixtures/shared/wire-frames.mjs',
  'fixtures/shared/wire-metadata.mjs', 'fixtures/worker/wire-catalog.mjs', 'fixtures/worker/package-lock.json'];
const digest = bytes => ({ length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const repeatCache = new Map();
function repeated(length, fill) {
  const key = `${length}/${fill}`;
  if (!repeatCache.has(key)) {
    const h = createHash('sha256'), block = Buffer.alloc(65536, fill);
    for (let offset = 0; offset < length; offset += block.length) h.update(block.subarray(0, Math.min(block.length, length - offset)));
    repeatCache.set(key, { length, sha256: h.digest('hex') });
  }
  return repeatCache.get(key);
}

// Reviewed expectations, deliberately independent of the response generators
// and of adapter encoding/parsing code. The report never supplies its oracle.
function expectedPublic(mode) {
  const specs = new Map();
  function add(number, variant, code = 0, details = '', messages = [], extra = {}) {
    const id = ids[number - 1];
    specs.set(`${id}/${variant}`, { id, variant, code, details, messages, kind: 'unary', initial: [{}], metadata: {},
      catalogMatch: true, fetchCount: 1, budgets: { header: null, trailer: null, request: null }, ...extra });
  }
  const normal = digest(Buffer.from([0, 1, 2, 127, 128, 254, 255])), empty = digest(Buffer.alloc(0));
  add(1, 'normal-unary', 0, '', [normal]); add(2, 'present-zero-byte-message', 0, '', [empty]);
  add(3, 'trailer-only-empty-server-stream', 0, '', [], { kind: 'stream' });
  for (let i = 1; i <= 4; i++) add(4, `header-split-${i}`, 0, '', [normal]);
  add(5, 'every-response-byte-separate', 0, '', [normal], { source: { pulls: 34, chunks: 33, bytes: 33, cancels: 0 } });
  add(6, '128-ordered-frames-and-trailer-in-one-chunk', 0, '',
    Array.from({ length: 128 }, (_, n) => digest(Buffer.from([n, n ^ 165, 255 - n]))),
    { kind: 'stream', source: { pulls: 2, chunks: 1, bytes: 1045, cancels: 0 } });
  for (const seed of [1, 0x10203040, 0x5eedc0de, 0xffffffff]) {
    const bytes = Buffer.from(Array.from({ length: 1023 }, (_, n) => (n * 37 + (seed >>> (n % 24))) & 255));
    add(7, `seeded-payload-and-trailer-${seed}`, 0, '', [digest(bytes)],
      { metadata: { 'x-vector-seed': [String(seed)], 'x-vector-kind': ['split'] } });
  }
  for (const [name, limit] of [['grpc-default-four-mib', 4194304], ['grpc-minus-one-default-transport', 33554432],
    ['grpc-positive-65536', 65536], ['transport-minimum-over-positive-grpc', 1024],
    ['grpc-minus-one-custom-transport', 4096], ['grpc-positive-above-four-mib', 4259840],
    ['transport-minimum-over-default-grpc', 2048]]) {
    for (const [suffix, delta] of [['below', -1], ['at', 0], ['above', 1]]) {
      const length = limit + delta, rejected = delta === 1;
      add(8, `${name}-${suffix}-limit`, rejected ? 8 : 0, rejected ? 'WGA_FRAME_SIZE' : '', rejected ? [] : [repeated(length, 167)],
        { source: rejected ? { pulls: 1, chunks: 1, bytes: 5, cancels: 1 }
          : { pulls: Math.ceil(length / 65536) + 3, chunks: Math.ceil(length / 65536) + 2, bytes: length + 26, cancels: 0 } });
    }
  }
  add(8, 'grpc-zero-limit-empty-accepted', 0, '', [empty]);
  add(8, 'grpc-zero-limit-nonempty-rejected', 8, 'WGA_FRAME_SIZE', [], { source: { pulls: 1, chunks: 1, bytes: 5, cancels: 1 } });
  add(8, 'grpc-minus-one-crosses-four-mib-within-transport-cap', 0, '', [repeated(4194305, 110)]);
  add(9, 'uint32-maximum-header-without-payload', 8, 'WGA_FRAME_SIZE', [], { source: { pulls: 1, chunks: 1, bytes: 5, cancels: 1 } });
  for (let i = 1; i <= 4; i++) add(10, `truncated-header-${i}-bytes`, 13, 'WGA_TRUNCATED_FRAME', [],
    { source: { pulls: 2, chunks: 1, bytes: i, cancels: 0 } });
  for (const variant of ['payload-13-of-1024-bytes', 'payload-0-of-3-bytes']) add(11, variant, 13, 'WGA_TRUNCATED_FRAME');
  for (let flag = 0; flag <= 255; flag++) if (![0, 1, 128, 129].includes(flag)) {
    add(12, `reserved-flag-${flag.toString(16).padStart(2, '0')}`, 13, 'WGA_FRAME_FLAGS', [],
      { source: { pulls: 1, chunks: 1, bytes: 5, cancels: 1 } });
  }
  for (const [variant, code, detail, valid] of [
    ['compressed-trailer-unsupported', 12, 'WGA_COMPRESSED_TRAILER'],
    ['compressed-with-identity', 13, 'WGA_COMPRESSED_WITH_IDENTITY'],
    ['compressed-with-unsupported-snappy', 12, 'WGA_COMPRESSION_ENCODING'],
    ['malformed-gzip', 13, 'WGA_COMPRESSION_DATA'], ['malformed-deflate', 13, 'WGA_COMPRESSION_DATA'],
    ['supported-gzip', 0, '', true], ['supported-deflate', 0, '', true],
    ['unknown-encoding-with-uncompressed-message', 0, '', true],
    ['gzip-decompressed-size-exceeds-grpc-cap', 8, 'WGA_DECOMPRESSED_SIZE'],
    ['gzip-wire-size-exceeds-transport-cap', 8, 'WGA_FRAME_SIZE'],
  ]) add(13, variant, code, detail, valid ? [normal] : [], { catalogMatch: false });
  for (const suffix of ['separate-chunks', 'coalesced']) {
    add(14, `duplicate-trailer-${suffix}`, 13, 'WGA_FRAME_AFTER_TRAILER');
    add(15, `data-after-trailer-${suffix}`, 13, 'WGA_FRAME_AFTER_TRAILER');
  }
  const payload = [digest(Buffer.from('0a026f6b', 'hex'))], stream = { kind: 'stream' };
  add(16, 'data-without-status', 2, 'WGA_MISSING_GRPC_STATUS', payload, { ...stream, catalogMatch: false });
  add(17, 'http-200-permission-denied', 7, 'permission denied', payload, { ...stream, metadata: { 'x-trailing': ['preserved'] } });
  for (const [http, code] of [[400, 13], [401, 16], [403, 7], [404, 12], [429, 14], [502, 14], [503, 14], [504, 14], [200, 2]]) {
    add(18, `http-${http}`, code, 'WGA_MISSING_GRPC_STATUS', [], stream);
  }
  const headerMetadata = { 'x-only': ['preserved'], 'trace-bin': [{ hex: '0001ff' }] };
  add(19, 'headers-only-non-ok-preserves-both-events', 16, 'no auth', [], { ...stream, initial: [headerMetadata], metadata: headerMetadata });
  for (const location of ['headers', 'trailers']) {
    const initial = location === 'headers' ? [] : [{}];
    for (const name of ['alphabet', 'negative', 'out-of-range', 'duplicate', 'conflicting']) {
      add(20, `${location}-${name}`, 13, location === 'trailers' && ['duplicate', 'conflicting'].includes(name)
        ? 'WGA_DUPLICATE_STATUS' : 'WGA_INVALID_STATUS', [], { ...stream, initial });
    }
    for (const [name, hexes] of [['padded', ['0102']], ['unpadded', ['0304']], ['comma-combined', ['0102', '0304', '0001ff']]]) {
      const metadata = { 'trace-bin': hexes.map(hex => ({ hex })) };
      add(21, `${location}-${name}`, 7, '', [], { ...stream, metadata, initial: location === 'headers' ? [metadata] : [{}] });
    }
    for (const name of ['alphabet', 'excess-padding', 'embedded-padding', 'noncanonical-trailing-bits', 'extra-padding']) {
      add(23, `${location}-${name}`, 13, 'WGA_BINARY_METADATA', [], { ...stream, initial });
    }
    for (const [name, details] of [['korean', '권한 거부'], ['malformed-percent', 'bad%XX%2'], ['incomplete-utf8', '%ED%95']]) {
      add(24, `${location}-${name}`, 7, details, [], stream);
    }
    const rich = { 'grpc-status-details-bin': [{ hex: '0807120664656e6965641a080a016512030001ff' }] };
    add(25, `${location}-google-status-details`, 7, 'denied', [], { ...stream, metadata: rich,
      initial: location === 'headers' ? [rich] : [{}] });
    for (const excess of [false, true]) {
      const metadata = { 'trace-bin': [{ hex: '0102' }], 'x-pad': [repeated(location === 'headers' ? 65257 : 65327, 97)] };
      add(26, `${location}-budget-${excess ? 'limit-plus-one' : 'limit'}`, excess ? 8 : 7, excess ? 'WGA_METADATA_SIZE' : '권한 거부', [],
        { ...stream, metadata: excess ? {} : metadata, initial: location === 'headers' ? (excess ? [] : [metadata]) : [{}],
          budgets: { header: location === 'headers' ? 65536 + Number(excess) : null,
            trailer: location === 'trailers' ? 65536 + Number(excess) : null, request: null } });
    }
  }
  for (const variant of ['header-and-body-status-same', 'header-and-body-status-conflicting']) add(20, variant, 13, 'WGA_BODY_AFTER_HEADER_STATUS', [], stream);
  for (const variant of ['request-repeated-text', 'request-repeated-text-and-binary']) add(22, variant, 0, '', payload);
  add(26, 'request-budget-limit', 0, '', payload, { budgets: { header: null, trailer: null, request: 65536 } });
  add(26, 'request-budget-limit-plus-one', 8, 'WGA_METADATA_SIZE', [], { fetchCount: 0, initial: [],
    source: { pulls: 0, chunks: 0, bytes: 0, cancels: 0 } });
  for (const variant of ['html', 'json', 'grpc-web-text']) add(27, variant, 2, 'WGA_NOT_GRPC_WEB', [], { ...stream, initial: [] });
  // Exact demand receipts also prove that rejecting headers disposes the body
  // before reading it; an unlocked, abandoned stream is not sufficient.
  const fixedSources = [
    [1, 'normal-unary', 3, 2, 33, 0], [2, 'present-zero-byte-message', 3, 2, 26, 0],
    [3, 'trailer-only-empty-server-stream', 2, 1, 21, 0],
    [7, 'seeded-payload-and-trailer-1', 73, 72, 1089, 0],
    [7, 'seeded-payload-and-trailer-270544960', 70, 69, 1097, 0],
    [7, 'seeded-payload-and-trailer-1592639710', 69, 68, 1098, 0],
    [7, 'seeded-payload-and-trailer-4294967295', 69, 68, 1098, 0],
    [8, 'grpc-zero-limit-empty-accepted', 3, 2, 26, 0],
    [8, 'grpc-minus-one-crosses-four-mib-within-transport-cap', 68, 67, 4194331, 0],
    [11, 'payload-13-of-1024-bytes', 3, 2, 18, 0], [11, 'payload-0-of-3-bytes', 3, 2, 5, 0],
    [13, 'compressed-trailer-unsupported', 1, 1, 5, 1], [13, 'compressed-with-identity', 1, 1, 5, 1],
    [13, 'compressed-with-unsupported-snappy', 1, 1, 5, 1], [13, 'malformed-gzip', 1, 1, 9, 1],
    [13, 'malformed-deflate', 1, 1, 9, 1], [13, 'supported-gzip', 3, 2, 53, 0],
    [13, 'supported-deflate', 3, 2, 41, 0], [13, 'unknown-encoding-with-uncompressed-message', 3, 2, 33, 0],
    [13, 'gzip-decompressed-size-exceeds-grpc-cap', 1, 1, 28, 1], [13, 'gzip-wire-size-exceeds-transport-cap', 1, 1, 5, 1],
    [16, 'data-without-status', 2, 1, 9, 0], [17, 'http-200-permission-denied', 3, 2, 88, 0],
  ];
  for (const [number, variant, pulls, chunks, bytes, cancels] of fixedSources) {
    specs.get(`${ids[number - 1]}/${variant}`).source = { pulls, chunks, bytes, cancels };
  }
  for (const spec of specs.values()) {
    if (spec.source) continue;
    const n = Number(spec.id.slice(5)), variant = spec.variant;
    if (n === 4) spec.source = { pulls: 3, chunks: 2, bytes: 33, cancels: 0 };
    else if ([14, 15].includes(n)) spec.source = { pulls: variant.endsWith('coalesced') ? 1 : 2,
      chunks: variant.endsWith('coalesced') ? 1 : 2, bytes: n === 14 ? 42 : 33, cancels: 1 };
    else if (spec.fetchCount && spec.initial.length === 0) spec.source = { pulls: 0, chunks: 0, bytes: 0, cancels: 1 };
    else if (n === 18 || n === 19 || variant.startsWith('headers-')) spec.source = { pulls: 1, chunks: 0, bytes: 0, cancels: 0 };
    else if (n === 22 || variant === 'request-budget-limit') spec.source = { pulls: 3, chunks: 2, bytes: 30, cancels: 0 };
    else if (variant.startsWith('header-and-body-')) spec.source = { pulls: 1, chunks: 1, bytes: 21, cancels: 1 };
    else if (variant.startsWith('trailers-')) {
      const suffix = variant.slice(9), lengths = {
        20: { alphabet: 24, negative: 22, 'out-of-range': 22, duplicate: 37, conflicting: 37 },
        21: { padded: 54, unpadded: 53, 'comma-combined': 65 },
        23: { alphabet: 54, 'excess-padding': 56, 'embedded-padding': 54, 'noncanonical-trailing-bits': 54, 'extra-padding': 55 },
        24: { korean: 76, 'malformed-percent': 45, 'incomplete-utf8': 43 }, 25: { 'google-status-details': 98 },
        26: { 'budget-limit': 65429, 'budget-limit-plus-one': 65430 },
      };
      const cancelled = spec.details.startsWith('WGA_');
      spec.source = { pulls: cancelled ? 1 : 2, chunks: 1, bytes: lengths[n]?.[suffix], cancels: Number(cancelled) };
    }
    need(spec.source && integer(spec.source.bytes), `${spec.id}/${variant} reviewed source demand`);
  }
  need(specs.size === 369, 'reviewed public manifest count');
  return specs;
}

function resources(value, label, cap) {
  need(value && typeof value === 'object', `${label} resource snapshot`);
  for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) need(value[key] === 0, `${label} released ${key}`);
  need(integer(value.peakActiveCalls, 1) && value.peakQueuedCalls === 0
    && integer(value.peakBufferedBytes, cap) && value.peakBufferedBytes > 0, `${label} bounded measured resources`);
}
function publicRow(row, spec, mode) {
  const label = `${mode}/${spec.id}/${spec.variant}`;
  need(row.status === 'passed' && row.kind === spec.kind && row.catalogMatch === spec.catalogMatch, `${label} identity and policy`);
  same(row.statuses, [{ code: spec.code, details: spec.details, metadata: spec.metadata }], `${label} exact terminal and metadata`);
  same(row.initial, spec.initial, `${label} initial metadata`); same(row.decoded, spec.messages, `${label} exact decoded bytes`);
  same(row.delivered, spec.kind === 'stream' || spec.code === 0 ? spec.messages : [], `${label} public messages`);
  need(row.callbackCount === Number(spec.kind === 'unary') && row.callbackCode === (spec.kind === 'unary' ? spec.code : null), `${label} one unary callback`);
  same(row.errors, spec.kind === 'stream' && spec.code ? [spec.code] : [], `${label} stream error`);
  same(row.events, [...spec.initial.map(() => 'metadata'), ...(spec.kind === 'stream'
    ? [...spec.messages.map(() => 'data'), ...(spec.code ? ['error'] : [])] : ['callback']), 'status'], `${label} exact terminal event order`);
  need(row.fetchCount === spec.fetchCount && row.writeCompletions === 1, `${label} Fetch and write counts`);
  same(row.execution, zero, `${label} actual asynchronous cleanup`);
  same(row.diagnostics, { terminal: true, fetchCount: spec.fetchCount, requestBytes: 0, responseBytes: 0, timerActive: false }, `${label} local terminal cleanup`);
  resources(row.resources, label, 40 * 1024 * 1024);
  need(row.resources.peakActiveCalls === 1 && row.activeCalls === 0 && row.cleanupBeforeClose === true, `${label} cleanup precedes close`);
  need(row.source?.readerUnlocked === true, `${label} reader lock cleanup`);
  for (const key of ['pulls', 'chunks', 'bytes', 'cancels']) need(integer(row.source[key], key === 'cancels' ? 1 : 40 * 1024 * 1024), `${label} source ${key}`);
  need(row.source.pulls >= row.source.chunks && row.source.pulls <= row.source.chunks + 1, `${label} bounded source demand`);
  if (spec.source) same(row.source, { ...spec.source, readerUnlocked: true }, `${label} exact source receipt`);
  need(row.maxExecution && Object.keys(zero).every(key => integer(row.maxExecution[key])), `${label} measured owner peaks`);
  need(row.maxExecution.activePumps === Number(spec.messages.length > 0) && row.maxExecution.parserAssemblies === Number(spec.messages.length > 0)
    && row.maxExecution.pendingMessages === 0 && row.maxExecution.pendingMessageBytes === 0 && row.maxExecution.pendingWriteCallbacks === 0
    && row.maxExecution.parserAssemblyBytes <= 33554437 && row.maxExecution.runtimeChunkBytes <= 65536, `${label} one current frame and bounded runtime chunk`);
  if (spec.messages.length) need(row.maxExecution.parserAssemblyBytes >= 5 && row.maxExecution.runtimeChunkBytes > 0, `${label} positive parser calibration`);
  else need(row.maxExecution.parserAssemblyBytes === 0 && row.maxExecution.runtimeChunkBytes === 0, `${label} no fabricated sampled owners`);
  const type = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
  let request = { accept: type, 'content-type': type, 'grpc-accept-encoding': 'identity,deflate,gzip',
    'grpc-encoding': 'identity', 'x-grpc-web': '1', 'x-user-agent': 'workers-grpc-adapter/0.0.0-prototype.1' };
  if (spec.id === 'WIRE-022') {
    request['x-repeat'] = 'first, second';
    if (spec.variant.endsWith('-and-binary')) request['trace-bin'] = 'AQI=, AwQ=';
  }
  if (spec.variant === 'request-budget-limit') {
    request['x-user-agent'] += ' wire-boundary'; request['trace-bin'] = 'AQI=';
    request['x-pad'] = repeated(mode === 'cloudflare' ? 65067 : 65055, 97);
  }
  if (!spec.fetchCount) request = null;
  same(row.requestHeaders, request, `${label} emitted request metadata`); same(row.budgets, spec.budgets, `${label} encoded control-inclusive budgets`);
}

function expectedAllocations() {
  const result = new Map(), trailer = Buffer.from('grpc-status: 0\r\n'), data = Buffer.from([0, 10, 255, 128, 4, 5, 6]);
  const frame = (bytes, flag = false) => ({ trailer: flag, bytes: bytes.length, sha256: digest(bytes).sha256 });
  function success(number, scenario, payloads, chunks, calls) {
    const sizes = payloads.flatMap(([bytes]) => [5, bytes.length]).concat(5);
    result.set(`${ids[number - 1]}/${scenario}`, { code: 0, errorId: null, frames: payloads.map(([bytes, flag]) => frame(bytes, flag)),
      allocUnsafeSizes: sizes, setBytes: chunks.reduce((a, b) => a + b, 0), setCalls: calls,
      pulls: chunks.length + 1, pulledChunkSizes: chunks, cancels: 0 });
  }
  function failure(number, scenario, code, errorId, sizes = [5], copied = 5, calls = 1, chunks = [5], cancels = 1, frames = []) {
    result.set(`${ids[number - 1]}/${scenario}`, { code, errorId, frames, allocUnsafeSizes: sizes, setBytes: copied,
      setCalls: calls, pulls: chunks.length + Number(cancels === 0), pulledChunkSizes: chunks, cancels });
  }
  const pair = [[data, false], [trailer, true]], multi = [[data, false], [Buffer.alloc(0), false], [Buffer.from([255, 0, 77]), false], [trailer, true]];
  success(1, 'unary', pair, [33], 4); success(2, 'empty-message', [[Buffer.alloc(0), false], [trailer, true]], [26], 3);
  success(3, 'empty-stream', [[trailer, true]], [21], 2);
  for (let i = 1; i <= 4; i++) success(4, `header-split-${i}`, pair, [i, 33 - i], 5);
  for (const size of [31, 257, 4096]) success(5, `bytewise-${size}`,
    [[Buffer.from(Array.from({ length: size }, (_, i) => i * 29 & 255)), false], [trailer, true]], Array(size + 26).fill(1), size + 26);
  success(6, 'coalesced', multi, [46], 7); success(6, 'fragmented', multi, [14, 6, 3, 10, 13], 11);
  for (const [seed, chunks, calls] of [[1, [2, 3, 13, 13, 12, 3], 11], [12648430, [17, 2, 1, 14, 11, 1], 11],
    [305419896, [16, 6, 1, 4, 8, 3, 6, 2], 13], [4294967295, [4, 3, 13, 1, 2, 5, 14, 4], 14]]) success(7, `seed-${seed}`, multi, chunks, calls);
  for (const type of ['message-cap', 'wire-cap']) for (const size of [31, 32, 33]) {
    if (size === 33) failure(8, `${type}-${size}`, 8, 'WGA_FRAME_SIZE');
    else success(8, `${type}-${size}`, [[Buffer.alloc(size, 97), false]], [5, size], 2);
  }
  // Only a digest is retained for the large oracle; do not allocate 4 MiB while validating every report.
  result.set('WIRE-008/parser-cap-32MiB-above-4MiB', { code: 0, errorId: null,
    frames: [{ trailer: false, bytes: 4194305, sha256: repeated(4194305, 71).sha256 }], allocUnsafeSizes: [5, 4194305, 5],
    setBytes: 4194310, setCalls: 2, pulls: 3, pulledChunkSizes: [5, 4194305], cancels: 0 });
  failure(9, 'uint32-max', 8, 'WGA_FRAME_SIZE');
  for (let size = 1; size <= 4; size++) failure(10, `truncated-header-${size}`, 13, 'WGA_TRUNCATED_FRAME', [5], size, 1, [size], 0);
  failure(11, 'truncated-payload', 13, 'WGA_TRUNCATED_FRAME', [5, 12], 8, 2, [8], 0);
  for (let flag = 0; flag <= 255; flag++) if (![0, 1, 128, 129].includes(flag)) failure(12, `reserved-flag-${flag}`, 13, 'WGA_FRAME_FLAGS');
  for (const [name, code, error] of [['identity', 13, 'WGA_COMPRESSED_WITH_IDENTITY'], ['unknown-codec', 12, 'WGA_COMPRESSION_ENCODING'],
    ['compressed-trailer', 12, 'WGA_COMPRESSED_TRAILER']]) failure(13, name, code, error);
  for (const [number, scenario] of [[14, 'duplicate-trailer'], [15, 'data-after-trailer']]) {
    failure(number, scenario, 13, 'WGA_FRAME_AFTER_TRAILER', [5, 16, 5], 26, 3, [21, 5], 1, [frame(trailer, true)]);
  }
  need(result.size === 286, 'reviewed allocation manifest count'); return result;
}
const allocationSpecs = expectedAllocations();
const publicSpecs = new Map(modes.map(mode => [mode, expectedPublic(mode)]));
function allocation(value, sourceBuild) {
  need(value?.status === 'passed' && value.runtime === 'node' && value.layer === 'internal-parser'
    && value.sourceBuild === sourceBuild && value.spyRestored === true && /^\d+\.\d+\.\d+/.test(value.nodeVersion), 'Node-only parser provenance');
  const control = value.positiveControl;
  need(control && control.spyRestored === true && control.allocUnsafeSizes.includes(7)
    && control.allocUnsafeBytes === control.allocUnsafeSizes.reduce((a, b) => a + b, 0)
    && control.setCalls >= 1 && control.setBytes >= 3 && control.concatCalls === 1 && control.concatBytes === 4, 'calibrated allocation/copy/concat spy');
  same(control.copiedBytes, [5, 6, 7], 'calibration copied bytes'); same(control.concatenatedBytes, [1, 2, 3, 4], 'calibration concatenated bytes');
  need(value.rows?.length === 286, 'exact allocation count'); const seen = new Set();
  for (const row of value.rows) {
    const key = `${row.id}/${row.scenario}`, expected = allocationSpecs.get(key);
    need(expected && !seen.has(key) && row.status === 'passed', `${key} allocation identity`); seen.add(key);
    for (const [field, expectedValue] of Object.entries(expected)) same(row[field], expectedValue, `${key} measured ${field}`);
    need(row.allocUnsafeBytes === expected.allocUnsafeSizes.reduce((a, b) => a + b, 0)
      && row.concatCalls === 0 && row.concatBytes === 0 && row.readerLocked === false && row.spyRestored === true, `${key} linear allocation and disposal`);
    same(row.finalParser, { parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 }, `${key} actual parser cleanup`);
    resources(row.finalResources, key, 96 * 1024 * 1024);
    need(row.finalResources.peakActiveCalls === 0, `${key} internal parser has no admission claim`);
  }
}
function catalogCases(runs, allocationReport) {
  const all = runs.flatMap(run => run.rows.map(row => ({ row, runtime: run.runtime, mode: run.mode })));
  return ids.map(id => {
    const rows = all.filter(item => item.row.id === id), allocations = (allocationReport?.rows ?? []).filter(row => row.id === id);
    return { id, status: rows.length && rows.every(item => item.row.status === 'passed') && allocations.every(row => row.status === 'passed') ? 'passed' : 'failed',
      catalogMatch: rows.length > 0 && rows.every(item => item.row.catalogMatch === true),
      runtimes: runtimes.filter(runtime => rows.some(item => item.runtime === runtime)), modes: modes.filter(mode => rows.some(item => item.mode === mode)),
      scenarioCount: rows.length, allocationScenarioCount: allocations.length };
  });
}
function validateWireCatalogReport(report, { allowSourceBuild = false } = {}) {
  need(report?.status === 'passed' && report.development === false, 'complete nondevelopment execution');
  need(report.sourceBuild === false || (allowSourceBuild && report.sourceBuild === true), 'installed package execution');
  need(report.controlledPeer === true && report.liveCloud === false && report.incomingCloudflareTranslation === false
    && report.nativeHttp2 === false && report.externalRequests === 0, 'controlled local execution scope');
  need(report.runtimeDisposed === true && report.cleanupVerifiedBeforeDispose === true, 'cleanup before runtime disposal');
  need(report.compatibilityDate === '2026-09-21' && typeof report.workerd === 'string' && report.workerd.length > 0
    && typeof report.miniflare === 'string' && report.miniflare.length > 0 && /^v\d+\.\d+\.\d+/.test(report.node), 'runtime provenance');
  need(hash(report.bundleSha256) && sources.every(file => hash(report.evidence?.[file])), 'complete source provenance');
  need(report.installedInputs && typeof report.installedInputs === 'object' && !Array.isArray(report.installedInputs), 'installed provenance map');
  for (const [file, value] of Object.entries(report.installedInputs)) need(file.startsWith('fixtures/worker/node_modules/@grpc/grpc-js/')
    && !file.split('/').includes('..') && hash(value), 'valid installed input');
  if (!report.sourceBuild) for (const file of ['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'call.js', 'wire.js', 'compression.js', 'resources.js']) {
    need(hash(report.installedInputs[`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`]), `installed ${file}`);
  }
  allocation(report.allocation, report.sourceBuild);
  need(report.runs?.length === 4 && report.caseCount === 1476, 'exact runtime matrix count');
  for (const runtime of runtimes) for (const mode of modes) {
    const matches = report.runs.filter(run => run.runtime === runtime && run.mode === mode);
    need(matches.length === 1 && matches[0].status === 'passed' && matches[0].rows?.length === 369, `${runtime}/${mode} complete matrix`);
    const seen = new Set();
    for (const row of matches[0].rows) {
      const key = `${row.id}/${row.variant}`, spec = publicSpecs.get(mode).get(key);
      need(spec && !seen.has(key), `${runtime}/${mode} unique reviewed scenario`); seen.add(key); publicRow(row, spec, mode);
    }
  }
  // Both runtimes consume identical controlled sources: differing source demand
  // or byte receipts cannot be excused by a runtime label.
  for (const mode of modes) {
    const node = report.runs.find(run => run.runtime === 'node' && run.mode === mode);
    const worker = report.runs.find(run => run.runtime === 'workerd' && run.mode === mode);
    const baseline = new Map(node.rows.map(row => [`${row.id}/${row.variant}`, row]));
    for (const row of worker.rows) same(row.source, baseline.get(`${row.id}/${row.variant}`).source, `${mode}/${row.variant} cross-runtime source receipts`);
  }
  same(report.catalogCases, catalogCases(report.runs, report.allocation), 'catalog aggregation');
  need(report.catalogCases.length === 27 && report.catalogCases.every(row => row.status === 'passed'
    && row.catalogMatch === !['WIRE-013', 'WIRE-016'].includes(row.id)), 'preserved policy differences');
}
module.exports = { catalogCases, validateWireCatalogReport };
