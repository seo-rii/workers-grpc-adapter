import { OAuth2Client } from 'google-auth-library';
import { controlledSuites } from './shared/controlled-suites.mjs';

export default {
    async fetch(request) {
        const invocation = new URL(request.url).pathname.slice(1);
        if (!['first', 'second'].includes(invocation)) return new Response('Unknown fixture invocation', { status: 400 });
        const authClient = new OAuth2Client();
        authClient.setCredentials({ access_token: `fixture-shared-${invocation}`, expiry_date: Date.now() + 3600000 });
        const context = {
            options: { projectId: 'wga-local-test', authClient },
            allowedProjectId: 'wga-local-test',
            allowWrites: true,
            runId: '8577e274-468c-4180-becf-63292be12c29',
            secretName: 'projects/wga-local-test/secrets/metadata',
        };
        const results = [];
        for (const { sdk, suite, run } of controlledSuites) {
            try {
                const checks = await run(context);
                results.push({ sdk, suite, status: 'passed', checks });
            } catch (error) {
                results.push({ sdk, suite, status: 'failed', error: { code: error.code ?? null, class: error.constructor?.name || 'Error', message: error.message } });
            }
        }
        const status = results.every(result => result.status === 'passed') ? 'passed' : 'failed';
        return Response.json({ invocation, status, results }, { status: status === 'passed' ? 200 : 500 });
    },
};
