import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SHELL_LIMIT = 20 * 1024 * 1024;
const SITE_LIMIT = 1024 * 1024 * 1024;
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml']);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

const files = await walk(DIST);
if (files.length === 0) throw new Error('Production artifact is empty.');
const sourceMaps = files.filter((file) => file.endsWith('.map'));
if (sourceMaps.length > 0) {
  throw new Error(`Production artifact must not publish source maps: ${sourceMaps.map((file) => relative(DIST, file)).join(', ')}`);
}
let publishedBytes = 0;
let compressedShellBytes = 0;
const rows = [];

for (const file of files) {
  const info = await stat(file);
  const extension = extname(file).toLowerCase();
  const raw = info.size;
  const compressed = COMPRESSIBLE.has(extension) ? gzipSync(await readFile(file)).byteLength : raw;
  publishedBytes += raw;
  compressedShellBytes += compressed;
  rows.push({ file: relative(DIST, file), raw, compressed });
}

rows.sort((left, right) => right.compressed - left.compressed);

console.log(`Published artifact: ${(publishedBytes / 1024 / 1024).toFixed(2)} MiB`);
console.log(`Compressed application shell: ${(compressedShellBytes / 1024 / 1024).toFixed(2)} MiB`);
for (const row of rows.slice(0, 8)) {
  console.log(`  ${row.file}: ${(row.raw / 1024).toFixed(1)} KiB raw / ${(row.compressed / 1024).toFixed(1)} KiB served`);
}

if (publishedBytes > SITE_LIMIT) {
  throw new Error(`Published artifact exceeds the 1 GiB GitHub Pages limit.`);
}

if (compressedShellBytes > SHELL_LIMIT) {
  throw new Error(`Compressed application shell exceeds the 20 MiB project budget.`);
}
