'use strict';
const fs = require('fs');
const path = require('path');

const candidates = [
  { pkg: 'dist/main.js', label: 'dist/main.js' },
  { pkg: 'dist/src/main.js', label: 'dist/src/main.js' },
];

function walk(dir, prefix) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  return entries.map((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return `${prefix}${e.name}/`;
    return `${prefix}${e.name}`;
  });
}

function printTree(dir) {
  if (!fs.existsSync(dir)) return '(no dist directory)';
  const lines = walk(dir, '  ');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.endsWith('/')) {
      lines.push(...walk(path.join(dir, line.trim()), `  ${line.trim()}`));
    }
  }
  return lines.join('\n');
}

let found = false;
for (const { pkg, label } of candidates) {
  const resolved = path.join(__dirname, '..', pkg);
  if (fs.existsSync(resolved)) {
    console.log(`[start:prod] running ${label} -> ${resolved}`);
    found = true;
    try {
      require(resolved);
    } catch (e) {
      console.error('[start:prod] require threw synchronously:');
      console.error(e && e.stack ? e.stack : e);
      console.error('[start:prod] message:', e && e.message ? e.message : String(e));
      setTimeout(() => process.exit(1), 800);
    }
    break;
  }
}

if (!found) {
  console.error('[start:prod] FATAL: no build output found.');
  console.error('[start:prod] Tried:');
  for (const { label } of candidates) console.error(`  - ${label} -> ${path.join(__dirname, '..', candidates.find(c=>c.label===label).pkg)}`);
  console.error('[start:prod] dist tree:');
  console.error(printTree(path.join(__dirname, '..', 'dist')));
  process.exit(1);
}
// Found and required — keep event loop alive for Nest (do not exit)