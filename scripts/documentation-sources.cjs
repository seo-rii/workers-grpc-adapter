'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const roots = ['.github', 'docs', 'fixtures', 'vendor'];
const ignored = new Set(['node_modules', 'dist', 'verification', 'artifacts', 'coverage']);
const bookkeeping = new Set(['STAGING.md', 'DONE.md', 'MISTAKES.md', 'RISK_REGISTER.md']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function discoverMarkdown(root) {
  const files = [];
  function walk(relative) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return;
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`WGA_DOC_SOURCE_SYMLINK: ${relative}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if ((!relative && bookkeeping.has(entry.name)) || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
        let directoryLink = false;
        try { directoryLink = fs.statSync(path.join(root, file)).isDirectory(); } catch { /* A dangling non-Markdown link is not a document. */ }
        if (entry.name.endsWith('.md') || (relative && directoryLink)) throw new Error(`WGA_DOC_SOURCE_SYMLINK: ${file}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (relative && !ignored.has(entry.name) && !entry.name.startsWith('.')) walk(file);
      } else if (entry.isFile() && entry.name.endsWith('.md') && (relative || !bookkeeping.has(entry.name))) files.push(file);
    }
  }
  walk('');
  for (const directory of roots) walk(directory);
  return files.sort();
}
function extractFences(file, text) {
  // Preserve the source bytes between fence lines. Container whitespace is
  // accepted for inventory; executable examples must match their fixture bytes.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const blocks = []; let active;
  for (const [index, line] of lines.entries()) {
    const value = line.replace(/\r?\n$/, '').replace(/^[ \t]*(?:>[ \t]*)*/, '');
    if (active) {
      const closing = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(value);
      if (closing && closing[1][0] === active.marker[0] && closing[1].length >= active.marker.length) {
        const content = lines.slice(active.line + 1, index).join('');
        blocks.push({ id: `${file}#fence-${blocks.length + 1}`, file, ordinal: blocks.length + 1,
          language: active.info.split(/\s+/)[0] || '', info: active.info,
          startLine: active.line + 1, endLine: index + 1, content, sha256: digest(content) });
        active = undefined;
      }
      continue;
    }
    const opening = /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(value);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) active = { marker: opening[1], info: opening[2].trim(), line: index };
  }
  if (active) throw new Error(`WGA_DOC_FENCE_UNCLOSED: ${file}:${active.line + 1}`);
  return blocks;
}
function readDocumentation(root) {
  return discoverMarkdown(root).map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return { file, text, sha256: digest(text), blocks: extractFences(file, text) };
  });
}
module.exports = { discoverMarkdown, extractFences, readDocumentation, digest, roots };
