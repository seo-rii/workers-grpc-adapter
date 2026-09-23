// These error assertions run unchanged in the native and actual workerd consumers.
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { check, withCleanup } from './assert.mjs';
async function secretManagerError(context, suffix, code) {
    const client = new SecretManagerServiceClient({ ...context.options, fallback: false });
    return withCleanup(async () => {
        let received;
        try {
            await client.getSecret({ name: `projects/${context.allowedProjectId}/secrets/${suffix}` }, { timeout: 3000, retry: null });
        } catch (error) {
            received = error;
        }
        check(received?.code === code, `secret-manager-${suffix}-code`);
        check(received.details === `controlled ${suffix}`, `secret-manager-${suffix}-details`);
        return [`status:${code}`, `details:controlled ${suffix}`];
    }, () => client.close());
}
export function secretManagerMissing(context) {
    return secretManagerError(context, 'missing', 5);
}
export function secretManagerDenied(context) {
    return secretManagerError(context, 'denied', 7);
}
