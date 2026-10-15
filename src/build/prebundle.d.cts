import type { GoogleWorkerProfile } from './index.cjs';

export interface GoogleWorkerPrebundleOptions {
  projectRoot: string;
  /** Must be absent or empty. Replace a previous artifact only after success. */
  outdir: string;
  typescript: typeof import('typescript');
  esbuild: typeof import('esbuild');
  /** ES module wrapper, resolved relative to projectRoot. */
  entryPoint: string;
  /** Exact public value exports of the wrapper. Default exports are unsupported. */
  exports: string[];
  /** Copied to index.d.ts; referenced SDK types must remain installed for tsc. */
  declarationFile: string;
  packageName?: string;
  profile?: GoogleWorkerProfile;
}
export interface GoogleWorkerPrebundleResult {
  outdir: string;
  packageJsonPath: string;
  manifestPath: string;
  bundlePath: string;
  typesPath: string;
  profileId: GoogleWorkerProfile;
  exports: string[];
}
/** Generates one owned SDK/adapter/configuration closure for server imports. */
export declare function buildGoogleWorkerPrebundle(options: GoogleWorkerPrebundleOptions): Promise<GoogleWorkerPrebundleResult>;
