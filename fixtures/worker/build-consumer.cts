import { createGoogleWorkerBuild } from '@grpc/grpc-js/build';
import * as ts from 'typescript';
import type { BuildOptions, Plugin } from 'esbuild';

const preset = createGoogleWorkerBuild({
  projectRoot: '.',
  outdir: './generated',
  profile: 'google-static-v1',
  typescript: ts,
});
const plugin: Plugin = preset.plugin;
const options: BuildOptions = { plugins: [plugin], platform: 'node', format: 'cjs' };
void options;
void preset.manifest();

import { inspectGoogleWorkerProfile } from '@grpc/grpc-js/build';
import type { GoogleWorkerBuildIdentity, GoogleWorkerProfileDiagnostic, GoogleWorkerProfileInspection } from '@grpc/grpc-js/build';
const identity: GoogleWorkerBuildIdentity = preset.manifest();
const cacheKey: string = identity.cacheKey;
const compilerVersion: string = identity.transformer.typescriptVersion;
const inspection: GoogleWorkerProfileInspection = inspectGoogleWorkerProfile({
  projectRoot: '.', profile: 'google-modern-v1', typescript: ts,
});
const checked: boolean = inspection.transformationsChecked;
const diagnostic: GoogleWorkerProfileDiagnostic | undefined = inspection.diagnostics[0];
if (diagnostic) { const actual: unknown = diagnostic.actual; void actual; }
inspectGoogleWorkerProfile({ projectRoot: '.' });
// @ts-expect-error unknown dependency graphs require a reviewed profile
inspectGoogleWorkerProfile({ projectRoot: '.', profile: 'any-latest-sdk' });
// @ts-expect-error the AST compiler must be the TypeScript module
inspectGoogleWorkerProfile({ projectRoot: '.', typescript: {} });
void cacheKey; void compilerVersion; void checked;
