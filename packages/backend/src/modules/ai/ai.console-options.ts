import { posix } from 'node:path';
import type { ShellWord } from './ai.console-shell.js';

export const optionSet = (...values: string[]) => new Set(values);

export interface Parsed {
  options: Map<string, string[]>;
  positionals: ShellWord[];
  rest: ShellWord[];
}

/**
 * Splits words into options and positionals. Value options take the next word or an attached value (`-p80:80`,
 * `--name=web`). With `stopAtPositional` the first positional ends the options (the image of `run`).
 */
export function parseOptions(list: ShellWord[], valueOptions: ReadonlySet<string>, stopAtPositional = false): Parsed {
  const options = new Map<string, string[]>();
  const positionals: ShellWord[] = [];
  const add = (name: string, value: string) => options.set(name, [...(options.get(name) ?? []), value]);
  for (let i = 0; i < list.length; i++) {
    const text = list[i].text;
    if (text === '--') {
      positionals.push(...list.slice(i + 1));
      return { options, positionals, rest: [] };
    }
    if (!text.startsWith('-') || text === '-') {
      positionals.push(list[i]);
      if (stopAtPositional) return { options, positionals, rest: list.slice(i + 1) };
      continue;
    }
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      if (eq > 0) add(text.slice(0, eq), text.slice(eq + 1));
      else if (valueOptions.has(text)) add(text, list[++i]?.text ?? '');
      else add(text, '');
      continue;
    }
    for (let k = 1; k < text.length; k++) {
      const name = `-${text[k]}`;
      if (valueOptions.has(name)) {
        add(name, k < text.length - 1 ? text.slice(k + 1) : (list[++i]?.text ?? ''));
        break;
      }
      add(name, '');
    }
  }
  return { options, positionals, rest: [] };
}

export function values(parsed: Parsed, ...names: string[]): string[] {
  return names.flatMap((name) => parsed.options.get(name) ?? []);
}

export function has(parsed: Parsed, ...names: string[]): boolean {
  return names.some((name) => parsed.options.has(name));
}

export function resolvePath(cwd: string | null, path: string): string | null {
  if (path.startsWith('/')) return posix.normalize(path);
  return cwd ? posix.normalize(posix.join(cwd, path)) : null;
}
