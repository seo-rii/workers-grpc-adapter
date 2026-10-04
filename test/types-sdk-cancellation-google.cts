import { Datastore, DatastoreClient } from '@google-cloud/datastore';
import type { CallOptions } from 'google-gax';
import { cancellableCall, cancellableQueryStream } from '@grpc/grpc-js/sdk';

type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
declare const datastore: Datastore;
// Legacy v1 is declared as any; the public named export retains the real class.
declare const generated: DatastoreClient;
type GeneratedClientIsTyped = Assert<NotAny<typeof generated>>;
const options: CallOptions = { timeout: 1_000, retry: null };
const commit = cancellableCall(gax => datastore.transaction().commit(gax), { gaxOptions: options });
const transactionTuple: Promise<[unknown]> = commit.promise;
commit.promise.then(([response]) => {
    type Typed = Assert<NotAny<typeof response>>;
    // @ts-expect-error real SDK response retains its object type
    const invalid: number = response;
    void invalid;
});
const unary = cancellableCall(gax => generated.commit({ projectId: 'fixture' }, gax), { gaxOptions: options });
const generatedTuple: Promise<[unknown, unknown, unknown]> = unary.promise;
const direct = generated.commit({ projectId: 'fixture' }, options);
const exactGeneratedTuple: typeof direct = unary.promise;
unary.promise.then(([response, request]) => {
    type Typed = Assert<NotAny<typeof response>>;
    const indexUpdates: number | null | undefined = response.indexUpdates;
    const projectId: string | null | undefined = request?.projectId;
    // @ts-expect-error the generated response retains its protobuf object type
    const invalid: number = response;
    void [indexUpdates, projectId, invalid];
});
const query = datastore.createQuery('Fixture');
const rows = cancellableQueryStream<{ name: string }>(
    gax => datastore.runQueryStream(query, { gaxOptions: gax }),
    { gaxOptions: { timeout: 1_000, retry: null } },
);
async function consume(): Promise<void> {
    for await (const row of rows) {
        type Typed = Assert<NotAny<typeof row>>;
        const name: string = row.name;
        // @ts-expect-error query wrapper keeps declared entity type
        const invalid: number = row.name;
        void [name, invalid]; break;
    }
}
void [transactionTuple, generatedTuple, exactGeneratedTuple, consume];
