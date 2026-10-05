'use strict';
// Opt-in lifecycle wrapper. Importing this file never reads credentials or calls a provider.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { planOwnedProject, prepareOwnedProject, cleanupOwnedProject } = require('./gcp-owned-project.cjs');
const { parseSoakSeconds, parseSoakBurst } = require('./gcp-soak.cjs');
const { parseAuthRenewalArgs } = require('./gcp-auth-renewal.cjs');
const root = path.resolve(__dirname, '..');
const codeOf = error => /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code) ? error.code : 'DEDICATED_PROBE_FAILED';
function fail(code) { throw Object.assign(new Error(code), { code }); }

function parseOptions(argv) {
    const required = ['--create-dedicated-project', '--link-unique-billing-account'];
    const switches = [...required, '--catalog', '--grant-owned-token-creator', '--verify-auth-renewal', '--inject-catalog-failure'];
    if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail('DEDICATED_INVALID_OPTIONS');
    const keys = argv.map(value => value.split('=')[0]);
    if (new Set(keys).size !== keys.length || argv.some(value => !switches.includes(value) &&
        !/^--(?:region|soak-seconds|soak-burst)=.+$/.test(value))) fail('DEDICATED_INVALID_OPTIONS');
    if (!required.every(value => argv.includes(value))) fail('DEDICATED_EXPLICIT_PROVISIONING_REQUIRED');
    const region = argv.find(value => value.startsWith('--region='))?.slice(9) || 'asia-northeast3';
    if (!/^[a-z]+-[a-z]+[0-9]$/.test(region)) fail('DEDICATED_INVALID_REGION');
    parseSoakSeconds(argv); parseSoakBurst(argv); parseAuthRenewalArgs(argv);
    if (argv.some(value => ['--grant-owned-token-creator', '--inject-catalog-failure'].includes(value)) &&
        !argv.includes('--catalog')) fail('DEDICATED_CATALOG_REQUIRED');
    return { region, probeArgs: argv.filter(value => !required.includes(value) && !value.startsWith('--region=')) };
}

/** The injected runner must wait for the child, including its cleanup, to exit. */
async function runDedicatedProbe({ options, request, runProbe, persist, plan = planOwnedProject(),
    pause, maxPolls, interrupted = () => false,
    prepare = prepareOwnedProject, cleanup = cleanupOwnedProject }) {
    const receipt = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
        plan, releaseEligible: false, projectCleanup: null, child: null };
    let record;
    let setupCleaned = false;
    persist(receipt); // Persist the plan before the first possible mutation.
    try {
        if (interrupted()) fail('DEDICATED_INTERRUPTED');
        record = await prepare({ request, plan, pause, maxPolls, onOwned(value) {
            record = value; receipt.ownership = value; persist(receipt);
        } });
        if (interrupted()) fail('DEDICATED_INTERRUPTED');
        const child = await runProbe(['--deploy-temporary', `--project=${record.projectId}`,
            `--region=${options.region}`, '--dedicated-project', ...options.probeArgs]);
        const report = child?.report;
        // Never accept an old report from a prior probe or another project.
        if (!Number.isInteger(child?.exitCode) || !report || report.project !== record.projectId ||
            String(report.projectNumber) !== record.name.slice('projects/'.length) ||
            report.dedicatedProject !== true || typeof report.run !== 'string') fail('DEDICATED_CHILD_RECEIPT_INVALID');
        receipt.child = { run: report.run, exitCode: child.exitCode,
            allCreatedResourcesDeleted: report.allCreatedResourcesDeleted === true,
            existingResourcesUnchanged: report.existingResourcesUnchanged === true };
        persist(receipt);
        if (!receipt.child.allCreatedResourcesDeleted || !receipt.child.existingResourcesUnchanged)
            fail('DEDICATED_CHILD_CLEANUP_FAILED');
        if (child.exitCode !== 0) fail('DEDICATED_CHILD_FAILED');
        if (interrupted()) fail('DEDICATED_INTERRUPTED');
    } catch (error) {
        receipt.error = codeOf(error);
        if (/^operations\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(error.operationName))
            receipt.creationOperation = error.operationName;
        setupCleaned = error.cleanupCompleted === true;
        if (setupCleaned) receipt.projectCleanup = { status: 'delete-requested', billingUnlinked: true,
            state: 'DELETE_REQUESTED', finalDeletionPending: true, completedDuringSetupFailure: true };
        if (error.setupCode) receipt.setupError = codeOf({ code: error.setupCode });
        if (error.cleanupCode) receipt.setupCleanupError = codeOf({ code: error.cleanupCode });
    } finally {
        // The child owns all CF/GCP probe resources; its deletion results remain
        // separate from project shutdown, which cannot remove a CF Worker.
        if (record && !setupCleaned) {
            try { receipt.projectCleanup = await cleanup({ request, record, pause, maxPolls }); }
            catch (error) { receipt.projectCleanup = { status: 'failed', error: codeOf(error) }; }
        }
        receipt.status = !receipt.error && receipt.projectCleanup?.status === 'delete-requested' ? 'passed' : 'failed';
        receipt.finishedAt = new Date().toISOString();
        persist(receipt);
    }
    return receipt;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseOptions(argv); // All option guards precede credentials and network.
    if (!(process.env.CF_TOKEN || process.env.CLOUDFLARE_API_TOKEN)) fail('DEDICATED_CF_CREDENTIAL_REQUIRED');
    const plan = planOwnedProject();
    const directory = path.join(root, '.wga-build/gcp-dedicated', plan.projectId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
    const receiptFile = path.join(directory, 'receipt.json');
    const persist = value => {
        fs.writeFileSync(receiptFile, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        fs.chmodSync(receiptFile, 0o600);
    };
    let token, tokenAt = 0, interrupted = false, child;
    const onSignal = () => { interrupted = true; child?.kill('SIGTERM'); };
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    const request = async (url, method, body) => {
        // On interruption only reads and owned cleanup writes can continue.
        if (interrupted && method !== 'GET' && method !== 'DELETE' &&
            !(method === 'PUT' && body?.billingAccountName === '')) fail('DEDICATED_INTERRUPTED');
        if (!token || Date.now() - tokenAt > 120000) {
            const result = spawnSync('gcloud', ['auth', 'print-access-token', '--quiet'],
                { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
            if (result.status !== 0 || !result.stdout.trim()) fail('DEDICATED_CREDENTIAL_FAILED');
            token = result.stdout.trim(); tokenAt = Date.now();
        }
        const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(45000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        let data;
        try { data = await response.json(); } catch { data = null; }
        return { status: response.status, data };
    };
    const runProbe = args => new Promise((resolve, reject) => {
        child = spawn(process.execPath, [path.join(__dirname, 'gcp-cloud-probe.cjs'), ...args],
            { cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
        child.once('error', () => reject(Object.assign(new Error('DEDICATED_CHILD_START_FAILED'), { code: 'DEDICATED_CHILD_START_FAILED' })));
        child.once('close', exitCode => {
            child = undefined;
            let report;
            try { report = JSON.parse(fs.readFileSync(path.join(root, 'verification/gcp-cloud-probe.json'), 'utf8')); }
            catch { /* Missing/invalid receipts fail in the coordinator. */ }
            resolve({ exitCode, report });
        });
    });
    try {
        const result = await runDedicatedProbe({ options, request, runProbe, persist, plan, interrupted: () => interrupted });
        console.log(JSON.stringify({ status: result.status, receipt: path.relative(root, receiptFile),
            projectCleanup: result.projectCleanup?.status || 'unproven', releaseEligible: false }));
        if (result.status !== 'passed') process.exitCode = 1;
    } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
}

module.exports = { parseOptions, runDedicatedProbe };
if (require.main === module) main().catch(error => { console.error(codeOf(error)); process.exitCode = 1; });
