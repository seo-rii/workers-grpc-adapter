const endpoint = 'https://secretmanager.googleapis.com/google.cloud.secretmanager.v1.SecretManagerService/GetSecret';
const contentTypes = {
  'web-proto': 'application/grpc-web+proto',
  web: 'application/grpc-web',
  'native-proto': 'application/grpc+proto',
  native: 'application/grpc',
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bodyLimit = 65536;

async function authenticated(request, key) {
  if (typeof key !== 'string' || key.length < 32) return false;
  const expected = `Bearer ${key}`;
  const actual = request.headers.get('authorization') ?? '';
  if (actual.length !== expected.length) return false;
  const hmac = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', hmac, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', hmac, signature, encoder.encode(actual));
}

function getSecretFrame(name) {
  const value = encoder.encode(name), length = [];
  let remaining = value.length;
  do {
    const byte = remaining & 127;
    remaining = Math.floor(remaining / 128);
    length.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  const frame = new Uint8Array(6 + length.length + value.length);
  new DataView(frame.buffer).setUint32(1, frame.length - 5);
  frame[5] = 10;
  frame.set(length, 6);
  frame.set(value, 6 + length.length);
  return frame;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || !await authenticated(request, env.WGA_TEST_KEY)) return new Response('Not found', { status: 404 });
    const route = /^\/probe\/(default|convert|passthrough)\/(web-proto|web|native-proto|native)$/.exec(new URL(request.url).pathname);
    if (!route) return new Response('Not found', { status: 404 });
    const [, mode, wire] = route;
    if (!/^projects\/[0-9]+\/secrets\/wga-probe-[a-z0-9-]+-missing$/.test(env.WGA_SECRET_NAME ?? '') ||
        typeof env.WGA_GOOGLE_ACCESS_TOKEN !== 'string' || env.WGA_GOOGLE_ACCESS_TOKEN.length < 20) {
      return Response.json({ mode, wire, error: 'INVALID_PROBE_CONFIGURATION' }, { status: 500 });
    }
    const clean = value => {
      if (value === null || value === undefined) return null;
      let text = String(value);
      for (const secret of [env.WGA_GOOGLE_ACCESS_TOKEN, env.WGA_TEST_KEY]) {
        text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
      }
      return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\uFFFD').slice(0, 1500);
    };
    const started = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        headers: {
          'content-type': contentTypes[wire],
          authorization: `Bearer ${env.WGA_GOOGLE_ACCESS_TOKEN}`,
          'grpc-timeout': '20000m',
          ...(wire.startsWith('web') ? { 'x-grpc-web': '1' } : {}),
        },
        body: getSecretFrame(env.WGA_SECRET_NAME),
        ...(mode === 'default' ? {} : { cf: { grpcWeb: mode } }),
      });
      const result = {
        mode, wire, httpStatus: response.status,
        contentType: clean(response.headers.get('content-type')),
        grpcStatusHeader: clean(response.headers.get('grpc-status')),
        grpcMessageHeader: clean(response.headers.get('grpc-message')),
        server: clean(response.headers.get('server')),
        cfRay: clean(response.headers.get('cf-ray')),
        workerCfRay: clean(request.headers.get('cf-ray')),
        requestId: clean(response.headers.get('x-request-id') ?? response.headers.get('x-goog-request-id')),
        bodyBytes: 0, capturedBytes: 0, bodyLimitExceeded: false,
        messageFrames: 0, trailerFrames: 0, grpcWebStatuses: [], grpcWebMessages: [], malformedFrames: false,
      };
      const chunks = [];
      const reader = response.body?.getReader();
      if (reader) try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          result.bodyBytes += next.value.byteLength;
          const available = bodyLimit - result.capturedBytes;
          if (available > 0) {
            const part = next.value.subarray(0, available);
            chunks.push(part);
            result.capturedBytes += part.byteLength;
          }
          if (result.bodyBytes > bodyLimit) { result.bodyLimitExceeded = true; break; }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body = new Uint8Array(result.capturedBytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
      result.bodySha256 = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
      if (/^application\/grpc(?:-web)?(?:\+proto)?(?:;|$)/i.test(result.contentType ?? '')) {
        offset = 0;
        while (offset < body.length) {
          if (body.length - offset < 5) { result.malformedFrames = true; break; }
          const flag = body[offset], size = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0);
          offset += 5;
          if (![0, 1, 128].includes(flag) || size > body.length - offset || result.trailerFrames) { result.malformedFrames = true; break; }
          const payload = body.subarray(offset, offset + size);
          offset += size;
          if (flag !== 128) result.messageFrames++;
          else {
            result.trailerFrames++;
            for (const line of decoder.decode(payload).split(/\r?\n/)) {
              const separator = line.indexOf(':');
              if (separator < 0) continue;
              const name = line.slice(0, separator).trim().toLowerCase();
              const value = line.slice(separator + 1).trim();
              if (name === 'grpc-status' && /^\d+$/.test(value)) result.grpcWebStatuses.push(Number(value));
              if (name === 'grpc-message') {
                let decoded = value;
                try { decoded = decodeURIComponent(value); } catch {}
                result.grpcWebMessages.push(clean(decoded));
              }
            }
          }
        }
      } else result.nonGrpcBodyPrefix = clean(decoder.decode(body));
      result.elapsedMs = Date.now() - started;
      return Response.json(result);
    } catch (error) {
      return Response.json({ mode, wire, error: 'WIRE_PROBE_ERROR', errorName: clean(error?.name), message: clean(error?.message), elapsedMs: Date.now() - started }, { status: 502 });
    }
  },
};
