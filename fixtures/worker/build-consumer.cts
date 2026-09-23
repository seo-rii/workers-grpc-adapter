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
