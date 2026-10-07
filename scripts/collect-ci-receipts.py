#!/usr/bin/env python3
"""Collect the CI artifact without dropping transport bundle license notices."""
import argparse
import os
from pathlib import Path
import tarfile

os.umask(0o077)
parser = argparse.ArgumentParser(description="Collect local CI receipts and transport bundle notices.")
parser.add_argument("--root", type=Path, default=Path.cwd())
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--log-dir", type=Path, default=Path.home() / "logs")
args = parser.parse_args()
root = args.root.resolve()
archive = args.output.resolve()
reports = root / 'verification'
generated = ['exports-contract.json', 'google-graph.json', 'google-native-graph.json',
             'google-local.json', 'google-types.json']
notice_paths = {'transport-benchmark/LICENSE', 'transport-benchmark/NOTICE',
                'transport-benchmark/vendor/LICENSE', 'transport-benchmark/vendor/NOTICE'}
bundle_paths = {'transport-benchmark/client.mjs', 'transport-benchmark/client.mjs.gz',
                'transport-benchmark/esbuild-metafile.json'}
if any((reports / name).exists() or (reports / name).is_symlink() for name in bundle_paths):
    for name in sorted(bundle_paths | notice_paths):
        file = reports / name
        if not file.is_file() or file.is_symlink():
            raise ValueError(f"Incomplete transport bundle distribution: {name}")
archive.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive, 'w:gz') as output:
    if reports.is_dir():
        for file in sorted(reports.rglob('*')):
            generated_contract = file.relative_to(reports).parts[0] in {'api-contracts', 'type-contracts'}
            generated_benchmark = file.relative_to(reports).parts[0] == 'transport-benchmark'
            generated_documentation = file.relative_to(reports).parts[0] == 'doc-examples'
            if file.is_file() and not file.is_symlink() and (file.suffix in {'.json', '.log', '.tap'}
                    or generated_contract and file.suffix in {'.ts', '.mjs', '.cjs'}
                    or generated_benchmark and (file.suffix in {'.mjs', '.gz'} or file.relative_to(reports).as_posix() in notice_paths)
                    or generated_documentation and file.suffix == '.mjs'
                    or file.relative_to(reports).as_posix() in {'doc-examples.md', 'documentation-support.md'}):
                output.add(file, arcname=str(file.relative_to(root)), recursive=False)
    for name in generated:
        file = root / 'compatibility' / name
        if file.is_file() and not file.is_symlink():
            output.add(file, arcname=str(file.relative_to(root)), recursive=False)
    for pattern in ('*.tgz', '*.registry.json'):
        for file in sorted((root / '.cache' / 'vendor').glob(pattern)):
            if file.is_file() and not file.is_symlink():
                output.add(file, arcname=str(file.relative_to(root)), recursive=False)
    logs = args.log_dir
    if logs.is_dir():
        for file in sorted(logs.glob('wga-*')):
            if file.is_file() and not file.is_symlink() and file.name.endswith(('.log', '.exit', '.exit.json', '.access.jsonl')):
                output.add(file, arcname='logs/' + file.name, recursive=False)
print(f'Collected local verification receipts: {archive.name}')
