import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A value interpolated into a drizzle sql`` template becomes a bind parameter. Inside a quoted SQL literal the
// placeholder is plain text, so Postgres refuses the query ("bind message supplies 1 parameters, but prepared
// statement requires 0"). Such a query fails only when it runs, e.g. at start-up on an installation with data.
const SRC = path.resolve(__dirname, '..');

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start;
  while (index < source.length && source[index] !== quote) index += source[index] === '\\' ? 2 : 1;
  return index + 1;
}

/** From just after `${`, returns the index after the matching `}`. */
function skipExpression(source: string, start: number): number {
  let index = start;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '`') index = skipTemplate(source, index + 1);
    else if (char === "'" || char === '"') index = skipQuoted(source, index + 1, char);
    else {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      index += 1;
    }
  }
  return index;
}

/** From just after an opening backtick, returns the index after the closing one. */
function skipTemplate(source: string, start: number, onInterpolation?: (inSqlLiteral: boolean) => void): number {
  let index = start;
  let inSqlLiteral = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') index += 2;
    else if (char === '`') return index + 1;
    else if (char === '$' && source[index + 1] === '{') {
      onInterpolation?.(inSqlLiteral);
      index = skipExpression(source, index + 2);
    } else {
      if (char === "'") inSqlLiteral = !inSqlLiteral;
      index += 1;
    }
  }
  return index;
}

export function quotedSqlInterpolations(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bsql`/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let quoted = false;
    const end = skipTemplate(source, start, (inSqlLiteral) => {
      quoted ||= inSqlLiteral;
    });
    if (quoted) found.push(source.slice(match.index, Math.min(end, (match.index ?? 0) + 120)));
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'migrations' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('sql templates', () => {
  it('finds a value interpolated inside a quoted SQL literal', () => {
    expect(quotedSqlInterpolations("sql`select hashtext('${KEY}-lock')`")).toHaveLength(1);
    expect(quotedSqlInterpolations("sql`select hashtext(${`${KEY}-lock`}), '{}'::jsonb, ${x} = 'a'`")).toEqual([]);
  });

  it('never interpolate a value inside a quoted SQL literal in the backend', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      quotedSqlInterpolations(readFileSync(file, 'utf8')).map((text) => `${path.relative(SRC, file)}: ${text}`)
    );
    expect(offenders).toEqual([]);
  });
});
