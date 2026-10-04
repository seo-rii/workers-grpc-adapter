import { cancellableCall, cancellableQueryStream, type CancellableCall, type SdkQueryStream, type SdkCancellationOptions } from '@grpc/grpc-js/sdk';
import { Readable, Transform } from 'node:stream';

type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
interface CallOptions { timeout?: number; otherArgs?: { [key: string]: unknown }; }
declare const sdk: {
    commit(request: { id: string }, options?: CallOptions): Promise<[ { applied: boolean }, { requestId: string } ]>;
    query(options?: { gaxOptions?: CallOptions }): Transform;
};
const controller = new AbortController();
const options: CallOptions = { timeout: 1000, otherArgs: { headers: { 'x-example': 'kept' } } };
const call = cancellableCall(gaxOptions => sdk.commit({ id: 'example' }, gaxOptions), { gaxOptions: options, signal: controller.signal });
const same: CancellableCall<[{ applied: boolean }, { requestId: string }]> = call;
const exact: Promise<[{ applied: boolean }, { requestId: string }]> = call.promise;
type ResultIsTyped = Assert<NotAny<Awaited<typeof call.promise>>>;
call.promise.then(([result, info]) => { const applied: boolean = result.applied; const id: string = info.requestId; void [applied, id]; });
call.cancel();
const noOptions = cancellableCall(gaxOptions => sdk.commit({ id: 'default-options' }, gaxOptions));
const literalOptions = cancellableCall(gaxOptions => sdk.commit({ id: 'literal-options' }, gaxOptions), { gaxOptions: { timeout: 10 } });
const structural: SdkCancellationOptions<CallOptions> = { gaxOptions: options };
const stream = cancellableQueryStream<{ name: string }>(gaxOptions => sdk.query({ gaxOptions }), { signal: controller.signal, highWaterMark: 2 });
const explicitItemWithOptions = cancellableQueryStream<{ name: string }>(gaxOptions => sdk.query({ gaxOptions }), {
    gaxOptions: { timeout: 1000, retry: null },
});
const typed: SdkQueryStream<{ name: string }> = stream;
const readable: Readable = stream;
const value: { name: string } | null = stream.read();
type ReadIsTyped = Assert<NotAny<ReturnType<typeof stream.read>>>;
async function consume(): Promise<void> {
    for await (const row of stream) {
        type RowIsTyped = Assert<NotAny<typeof row>>;
        const name: string = row.name;
        // @ts-expect-error query item is not any
        const number: number = row.name;
        void [name, number]; break;
    }
    for await (const row of stream.iterator()) {
        const name: string = row.name;
        // @ts-expect-error alternate iterator preserves the same item type
        const number: number = row.name;
        void [name, number];
    }
}
// @ts-expect-error source end() is required to stop pinned Datastore pagination
cancellableQueryStream(() => Readable.from([]));
// @ts-expect-error call factory must return a promise-like result
cancellableCall(() => 42);
// @ts-expect-error signal must be an AbortSignal
cancellableCall(() => Promise.resolve(), { signal: {} });
// @ts-expect-error queue is a numeric object count
cancellableQueryStream(() => new Transform(), { highWaterMark: '2' });
void [same, exact, noOptions, literalOptions, structural, explicitItemWithOptions, typed, readable, value, consume];
