export type GoogleWorkerProfile = 'google-static-v1' | 'google-modern-v1';
export { buildGoogleWorkerPrebundle, type GoogleWorkerPrebundleOptions, type GoogleWorkerPrebundleResult } from './prebundle.cjs';
export interface GoogleWorkerBuildOptions {
  projectRoot: string;
  outdir: string;
  profile?: GoogleWorkerProfile;
  typescript: typeof import('typescript');
}
export interface GoogleWorkerProfileDiagnostic {
  kind: string;
  path: string;
  expected: unknown;
  actual: unknown;
  rule?: string;
  reason?: string;
  logicalPath?: string;
  physicalPath?: string | null;
  importer?: string;
}
export interface GoogleWorkerResolvedPath {
  path: string;
  logicalPath: string;
  physicalPath: string;
}
export interface GoogleWorkerTransformCoverage {
  required: number;
  applied: number;
  unused: number;
  passed: boolean;
}
export interface GoogleWorkerBuildIdentity {
  cacheKey: string;
  inputSha256: string;
  transformer: { version: number; sha256: string; typescriptVersion: string };
}
export interface GoogleWorkerProfileInspection {
  profile: GoogleWorkerProfile;
  revision: number;
  passed: boolean;
  scope: string;
  transformationsChecked: boolean;
  diagnostics: GoogleWorkerProfileDiagnostic[];
  capabilities: string[];
  requiredChecks: string[];
  buildIdentity?: GoogleWorkerBuildIdentity;
  resolvedPaths: GoogleWorkerResolvedPath[];
}
export declare function createGoogleWorkerBuild(options: GoogleWorkerBuildOptions): {
  plugin: import('esbuild').Plugin;
  /** Opaque content-addressed path; distinct build identities can share outdir. */
  registryFile: string;
  /** Verify actual bundle inputs; inspection alone never establishes coverage. */
  verifyBuild(metafile: import('esbuild').Metafile, workingDirectory?: string): GoogleWorkerTransformCoverage;
  manifest(): GoogleWorkerBuildIdentity & {
    profile: GoogleWorkerProfile;
    revision: number;
    profileSha256: string;
    capabilities: string[];
    requiredChecks: string[];
    resolvedPaths: GoogleWorkerResolvedPath[];
    transformCoverage: GoogleWorkerTransformCoverage;
    [field: string]: unknown;
  };
};
/** Passing TypeScript additionally checks every declared AST transformation. */
export declare function inspectGoogleWorkerProfile(options: {
  projectRoot: string;
  profile?: GoogleWorkerProfile;
  typescript?: typeof import('typescript');
}): GoogleWorkerProfileInspection;

export { inspectGoogleWorkerGraph } from './doctor.cjs';
export type { GoogleWorkerGraphOptions, GoogleWorkerGraphInspection, GoogleWorkerGraphPackage } from './doctor.cjs';
