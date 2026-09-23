export interface GoogleWorkerBuildOptions {
  projectRoot: string;
  outdir: string;
  profile?: 'google-static-v1';
  typescript: typeof import('typescript');
}
export declare function createGoogleWorkerBuild(options: GoogleWorkerBuildOptions): {
  plugin: import('esbuild').Plugin;
  registryFile: string;
  manifest(): object;
};
