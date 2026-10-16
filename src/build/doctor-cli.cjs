#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { inspectGoogleWorkerGraph } = require('./doctor.cjs');
const usage = 'Usage: wga-doctor [projectRoot] [report.json] [--profile=google-static-v1|google-modern-v1] [--sdk=package-name]';
function main(args, defaults = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
    const positional = args.filter(arg => !arg.startsWith('--'));
    const profiles = args.filter(arg => arg.startsWith('--profile='));
    const sdks = args.filter(arg => arg.startsWith('--sdk=')).map(arg => arg.slice(6));
    if (positional.length > 2 || profiles.length > 1 || sdks.some(name => !name)
      || args.some(arg => arg.startsWith('--') && !arg.startsWith('--profile=') && !arg.startsWith('--sdk='))) throw new Error(usage);
    const projectRoot = path.resolve(positional[0] || defaults.projectRoot || process.cwd());
    const profile = profiles[0]?.slice(10) ?? (positional.length ? undefined : defaults.profile);
    if (profiles.length && !profile) throw new Error(usage);
    let typescript;
    if (profile) {
      try { typescript = createRequire(path.join(projectRoot, 'package.json'))('typescript'); }
      catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        throw new Error('WGA_UNSUPPORTED_DEPENDENCY: profile AST inspection requires TypeScript >=5.8 <6 in the inspected build workspace');
      }
    }
    const report = inspectGoogleWorkerGraph({ projectRoot, ...(sdks.length ? { sdks } : {}), profile, typescript });
    if (positional[1]) {
      const descriptor = fs.openSync(path.resolve(positional[1]), 'w', 0o600);
      try { fs.fchmodSync(descriptor, 0o600); fs.writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n'); }
      finally { fs.closeSync(descriptor); }
    }
    console.log(JSON.stringify(positional[1] ? { ...report,
      results: report.results.map(({ graph, ...item }) => ({ ...item, packageCount: graph?.length ?? 0 })),
    } : report, null, 2));
    return report.passed ? 0 : 2;
  } catch (error) { console.error(error.message); return 2; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
