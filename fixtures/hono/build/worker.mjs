import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const result = await esbuild.build({
  absWorkingDir: projectRoot, entryPoints: ['src/app.mts'], bundle: true,
  format: 'esm', platform: 'node', target: 'es2022', write: false,
  metafile: true, minify: true, legalComments: 'eof', sourcemap: false,
});
const imports = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)))].sort();
if (imports.some(name => !isBuiltin(name))) throw new Error('The production Worker has an unresolved package dependency');
// A finite, explicit native-module bridge lets esbuild's CommonJS closure use
// Workers nodejs_compat. It cannot resolve any package or read an SDK from disk.
const banner = imports.map((name, i) => `import * as builtin${i} from ${JSON.stringify(name)};`).join('\n')
  + '\nconst builtins={' + imports.map((name, i) => `${JSON.stringify(name)}:builtin${i}.default??builtin${i}`).join(',') + '};\n'
  + "const require=name=>{if(Object.hasOwn(builtins,name))return builtins[name];throw new Error('Unknown native module');};\n";
const source = banner + result.outputFiles[0].text;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'dist/worker.mjs'), source);
fs.writeFileSync(path.join(projectRoot, 'dist/build-manifest.json'), JSON.stringify({
  format: 'esm', esbuild: esbuild.version, nativeImports: imports,
  inputs: Object.keys(result.metafile.inputs).sort(),
  sourceSha256: digest(fs.readFileSync(path.join(projectRoot, 'src/app.mts'))),
  workerSha256: digest(source),
}, null, 2) + '\n');
