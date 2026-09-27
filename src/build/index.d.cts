export type GoogleWorkerProfile = 'google-static-v1' | 'google-modern-v1';
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
}
export declare function createGoogleWorkerBuild(options: GoogleWorkerBuildOptions): {
  plugin: import('esbuild').Plugin;
  registryFile: string;
  manifest(): GoogleWorkerBuildIdentity & {
    profile: GoogleWorkerProfile;
    revision: number;
    profileSha256: string;
    capabilities: string[];
    requiredChecks: string[];
    [field: string]: unknown;
  };
};
/** Passing TypeScript additionally checks every declared AST transformation. */
export declare function inspectGoogleWorkerProfile(options: {
  projectRoot: string;
  profile?: GoogleWorkerProfile;
  typescript?: typeof import('typescript');
}): GoogleWorkerProfileInspection;
