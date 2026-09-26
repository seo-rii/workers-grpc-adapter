'use strict';
// Public, stateless protocol controls. This script never reads credentials.
// grpcbin contracts: https://github.com/moul/pb/blob/master/grpcbin/grpcbin.proto
// Eliza contracts: https://github.com/connectrpc/examples-go/blob/main/proto/connectrpc/eliza/v1/eliza.proto
const http2 = require('node:http2');
const path = require('node:path');
const { createRequire } = require('node:module');

const MAX_BYTES = 1024 * 1024;
const WEB_TIMEOUT_MS = 20000;
const NATIVE_TIMEOUT_MS = 30000; // grpcbin streams ten messages, one second apart.
const GRPCBIN = 'grpcb.in:443';
const ELIZA = 'https://demo.connectrpc.com';
const PREFIX = '/grpcbin.GRPCBin/';
const ECHO = field1('wga deployed probe % / 한글');
const ERROR_REASON = 'wga probe % / 한글';

function varint(value) {
    const bytes = [];
    do {
        const byte = value % 128;
        value = Math.floor(value / 128);
        bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return Buffer.from(bytes);
}
function field1(value) {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([10]), varint(bytes.length), bytes]);
}
function frame(bytes) {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
}
function safeError(error) {
    // Exclude messages, stacks, response bodies and arbitrary remote metadata.
    const atom = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null;
    return { name: atom(error?.name), code: Number.isInteger(error?.code) ? error.code : atom(error?.code) };
}
function grpcStatus(value) {
    return typeof value === 'string' && /^(?:[0-9]|1[0-6])$/.test(value) ? Number(value) : null;
}
function contentType(value) {
    return typeof value === 'string' ? value.slice(0, 160).replace(/[^\x20-\x7e]/g, '?') : null;
}
function inspectFrames(body, expectedEcho) {
    const result = { bodyBytes: body.length, messageFrames: 0, trailerFrames: 0, grpcWebStatuses: [], framingError: null, nonemptyMessages: true, echoMatches: expectedEcho ? true : null };
    let offset = 0, trailerSeen = false;
    while (offset < body.length) {
        if (body.length - offset < 5) { result.framingError = 'truncated-prefix'; break; }
        const flag = body[offset], length = body.readUInt32BE(offset + 1);
        offset += 5;
        if (flag !== 0 && flag !== 128) { result.framingError = 'unsupported-flag'; break; }
        if (length > MAX_BYTES) { result.framingError = 'frame-too-large'; break; }
        if (length > body.length - offset) { result.framingError = 'truncated-payload'; break; }
        if (trailerSeen) { result.framingError = 'frame-after-trailers'; break; }
        const payload = body.subarray(offset, offset + length);
        offset += length;
        if (flag === 0) {
            result.messageFrames++;
            result.nonemptyMessages &&= payload.length > 0;
            if (expectedEcho) result.echoMatches &&= payload.equals(expectedEcho);
        } else {
            trailerSeen = true;
            result.trailerFrames++;
            for (const line of payload.toString('utf8').split('\r\n')) {
                const match = /^grpc-status:\s*(.*?)\s*$/i.exec(line);
                if (match) result.grpcWebStatuses.push(grpcStatus(match[1]));
            }
        }
    }
    return result;
}
function webSummary(headers, trailers, chunks, expectedEcho) {
    const result = {
        httpStatus: Number.isInteger(headers?.[':status']) ? headers[':status'] : null,
        contentType: contentType(headers?.['content-type']),
        headerGrpcStatus: grpcStatus(headers?.['grpc-status']),
        httpTrailerGrpcStatus: grpcStatus(trailers?.['grpc-status']),
        ...inspectFrames(Buffer.concat(chunks), expectedEcho),
    };
    result.validGrpcWebSuccess = result.httpStatus === 200
        && /^application\/grpc-web(?:\+proto)?(?:\s*;|$)/i.test(result.contentType || '')
        && result.framingError === null
        && result.trailerFrames === 1
        && result.grpcWebStatuses.length === 1
        && result.grpcWebStatuses[0] === 0;
    return result;
}

function nativeProbe(grpc, method, request, expected) {
    return new Promise(resolve => {
        const started = Date.now();
        const client = new grpc.Client(GRPCBIN, grpc.credentials.createSsl(), {
            'grpc.max_receive_message_length': MAX_BYTES,
            'grpc.max_send_message_length': MAX_BYTES,
            'grpc.enable_retries': 0,
        });
        const result = { protocol: 'native-grpc', target: GRPCBIN, method: PREFIX + method, status: 'failed', responseMessages: 0, responseBytes: 0, allEchoesMatch: true, grpcStatus: null, reasonMatches: expected.code === 3 ? false : null };
        let call, settled = false;
        const finish = extra => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (extra?.timeout || extra?.limitExceeded) call?.cancel();
            client.close();
            Object.assign(result, extra, { durationMs: Date.now() - started });
            result.status = result.grpcStatus === expected.code
                && result.responseMessages === expected.messages
                && (expected.code !== 0 || result.allEchoesMatch)
                && (expected.code !== 3 || result.reasonMatches)
                && !result.timeout && !result.limitExceeded ? 'passed' : 'failed';
            resolve(result);
        };
        const timer = setTimeout(() => finish({ timeout: true }), NATIVE_TIMEOUT_MS + 1000);
        const receive = bytes => {
            result.responseMessages++;
            result.responseBytes += bytes.length;
            result.allEchoesMatch &&= bytes.equals(ECHO);
            if (result.responseBytes > MAX_BYTES || result.responseMessages > 10) finish({ limitExceeded: true });
        };
        const options = { deadline: Date.now() + NATIVE_TIMEOUT_MS };
        try {
            if (expected.messages === 10) {
                call = client.makeServerStreamRequest(PREFIX + method, value => value, value => value, request, new grpc.Metadata(), options);
                call.on('data', receive);
                call.on('error', error => { if (!settled) result.error = safeError(error); });
                call.on('status', status => finish({ grpcStatus: status.code }));
            } else {
                call = client.makeUnaryRequest(PREFIX + method, value => value, value => value, request, new grpc.Metadata(), options, (error, bytes) => {
                    if (bytes) receive(bytes);
                    finish({ grpcStatus: error ? error.code : 0, reasonMatches: expected.code === 3 ? error?.details === ERROR_REASON : null, ...(error ? { error: safeError(error) } : {}) });
                });
            }
        } catch (error) { finish({ error: safeError(error) }); }
    });
}

function directHttp2WebProbe() {
    return new Promise(resolve => {
        const started = Date.now(), chunks = [];
        let session, call, headers, trailers, bytes = 0, settled = false;
        const finish = extra => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            call?.destroy();
            session?.destroy();
            const summary = webSummary(headers, trailers, chunks, ECHO);
            summary.validGrpcWebSuccess &&= extra?.completed === true;
            resolve({ protocol: 'grpc-web-over-http2', target: GRPCBIN, method: PREFIX + 'DummyUnary', responseReceived: Boolean(headers), ...summary, ...extra, durationMs: Date.now() - started });
        };
        const timer = setTimeout(() => finish({ timeout: true }), WEB_TIMEOUT_MS);
        try {
            session = http2.connect(`https://${GRPCBIN}`);
            session.on('error', error => finish({ error: safeError(error) }));
            call = session.request({ ':method': 'POST', ':path': PREFIX + 'DummyUnary', 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', 'grpc-timeout': '20S', te: 'trailers' });
            call.on('response', value => { headers = value; });
            call.on('trailers', value => { trailers = value; });
            call.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_BYTES) { finish({ limitExceeded: true }); return; }
                chunks.push(chunk);
            });
            call.on('end', () => finish({ completed: true }));
            call.on('error', error => finish({ error: safeError(error) }));
            call.on('close', () => { if (!settled) finish({ closedBeforeEnd: true }); });
            call.end(frame(ECHO));
        } catch (error) { finish({ error: safeError(error) }); }
    });
}

async function elizaWebProbe(method, text, minimumMessages) {
    const started = Date.now(), controller = new AbortController(), chunks = [];
    let reader, headers, bytes = 0, timeout = false;
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, WEB_TIMEOUT_MS);
    let outcome = {};
    try {
        const response = await fetch(`${ELIZA}/connectrpc.eliza.v1.ElizaService/${method}`, {
            method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', 'grpc-timeout': '20S' },
            body: frame(field1(text)), signal: controller.signal, redirect: 'error',
        });
        headers = { ':status': response.status, 'content-type': response.headers.get('content-type'), 'grpc-status': response.headers.get('grpc-status') };
        if (response.body) {
            reader = response.body.getReader();
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > MAX_BYTES) { outcome.limitExceeded = true; controller.abort(); break; }
                chunks.push(Buffer.from(part.value));
            }
        }
    } catch (error) { outcome.error = safeError(error); }
    finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) {
            try { await reader.cancel(); } catch {}
            reader.releaseLock();
        }
    }
    const summary = webSummary(headers, undefined, chunks);
    const passed = summary.validGrpcWebSuccess && summary.messageFrames >= minimumMessages && summary.nonemptyMessages
        && (method !== 'Say' || summary.messageFrames === 1) && !timeout && !outcome.error && !outcome.limitExceeded;
    return { protocol: 'grpc-web-over-fetch', target: ELIZA, method: `/connectrpc.eliza.v1.ElizaService/${method}`, responseReceived: Boolean(headers), ...summary, ...outcome, timeout, status: passed ? 'passed' : 'failed', durationMs: Date.now() - started };
}

async function runControls() {
    const startedAt = new Date().toISOString();
    const nativeRequire = createRequire(path.join(__dirname, '../fixtures/native/package.json'));
    const grpc = nativeRequire('@grpc/grpc-js');
    const reason = Buffer.from(ERROR_REASON, 'utf8');
    const errorRequest = Buffer.concat([Buffer.from([8, 3, 18]), varint(reason.length), reason]);
    const probes = await Promise.all([
        nativeProbe(grpc, 'DummyUnary', ECHO, { code: 0, messages: 1 }),
        nativeProbe(grpc, 'DummyServerStream', ECHO, { code: 0, messages: 10 }),
        nativeProbe(grpc, 'SpecificError', errorRequest, { code: 3, messages: 0 }),
        directHttp2WebProbe(),
        elizaWebProbe('Say', 'Hello', 1),
        elizaWebProbe('Introduce', 'WGA probe', 2),
    ]);
    return {
        status: 'completed', startedAt, completedAt: new Date().toISOString(),
        nodeVersion: process.version, nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version,
        scope: 'Public stateless protocol controls; no credentials or Cloudflare requests',
        limits: { maxResponseBytes: MAX_BYTES, nativeDeadlineMs: NATIVE_TIMEOUT_MS, webTimeoutMs: WEB_TIMEOUT_MS },
        nativeGrpcPassed: probes.slice(0, 3).every(probe => probe.status === 'passed'),
        probes,
    };
}

module.exports = { runControls };
if (require.main === module) {
    runControls().then(report => console.log(JSON.stringify(report, null, 2)), error => {
        console.error(JSON.stringify({ status: 'control-runner-failed', error: safeError(error) }));
        process.exitCode = 1;
    });
}
