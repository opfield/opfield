// Grep gate for the old product names (Gateway, Wiolett, the sqgateway scope and the gw*_ token prefixes). Every
// tracked file and path is scanned; a hit passes only when it is history (excludedPaths), the networking word
// (genericPhrases), an entry of config/legacy-brand-allowlist.json whose paths and pattern cover it, or code marked
// with a `legacy-name:` comment. Used by scripts/legacy-brand.test.mjs and by the commercial core's test of its tree.
//
//   node scripts/legacy-brand.mjs [--repo opfield|commercial] [--root <dir>] [--files <list file>]
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ALLOWLIST = fileURLToPath(new URL('../config/legacy-brand-allowlist.json', import.meta.url));

// The old names. Token prefixes count only as a prefix followed by token characters, not inside base64 or a word.
const BRAND_PATTERNS = [/gateway|wiolett/gi, /\b(?:gw|gwo|gwr|gwi|gwl|gwp)_(?=[A-Za-z0-9])/g];

// Directories a tree walk (no git available) skips; the same files git does not track.
const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.nx', '.turbo', '.workflow', '.design', 'bin']);
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|icns|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|xz|zst|tar|binpb|pb|wasm|mp4|webm|mov|mp3|db|sqlite)$/i;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const globCache = new Map();

// Minimal glob: `**` spans directories, `*` and `?` stay inside one segment, `{a,b}` alternatives, `[...]` classes.
export function globToRegExp(glob) {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let source = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) throw new Error(`Unclosed [ in glob ${glob}`);
      source += `[${glob.slice(i + 1, end).replace(/^!/, '^')}]`;
      i = end;
    } else if (char === '{') {
      depth += 1;
      source += '(?:';
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      source += ')';
    } else if (char === ',' && depth > 0) {
      source += '|';
    } else {
      source += char.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  if (depth !== 0) throw new Error(`Unclosed { in glob ${glob}`);
  const regexp = new RegExp(`^${source}$`);
  globCache.set(glob, regexp);
  return regexp;
}

export function matchesAnyGlob(file, globs) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

// Paths of an entry for one repository: plain globs belong to the public repository, `commercial:` globs to the
// commercial core.
function repoGlobs(globs, repo) {
  const prefix = 'commercial:';
  return repo === 'commercial'
    ? globs.filter((glob) => glob.startsWith(prefix)).map((glob) => glob.slice(prefix.length))
    : globs.filter((glob) => !glob.startsWith(prefix));
}

export function loadAllowlist(file = DEFAULT_ALLOWLIST) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  const entries = (raw.entries ?? []).map((entry, index) => {
    const where = `entries[${index}]`;
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) problems.push(`${where}: paths must be a non-empty list of globs`);
    if (typeof entry.pattern !== 'string' || !entry.pattern) problems.push(`${where}: pattern must be a regular expression`);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`${where}: reason is required`);
    if (typeof entry.removeIn !== 'string' || !entry.removeIn.trim()) problems.push(`${where}: removeIn is required`);
    let regexp = null;
    try {
      regexp = new RegExp(entry.pattern, `g${entry.flags ?? ''}`);
      for (const glob of entry.paths ?? []) globToRegExp(glob.replace(/^commercial:/, ''));
    } catch (error) {
      problems.push(`${where}: ${error.message}`);
    }
    return { ...entry, regexp, index };
  });
  const generic = (raw.genericPhrases ?? []).map((phrase) => new RegExp(phrase, 'gi'));
  const excluded = raw.excludedPaths ?? [];
  if (problems.length) throw new Error(`Invalid ${file}:\n${problems.join('\n')}`);
  return { entries, generic, excluded };
}

export function listTrackedFiles(root) {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean);
  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (WALK_SKIP.has(item.name)) continue;
      const relative = dir ? `${dir}/${item.name}` : item.name;
      if (item.isDirectory()) walk(relative);
      else if (item.isFile()) files.push(relative);
    }
  };
  walk('');
  return files.sort();
}

function brandHits(text) {
  const hits = [];
  for (const pattern of BRAND_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) hits.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return hits;
}

function spans(text, regexps) {
  const result = [];
  for (const regexp of regexps) {
    regexp.lastIndex = 0;
    for (const match of text.matchAll(regexp)) {
      if (match[0].length > 0) result.push([match.index, match.index + match[0].length]);
    }
  }
  return result;
}

const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|--|<!--)/;

// Lines a `legacy-name:` marker covers: the marker, the comment lines that continue it, and the statement directly
// under it: to the line where its brackets (or a shell do/then block) close, across lines that end in an operator or
// a backslash.
function markedLines(lines) {
  const marked = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('legacy-name:')) continue;
    marked.add(i);
    let j = i + 1;
    if (COMMENT_LINE.test(lines[i])) {
      while (j < lines.length && COMMENT_LINE.test(lines[j]) && lines[j].trim()) marked.add(j++);
    } else {
      continue; // a trailing marker covers its own line
    }
    let balance = 0;
    for (; j < lines.length; j += 1) {
      if (!lines[j].trim() && balance <= 0) break;
      marked.add(j);
      const code = lines[j].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\s(?:\/\/|#).*$/, '');
      balance += (code.match(/[[({]/g) ?? []).length - (code.match(/[\])}]/g) ?? []).length;
      balance += (code.match(/(?:^|[\s;])(?:do|then)\s*$/) ? 1 : 0) - (code.match(/^\s*(?:done|fi)\b/) ? 1 : 0);
      const continues = /(?:[=(,[{&|?:+\\]|=>|\bdo|\bthen)\s*$/.test(code) || /^\s*(?:\.|\?|:|\|\||&&)/.test(lines[j + 1] ?? '');
      if (balance <= 0 && !continues) break;
    }
  }
  return marked;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

// Every hit no rule covers, as { file, line, column, text, source }. `line` 0 is the path itself.
export function scan({ root, files = listTrackedFiles(root), repo = 'opfield', allowlist = loadAllowlist() }) {
  const failures = [];
  const self = new Set(['scripts/legacy-brand.mjs', 'scripts/legacy-brand.test.mjs', 'config/legacy-brand-allowlist.json']);
  for (const file of files) {
    if (repo === 'opfield' && self.has(file)) continue;
    if (matchesAnyGlob(file, repoGlobs(allowlist.excluded, repo))) continue;
    const entries = allowlist.entries.filter((entry) => matchesAnyGlob(file, repoGlobs(entry.paths, repo)));
    const allowed = [...allowlist.generic, ...entries.map((entry) => entry.regexp)];
    const check = (text, lineNumber, marked) => {
      const hits = brandHits(text);
      if (!hits.length || marked) return;
      const covered = spans(text, allowed);
      for (const hit of hits) {
        if (covered.some(([start, end]) => start <= hit.start && hit.end <= end)) continue;
        failures.push({ file, line: lineNumber, column: hit.start + 1, text: hit.text, source: text.trim().slice(0, 200) });
      }
    };
    check(file, 0, false);
    if (BINARY_EXTENSIONS.test(file)) continue;
    let buffer;
    try {
      const stats = statSync(path.join(root, file));
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;
      buffer = readFileSync(path.join(root, file));
    } catch {
      continue; // deleted in the working tree
    }
    if (isBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split('\n');
    const marked = markedLines(lines);
    lines.forEach((line, index) => check(line, index + 1, marked.has(index)));
  }
  return failures;
}

export function formatFailures(failures) {
  return failures.map((hit) => `${hit.file}:${hit.line}:${hit.column}: ${hit.text}  | ${hit.source}`).join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  const root = path.resolve(arg('--root') ?? '.');
  const repo = arg('--repo') ?? 'opfield';
  const list = arg('--files');
  const files = list ? readFileSync(list, 'utf8').split('\n').filter(Boolean) : undefined;
  const failures = scan({ root, repo, ...(files ? { files } : {}) });
  if (failures.length) {
    console.log(formatFailures(failures));
    console.error(`${failures.length} old product names outside the allowlist`);
    process.exit(1);
  }
}
