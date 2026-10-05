'use strict';
const https = require('node:https');

function parseWorkerHttpArgs(argv) {
  const options = argv.filter(value => value.startsWith('--worker-http'));
  if (options.length > 1 || options.some(value => !['--worker-http=fetch', '--worker-http=fresh'].includes(value))) {
    throw new Error('INVALID_WORKER_HTTP_OPTION');
  }
  return options[0]?.slice('--worker-http='.length) || 'fetch';
}

// Node-side probe control only: every POST gets a new TLS connection. This does
// not change the adapter's Fetch transport or retry failed/redirected requests.
async function fetchWorkerHttp(input, { headers, signal, maxResponseBytes = 262144,
  requestImpl = https.request } = {}) {
  let url;
  try { url = new URL(input); } catch { throw new TypeError('Invalid Worker HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError('Invalid Worker HTTPS URL');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError('Invalid Worker response byte limit');
  }
  if (signal?.aborted) {
    throw Object.assign(new Error('Worker HTTPS request aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
  }
  return new Promise((resolve, reject) => {
    let request, bodyFailure;
    const resetError = () => Object.assign(new Error('Worker HTTPS response interrupted'), { code: 'ECONNRESET' });
    try {
      request = requestImpl(url, { method: 'POST', agent: false, headers, signal }, response => {
        if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
          const error = Object.assign(new Error('Invalid Worker HTTP status'), { code: 'WGA_WORKER_HTTP_STATUS_INVALID' });
          response.once('error', () => {});
          reject(error); response.destroy(error); return;
        }
        let chunks = [], bytes = 0, settled = false;
        const body = new Promise((resolveBody, rejectBody) => {
          bodyFailure = error => {
            if (settled) return;
            settled = true; chunks = []; rejectBody(error);
          };
          response.on('data', chunk => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > maxResponseBytes) {
              const error = Object.assign(new Error('Worker response exceeds byte limit'), {
                code: 'WGA_WORKER_HTTP_BODY_TOO_LARGE',
              });
              bodyFailure(error); response.destroy(error); return;
            }
            chunks.push(chunk);
          });
          response.on('error', bodyFailure);
          response.on('aborted', () => bodyFailure(resetError()));
          response.on('close', () => { if (!response.complete) bodyFailure(resetError()); });
          response.on('end', () => {
            if (settled) return;
            settled = true;
            const text = Buffer.concat(chunks, bytes).toString('utf8');
            chunks = []; resolveBody(text);
          });
        });
        // Body consumption starts at headers; callers may await text() later.
        body.catch(() => {});
        resolve({ status: response.statusCode, text: () => body });
      });
      request.on('error', error => bodyFailure ? bodyFailure(error) : reject(error));
      request.end();
    } catch (error) { reject(error); request?.destroy(); }
  });
}

module.exports = { fetchWorkerHttp, parseWorkerHttpArgs };
