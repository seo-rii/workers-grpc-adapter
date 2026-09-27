'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { compile, toolchain } = require('./toolchain.cjs');
const { ts } = toolchain();
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-types-'));
const target = path.join(dir, 'node_modules/@grpc');
fs.mkdirSync(target, { recursive: true });
fs.symlinkSync(root, path.join(target, 'grpc-js'), 'dir');
const source = `import { Client, Metadata, credentials, status } from '@grpc/grpc-js';
import { Client as DeepClient } from '@grpc/grpc-js/build/src/client';
import { configureWorkersGrpc, WorkersGrpcConfig } from '@grpc/grpc-js/config';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { Buffer } from 'node:buffer';
const config: WorkersGrpcConfig = {mode:'grpc-web',endpoints:{'example.test':'https://gateway.test'}};
configureWorkersGrpc(config);
const factory = createWorkersGrpcTransport(config);
const client:DeepClient = new Client('example.test',credentials.createSsl(),factory.grpcOptions());
const ser=(value:{text:string})=>Buffer.from(value.text);
const de=(bytes:Buffer)=>({text:bytes.toString()});
client.makeUnaryRequest('/example.Echo/Unary',ser,de,{text:'x'},new Metadata(),{deadline:Infinity},(err,value)=>{if(err){const n:number=err.code;}else{const s:string|undefined=value?.text;}});
client.makeServerStreamRequest('/example.Echo/Stream',ser,de,{text:'x'});
// @ts-expect-error endpoints cannot be used with cloudflare mode
configureWorkersGrpc({mode:'cloudflare',endpoints:{'example.test':'https://gateway.test'}});
// @ts-expect-error a unary callback is required
client.makeUnaryRequest('/example.Echo/Unary',ser,de,{text:'x'});
// @ts-expect-error -bin values still use the public MetadataValue type, not arbitrary objects
new Metadata().set('x', {foo:1});
`;
const results = [];
try {
    for (const [name, module, moduleResolution] of [['node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16], ['nodenext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext], ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler]]) {
        const legacySource = fs.readFileSync(path.join(root, 'test/types-legacy-google-auth.cts'), 'utf8');
        const files = ['consumer.mts', 'consumer.cts', 'legacy.mts', 'legacy.cts'].map(n => {
            const file = path.join(dir, n);
            fs.writeFileSync(file, n.startsWith('legacy.') ? legacySource : source);
            return file;
        });
        compile({ module, moduleResolution, noEmit: true, declaration: false, rootDir: dir }, files);
        results.push({ mode: name, status: 'passed', skipLibCheck: false, strict: true });
    }
    fs.writeFileSync(path.join(root, 'verification/types.json'), JSON.stringify({ scope: 'prototype API declarations, not Google SDK types', results }, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
