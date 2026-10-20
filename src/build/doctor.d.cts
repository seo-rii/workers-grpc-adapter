import type { GoogleWorkerProfile, GoogleWorkerProfileInspection } from './index.cjs';
export interface GoogleWorkerGraphOptions {
  projectRoot: string;
  /** SDK package entry points; defaults to the three reviewed Google SDKs. */
  sdks?: string[];
  expectedImplementation?: 'workers-grpc-adapter' | '@grpc/grpc-js';
  profile?: GoogleWorkerProfile;
  /** Adds AST checks; omission is reported as transformationsChecked: false. */
  typescript?: typeof import('typescript');
}
export interface GoogleWorkerGraphPackage {
  name: string;
  version: string;
  /** Canonical installation path relative to projectRoot. */
  path: string;
  integrity: string | null;
  dependencies: Array<{ name: string; path?: string; missing?: boolean; optional?: boolean }>;
  grpcImports: Array<{ file: string; specifier: string; kind: 'require' | 'import' | 'declaration'; resolved?: string; implementation?: string; version?: string; status: string }>;
}
export interface GoogleWorkerGraphInspection {
  scope: string;
  passed: boolean;
  expectedImplementation: 'workers-grpc-adapter' | '@grpc/grpc-js';
  environment: { node: string; platform: string; arch: string; packageManager: string | null };
  lockfiles: Array<{ path: string; sha256: string }>;
  lockfileVersion: number | null;
  lockfileSha256: string | null;
  graphSha256: string;
  identity: {
    status: 'duplicate-installations' | 'single-installation' | 'not-installed';
    installations: Array<{ path: string; version: string; resolvedBy: Array<{ consumer: string; specifier: string }> }>;
  };
  diagnostics: Array<{ code: string; message: string; paths: string[] }>;
  results: Array<{
    sdk: string; version?: string; status: string; reason?: string;
    graph?: GoogleWorkerGraphPackage[];
    gax?: Array<{ path: string; version: string }>;
    grpc?: Array<{ path: string; implementation: string; version: string }>;
    grpcImportCount?: number;
    prerelease?: Array<{ name: string; version: string; expected: boolean }>;
    unresolved?: string[];
  }>;
  buildProfile?: GoogleWorkerProfileInspection;
}
/** Does not execute inspected modules, authenticate, fetch, or modify dependencies. */
export declare function inspectGoogleWorkerGraph(options: GoogleWorkerGraphOptions): GoogleWorkerGraphInspection;
