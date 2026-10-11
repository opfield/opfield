// Post-build guard: fails when the alias step rewrote a bare package import
// (e.g. `ws`) into a relative path such as `../../ws`, or when any relative
// import in dist does not point at an existing file. Node's ESM loader rejects
// both at boot (ERR_UNSUPPORTED_DIR_IMPORT / ERR_MODULE_NOT_FOUND).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const srcDir = join(root, 'src');

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"\n]+)\1/gm;

function specifiers(code) {
  return [...code.matchAll(SPECIFIER)].map((m) => m[2]);
}

function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

function isBare(spec) {
  return !isRelative(spec) && !spec.startsWith('/') && !spec.startsWith('@/') && !/^[a-z]+:/.test(spec);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

function sourceFor(distFile) {
  const base = join(srcDir, relative(distDir, distFile)).replace(/\.js$/, '');
  return ['.ts', '.tsx', '.mts', '.js'].map((ext) => base + ext).find((p) => existsSync(p));
}

if (!existsSync(distDir)) {
  console.error(`check-dist-imports: ${distDir} does not exist; run the build first`);
  process.exit(1);
}

const problems = [];
const files = walk(distDir);
for (const file of files) {
  const rel = relative(root, file);
  const distSpecs = specifiers(readFileSync(file, 'utf8'));

  for (const spec of distSpecs.filter(isRelative)) {
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) problems.push(`${rel}: '${spec}' does not exist`);
    else if (!statSync(target).isFile()) problems.push(`${rel}: '${spec}' is a directory, not a file`);
  }

  const src = sourceFor(file);
  if (!src) continue;
  const distSet = new Set(distSpecs);
  for (const spec of new Set(specifiers(readFileSync(src, 'utf8')).filter(isBare))) {
    if (distSet.has(spec)) continue;
    const rewritten = distSpecs.find((d) => isRelative(d) && d.endsWith(`/${spec}`));
    if (rewritten) problems.push(`${rel}: bare import '${spec}' was rewritten to '${rewritten}'`);
  }
}

if (problems.length > 0) {
  console.error(`check-dist-imports: ${problems.length} broken import(s) in dist:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-dist-imports: ${files.length} files OK`);
