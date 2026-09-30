'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventory, compareInventory } = require('../scripts/export-inventory.cjs');

function fixture(t, files) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-export-inventory-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const write = changes => {
        for (const [name, text] of Object.entries(changes)) {
            const file = path.join(directory, name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text);
        }
    };
    write(files);
    return { directory, write, read: () => inventory({ entry: path.join(directory, 'index.d.ts'), packageRoot: directory }) };
}

function exported(result, name) {
    const record = result.exports.find(value => value.name === name);
    assert.ok(record, `missing export ${name}`);
    return record;
}

test('export inventory resolves aliases while distinguishing erased types and type-only class reexports', t => {
    const project = fixture(t, {
        'index.d.ts': `export { Actual as Client, Shape } from './types';
            export type { Actual as ClientType } from './types';
            export { Indirect } from './reexport';
            export { Shape as ShapeAlias } from './types';`,
        'types.d.ts': 'export declare class Actual { send(value: string): number; } export interface Shape { value: string; }',
        'reexport.d.ts': "export type { Actual as Indirect } from './types';",
    });
    const result = project.read();
    assert.deepEqual(result.exports.map(({ name, type, value }) => ({ name, type, value })), [
        { name: 'Client', type: true, value: true }, { name: 'ClientType', type: true, value: false },
        { name: 'Indirect', type: true, value: false }, { name: 'Shape', type: true, value: false },
        { name: 'ShapeAlias', type: true, value: false },
    ]);
    assert.match(exported(result, 'Client').signature, /send\(value: string\): number/);
    assert.equal(exported(result, 'Client').signature, exported(result, 'ClientType').signature);
});

test('export inventory detects overload, static and instance member, heritage, enum and object API drift', t => {
    const initial = `export declare function request(value: string): number;
        export declare function request(value: number): string;
        export declare class Base { protected state: number; }
        export declare class Client extends Base { static create(value: string): Client; send(value: string): number; }
        export declare enum State { Idle = 0, Ready = 1 }
        export declare const credentials: { create(token: string): Client; };`;
    const project = fixture(t, { 'index.d.ts': initial });
    const before = project.read();
    assert.match(exported(before, 'request').signature, /value: string[\s\S]*value: number/);
    assert.match(exported(before, 'Client').signature, /extends Base[\s\S]*static create[\s\S]*send/);
    project.write({ 'index.d.ts': initial.replace('value: number): string', 'value: number): boolean')
        .replace('static create(value: string)', 'static create(value: Uint8Array)')
        .replace('send(value: string): number', 'send(value: string): void')
        .replace('protected state: number', 'protected state: boolean')
        .replace('Ready = 1', 'Ready = 2').replace('create(token: string)', 'create(token: Uint8Array)') });
    const comparison = compareInventory(before, project.read());
    assert.deepEqual(comparison.changed, ['Base', 'Client', 'credentials', 'request', 'State'].sort());
    assert.deepEqual(comparison.same, []);
});

test('export inventory follows nested named aliases and recursive declaration dependencies', t => {
    const project = fixture(t, {
        'index.d.ts': "import { Input } from './types'; export declare function invoke(value: Input): void;",
        'types.d.ts': 'export interface Input { options: Options; next?: Input; } type Options = { retry: Policy }; interface Policy { attempts: number; parent?: Input; }',
    });
    const before = project.read();
    const dependencies = exported(before, 'invoke').dependencies;
    assert.ok(dependencies.some(item => item.name === 'types.d.ts#Options'));
    assert.ok(dependencies.some(item => item.name === 'types.d.ts#Policy'));
    assert.equal(new Set(dependencies.map(item => item.name)).size, dependencies.length);
    project.write({ 'types.d.ts': 'export interface Input { options: Options; next?: Input; } type Options = { retry: Policy }; interface Policy { attempts: string; parent?: Input; }' });
    const after = project.read();
    assert.equal(exported(before, 'invoke').signature, exported(after, 'invoke').signature);
    assert.deepEqual(compareInventory(before, after).changed, ['invoke']);
});

test('export inventory ignores comments, whitespace and private members but preserves constructor accessibility', t => {
    const project = fixture(t, {
        'index.d.ts': 'export declare class Client { private cache; #token; private refresh(): void; private constructor(); send(value: string): void; }',
    });
    const before = project.read();
    assert.doesNotMatch(exported(before, 'Client').signature, /cache|token|refresh/);
    project.write({ 'index.d.ts': `/** New documentation */ export declare class Client {
        private changed: Map<string, number>; #secret; private refresh(value: Date): string;
        private constructor(); // Keep inaccessible
        send( value : string ) : void;
    }` });
    const after = project.read();
    assert.deepEqual(compareInventory(before, after).same, ['Client']);
    assert.notEqual(before.sources[0].sha256, after.sources[0].sha256);
    project.write({ 'index.d.ts': 'export declare class Client { protected constructor(); send(value: string): void; }' });
    assert.deepEqual(compareInventory(after, project.read()).changed, ['Client']);
});

test('export inventory fingerprints type aliases and public protected members without including private dependencies', t => {
    const project = fixture(t, {
        'index.d.ts': "import { Internal, Public } from './types'; export type Alias = { value: Public }; export declare class Client { private hidden: Internal; protected visible: Public; }",
        'types.d.ts': 'export interface Internal { secret: string; } export interface Public { value: string; }',
    });
    const before = project.read();
    assert.ok(exported(before, 'Alias').type);
    assert.equal(exported(before, 'Alias').value, false);
    assert.ok(exported(before, 'Client').dependencies.some(value => value.name.endsWith('#Public')));
    assert.ok(!exported(before, 'Client').dependencies.some(value => value.name.endsWith('#Internal')));
    project.write({ 'types.d.ts': 'export interface Internal { secret: Uint8Array; } export interface Public { value: string; }' });
    assert.deepEqual(compareInventory(before, project.read()).same, ['Alias', 'Client']);
    project.write({ 'types.d.ts': 'export interface Internal { secret: Uint8Array; } export interface Public { value: number; }' });
    assert.deepEqual(compareInventory(before, project.read()).changed, ['Alias', 'Client']);
});

test('export inventory records bounded external references and portable deterministic source hashes', t => {
    const files = {
        'index.d.ts': "import { External } from 'external-api'; export declare function consume(value: External): Promise<void>;",
        'node_modules/external-api/package.json': JSON.stringify({ name: 'external-api', types: 'index.d.ts' }),
        'node_modules/external-api/index.d.ts': 'export interface External { nested: { deliberatelyUnexpanded: string }; }',
    };
    const first = fixture(t, files);
    const second = fixture(t, files);
    const before = first.read();
    assert.deepEqual(before, second.read());
    assert.deepEqual(before.sources.map(value => value.file), ['index.d.ts']);
    const external = exported(before, 'consume').dependencies.find(value => value.name.startsWith('external-api/'));
    assert.deepEqual(external, { name: 'external-api/index.d.ts#External', kind: 'external', signature: 'external-api/index.d.ts#External' });
    assert.ok(!JSON.stringify(before).includes(first.directory));
    assert.ok(!JSON.stringify(before).includes('deliberatelyUnexpanded'));
    first.write({ 'node_modules/external-api/index.d.ts': 'export interface External { intentionallyOutsidePackageFingerprint: number; }' });
    assert.deepEqual(compareInventory(before, first.read()).same, ['consume']);
});

test('export inventory expands public namespace exports without leaking unexported declarations', t => {
    const project = fixture(t, {
        'index.d.ts': "import * as experimental from './namespace'; export { experimental };",
        'namespace.d.ts': 'interface Hidden { hidden: string; } export interface Input { value: string; } export declare function invoke(value: Input): void; export {};',
    });
    const before = project.read();
    assert.ok(exported(before, 'experimental').value);
    assert.doesNotMatch(JSON.stringify(before), /Hidden|hidden: string/);
    project.write({ 'namespace.d.ts': 'interface Hidden { hidden: number; } export interface Input { value: number; } export declare function invoke(value: Input): void; export declare const added: boolean; export {};' });
    assert.deepEqual(compareInventory(before, project.read()).changed, ['experimental']);
});

test('export inventory comparison reports every added, removed, changed and identical export deterministically', t => {
    const project = fixture(t, { 'index.d.ts': 'export type Removed = string; export type Changed = number; export type Same = boolean;' });
    const before = project.read();
    project.write({ 'index.d.ts': 'export type Same = boolean; export type Added = string; export type Changed = string;' });
    const after = project.read();
    assert.deepEqual(compareInventory(before, after), { added: ['Added'], removed: ['Removed'], changed: ['Changed'], same: ['Same'] });
    assert.deepEqual(compareInventory(after, before), { added: ['Removed'], removed: ['Added'], changed: ['Changed'], same: ['Same'] });
});

test('export inventory never executes runtime modules during declaration inspection', t => {
    const project = fixture(t, {
        'index.d.ts': "export { Thing } from './runtime';",
        'runtime.d.ts': 'export declare class Thing { value: string; }',
        'runtime.js': 'throw new Error("runtime execution forbidden");',
    });
    assert.equal(exported(project.read(), 'Thing').value, true);
});

test('export inventory retains unqualified import types and distinct nested namespace declarations', t => {
    const project = fixture(t, {
        'index.d.ts': "export type Module = typeof import('./namespace');",
        'namespace.d.ts': 'export namespace First { interface Input { value: string; } } export namespace Second { interface Input { value: number; } }',
    });
    const before = project.read();
    const dependencies = exported(before, 'Module').dependencies;
    assert.ok(dependencies.some(value => value.name.endsWith('#First.Input')));
    assert.ok(dependencies.some(value => value.name.endsWith('#Second.Input')));
    assert.ok(!JSON.stringify(before).includes(project.directory));
    project.write({ 'namespace.d.ts': 'export namespace First { interface Input { value: boolean; } } export namespace Second { interface Input { value: number; } }' });
    assert.deepEqual(compareInventory(before, project.read()).changed, ['Module']);
});
