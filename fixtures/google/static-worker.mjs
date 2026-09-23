import { Datastore } from '@google-cloud/datastore';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { OAuth2Client } from 'google-auth-library';
import { Client, credentials, status } from '@grpc/grpc-js';
import { Buffer } from 'node:buffer';
import { protobufFromJSON } from 'google-gax';
import datastoreSchema from '@google-cloud/datastore/build/protos/protos.json';

export default {
  async fetch(request) {
    const stages = ['static-import'];
    const token = new URL(request.url).pathname.slice(1);
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: token, expiry_date: Date.now() + 3600000 });
    stages.push('auth-client');
    if (token === 'fixture-cancel') {
      const client = new Client('cancel.test:443', credentials.combineChannelCredentials(credentials.createSsl(), credentials.createFromGoogleCredential(authClient)));
      try {
        let received = 0;
        const code = await new Promise((resolve, reject) => {
          const call = client.makeServerStreamRequest('/demo.Echo/Wait', () => Buffer.alloc(0), bytes => bytes, {}, { deadline: Date.now() + 5000 });
          call.on('data', () => { received++; call.cancel(); });
          call.on('error', error => { if (error.code !== status.CANCELLED) reject(error); });
          call.on('status', terminal => resolve(terminal.code));
        });
        if (code !== status.CANCELLED || received !== 1) throw new Error('Mid-stream cancellation failed');
        return Response.json({ status: 'passed', cancelled: true, received });
      } finally { client.close(); }
    }
    let datastore, firestore, secretManager;
    const close = () => Promise.all([
      // The pinned high-level Datastore SDK exposes no public close method.
      ...[...(datastore?.clients_?.values() || [])].map(client => client.close()),
      firestore?.terminate(), secretManager?.close(),
    ]);
    try {
      const reflection = protobufFromJSON(datastoreSchema);
      const entityType = reflection.lookupType('google.datastore.v1.Entity');
      const message = entityType.fromObject({ properties: {
        large: { integerValue: '9223372036854775807' },
        bytes: { blobValue: Buffer.from([0, 127, 255]) },
        text: { stringValue: '한글'.repeat(40) },
      } });
      if (!(message instanceof entityType.ctor) || entityType.verify(message) !== null) throw new Error('Static protobuf constructor/verify failed');
      const roundtrip = entityType.toObject(entityType.decode(entityType.encode(message).finish()), { longs: String, bytes: String });
      if (roundtrip.properties.large.integerValue !== '9223372036854775807' || roundtrip.properties.bytes.blobValue !== 'AH//' || roundtrip.properties.text.stringValue !== '한글'.repeat(40)) throw new Error('Static protobuf codec roundtrip failed');
      stages.push('constructor-verify-codecs-reflection');
      datastore = new Datastore({ projectId: 'wga-fixture', authClient, fallback: false });
      stages.push('datastore-constructor');
      firestore = new Firestore({ projectId: 'wga-fixture', authClient, preferRest: false });
      stages.push('firestore-constructor');
      secretManager = new SecretManagerServiceClient({ projectId: 'wga-fixture', authClient, fallback: false });
      stages.push('secret-manager-constructor');
      const key = datastore.key(['StaticBootstrap', 'missing']);
      stages.push('datastore-rpc');
      const [entity] = await datastore.get(key, { gaxOptions: { retry: null, timeout: 5000 } });
      stages.push('firestore-rpc');
      const documents = await firestore.getAll(firestore.doc('bootstrap/missing'));
      if (documents.length !== 1 || documents[0].exists) throw new Error('Unexpected Firestore missing document');
      stages.push('secret-manager-rpc');
      const [secret] = await secretManager.getSecret({ name: 'projects/wga-fixture/secrets/bootstrap' }, { retry: null, timeout: 5000 });
      await close();
      return Response.json({ status: 'passed', entityMissing: entity === undefined, secretName: secret.name, stages });
    } catch (error) {
      await close().catch(() => {});
      return Response.json({ status: 'failed', stages, code: error.code ?? error.name }, { status: 500 });
    }
  },
};
