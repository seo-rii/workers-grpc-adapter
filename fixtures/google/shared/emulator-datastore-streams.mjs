import { Datastore } from '@google-cloud/datastore';
import { check, requireWrites, withCleanup } from './assert.mjs';

function collect(stream) {
    return new Promise((resolve, reject) => {
        const values = [], infos = [];
        const counts = { data: 0, info: 0, end: 0, error: 0 };
        const timeout = setTimeout(() => {
            stream.destroy();
            reject(new Error('WGA_EMULATOR_STREAM_TIMEOUT'));
        }, 10000);
        stream.on('data', value => { counts.data++; values.push(value); });
        stream.on('info', info => { counts.info++; infos.push(info); });
        stream.on('error', error => { counts.error++; clearTimeout(timeout); reject(error); });
        stream.on('end', () => { counts.end++; clearTimeout(timeout); resolve({ values, infos, counts }); });
        stream.on('close', () => {
            if (!counts.end) { clearTimeout(timeout); reject(new Error('WGA_EMULATOR_STREAM_CLOSED_BEFORE_END')); }
        });
    });
}

async function run(context) {
    requireWrites(context);
    const datastore = new Datastore({ ...context.options, namespace: `wga-emu-${context.runId}-streams` });
    const keys = [0, 1, 2, 3].map(rank => datastore.key(['WgaEmulatorStreams', `row-${rank}`]));
    const missing = datastore.key(['WgaEmulatorStreams', 'missing']);
    const streams = [];
    return withCleanup(async () => {
        await datastore.save(keys.map((key, rank) => ({ key, data: { rank } })));
        const query = datastore.createQuery('WgaEmulatorStreams').order('rank');
        const queryStream = datastore.runQueryStream(query);
        streams.push(queryStream);
        const queried = await collect(queryStream);
        check(queried.values.map(value => value.rank).join(',') === '0,1,2,3', 'emulator-datastore-query-stream-order');
        check(queried.values.every((value, index) => value[datastore.KEY].name === keys[index].name), 'emulator-datastore-query-stream-keys');
        check(queried.counts.data === 4 && queried.counts.info === 1 && queried.counts.end === 1 && queried.counts.error === 0, 'emulator-datastore-query-stream-events');
        check(queried.infos[0].moreResults === datastore.NO_MORE_RESULTS && typeof queried.infos[0].endCursor === 'string' && queried.infos[0].endCursor.length > 0, 'emulator-datastore-query-stream-info');

        const readStream = datastore.createReadStream([keys[3], missing, keys[1]]);
        streams.push(readStream);
        const read = await collect(readStream);
        // Lookup does not guarantee request order and omits missing entities.
        const byName = new Map(read.values.map(value => [value[datastore.KEY].name, value.rank]));
        check(byName.size === 2 && byName.get('row-3') === 3 && byName.get('row-1') === 1 && !byName.has('missing'), 'emulator-datastore-read-stream-found-missing');
        check(read.counts.data === 2 && read.counts.info === 0 && read.counts.end === 1 && read.counts.error === 0, 'emulator-datastore-read-stream-events');

        // runQueryStream is an SDK readable over unary query pages. Four rows fit
        // in one page; this checks SDK delivery cancellation, not an HTTP/2 RST.
        const early = datastore.runQueryStream(datastore.createQuery('WgaEmulatorStreams').order('rank'));
        streams.push(early);
        const cancelled = { data: 0, end: 0, close: 0, error: 0 };
        let first;
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { early.destroy(); reject(new Error('WGA_EMULATOR_DESTROY_TIMEOUT')); }, 10000);
            early.on('data', value => {
                cancelled.data++;
                if (cancelled.data === 1) { first = value; early.destroy(); }
            });
            // The native SDK can emit info after destroy; it is not completion.
            // Only later data/end and close/error semantics are constrained here.
            early.on('end', () => { cancelled.end++; });
            early.on('error', error => { cancelled.error++; clearTimeout(timeout); reject(error); });
            early.on('close', () => { cancelled.close++; clearTimeout(timeout); resolve(); });
        });
        // A completed independent RPC gives queued SDK work a chance to run.
        // Listeners remain attached so late events cannot disappear from counts.
        const [stillPresent] = await datastore.get(keys[3]);
        check(stillPresent?.rank === 3, 'emulator-datastore-destroy-does-not-close-client');
        check(first?.rank === 0 && first[datastore.KEY].name === keys[0].name, 'emulator-datastore-destroy-first-entity');
        check(early.destroyed && cancelled.data === 1 && cancelled.end === 0 && cancelled.close === 1 && cancelled.error === 0, 'emulator-datastore-destroy-no-late-delivery');
        return [
            'runQueryStream-four-ordered-entities', 'query-info-cursor-NO_MORE_RESULTS',
            `query-events-data:${queried.counts.data}-info:${queried.counts.info}-end:${queried.counts.end}-error:${queried.counts.error}`,
            'createReadStream-found-missing-key-map',
            `read-events-data:${read.counts.data}-info:${read.counts.info}-end:${read.counts.end}-error:${read.counts.error}`,
            `destroy-events-data:${cancelled.data}-end:${cancelled.end}-close:${cancelled.close}-error:${cancelled.error}`,
            'client-usable-after-destroy', 'verified-delete-cleanup', 'generated-clients-closed',
        ];
    }, () => withCleanup(async () => {
        for (const stream of streams) if (!stream.destroyed) stream.destroy();
        await datastore.delete([...keys, missing]);
        const [remaining] = await datastore.get([...keys, missing]);
        check(remaining.length === 0, 'emulator-datastore-streams-cleanup');
    }, async () => {
        // The pinned high-level SDK has no close(); its cached generated clients do.
        const outcomes = await Promise.allSettled([...datastore.clients_.values()].map(client => client.close()));
        const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
        if (failures.length) throw new AggregateError(failures, 'WGA_DATASTORE_CLIENT_CLEANUP_FAILED');
    }));
}

export const emulatorDatastoreStreamSuite = { sdk: '@google-cloud/datastore', suite: 'datastore-emulator-streams', run };
