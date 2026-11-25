import { inspectGoogleWorkerGraph } from '@grpc/grpc-js/build';
import type { GoogleWorkerGraphInspection, GoogleWorkerGraphOptions } from '@grpc/grpc-js/build';
import * as ts from 'typescript';
const options: GoogleWorkerGraphOptions = { projectRoot: '.', profile: 'google-static-v1', typescript: ts };
const report: GoogleWorkerGraphInspection = inspectGoogleWorkerGraph(options);
const canonical: string | undefined = report.identity.installations[0]?.path;
const compiler: string | undefined = report.buildProfile?.buildIdentity?.transformer.typescriptVersion;
const manager: string | null = report.environment.packageManager;
const packageImport = report.results[0]?.graph?.[0]?.packageImports?.[0];
const importKind: 'require' | 'import' | undefined = packageImport?.kind;
const resolved: string | undefined = packageImport?.resolved;
// @ts-expect-error native baseline is the only supported alternate implementation
inspectGoogleWorkerGraph({ projectRoot: '.', expectedImplementation: 'other' });
// @ts-expect-error a project root is mandatory
inspectGoogleWorkerGraph({ sdks: ['@google-cloud/datastore'] });
void canonical; void compiler; void manager; void importKind; void resolved;
