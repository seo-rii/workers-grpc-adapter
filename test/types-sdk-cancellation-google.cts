import { Datastore, v1 } from '@google-cloud/datastore';
import type { CallOptions } from 'google-gax';
import { cancellableCall, cancellableQueryStream } from '@grpc/grpc-js/sdk';

type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
declare const datastore: Datastore;
declare const generated: v1.DatastoreClient;
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
void [transactionTuple, generatedTuple, consume];
