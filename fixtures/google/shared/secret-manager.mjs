import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { check, withCleanup } from './assert.mjs';
// Read-only: never exports/logs a secret payload and does not create or delete secrets.
export async function secretManagerRead(context) {
    check(typeof context.secretName === 'string' &&
        /^projects\/[^/]+\/secrets\/[^/]+$/.test(context.secretName), 'secret-name-required');
    check(context.secretName.split('/')[1] === context.allowedProjectId, 'secret-project-mismatch');
    const client = new SecretManagerServiceClient({ ...context.options, fallback: false });
    return withCleanup(async () => {
        const [secret] = await client.getSecret({ name: context.secretName }, { timeout: 10000 });
        check(secret.name === context.secretName, 'secret-manager-get');
        return ['getSecret'];
    }, () => client.close());
}
