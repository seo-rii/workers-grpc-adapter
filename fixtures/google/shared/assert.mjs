/** Assertions shared by Node and Workers; no framework or runtime-specific imports. */
export function check(condition, id) {
    if (!condition) {
        throw Object.assign(new Error(id), { code: 'WGA_FIXTURE_ASSERTION' });
    }
}
export function fixtureId(value) {
    check(typeof value === 'string' && /^[a-z0-9_-]{8,64}$/.test(value), 'invalid-fixture-id');
    return value;
}
export function requireWrites(context) {
    check(context.allowWrites === true, 'writes-not-explicitly-enabled');
    check(context.options.projectId === context.allowedProjectId && !!context.allowedProjectId, 'test-project-mismatch');
    fixtureId(context.runId);
}
/** Keep cleanup failure visible without silently replacing the original test failure. */
export async function withCleanup(work, cleanup) {
    let primary, result, failed = false;
    try {
        result = await work();
    }
    catch (error) {
        primary = error;
        failed = true;
    }
    try {
        await cleanup();
    }
    catch (error) {
        if (failed) {
            throw new AggregateError([primary, error], 'WGA_TEST_AND_CLEANUP_FAILED');
        }
        throw error;
    }
    if (failed) {
        throw primary;
    }
    return result;
}
