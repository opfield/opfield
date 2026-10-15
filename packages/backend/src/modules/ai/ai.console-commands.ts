import { resolvePath } from './ai.console-options.js';
import {
  commandBaseName,
  isShellProgram,
  parseShellScript,
  type ShellCommand,
  type ShellWord,
  shellInvocation,
} from './ai.console-shell.js';

/**
 * A program a console command ends up running, after the shell syntax and the wrappers that run another command
 * (sudo, env, nohup, timeout, nice, xargs, nsenter, ...) are taken off.
 */
export interface EffectiveCommand {
  /** argv of the program; argv[0] is the program itself. */
  argv: ShellWord[];
  /** Variables set for it: assignment prefixes, `env NAME=value`, and `export`s earlier in the script. */
  env: Record<string, string>;
  /** Files its output is redirected to. */
  writes: ShellWord[];
  /** xargs adds arguments from standard input that the command line does not show. */
  extraArgs: boolean;
  /** Working directory when an earlier `cd` in the script set it to a known path; null when unknown. */
  cwd: string | null;
}

interface ExpandContext {
  cwd: string | null;
  env: Record<string, string>;
  depth: number;
}

interface Unwrapped {
  rest: ShellWord[];
  env?: Record<string, string>;
  script?: string;
  extraArgs?: boolean;
  cwd?: string | null;
}

const MAX_DEPTH = 8;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', 'in', '{', '}']);
const NON_COMMAND_KEYWORDS = new Set(['for', 'case', 'select', 'function', '[[', 'test', '[', 'true', 'false', ':']);

function words(texts: readonly string[]): ShellWord[] {
  return texts.map((text) => ({ text, dynamic: false }));
}

/**
 * Index of the first word after the options of a wrapper. `valueOptions` take a value (the next word, or attached:
 * `-uroot`, `--user=root`); other options are flags. `--` ends the options.
 */
function skipOptions(list: ShellWord[], start: number, valueOptions: ReadonlySet<string>): number {
  let i = start;
  while (i < list.length) {
    const text = list[i].text;
    if (text === '--') return i + 1;
    if (!text.startsWith('-') || text === '-') break;
    if (text.startsWith('--')) {
      i += !text.includes('=') && valueOptions.has(text) ? 2 : 1;
      continue;
    }
    if (valueOptions.has(text)) {
      i += 2;
      continue;
    }
    let next = i + 1;
    for (let k = 1; k < text.length; k++) {
      if (valueOptions.has(`-${text[k]}`)) {
        next = k === text.length - 1 ? i + 2 : i + 1;
        break;
      }
    }
    i = next;
  }
  return i;
}

function hasOption(list: ShellWord[], end: number, short: string, long?: string): boolean {
  return list.slice(1, end).some((word) => {
    const text = word.text;
    if (long && (text === long || text.startsWith(`${long}=`))) return true;
    return /^-[A-Za-z]+$/.test(text) && text.includes(short);
  });
}

function optionValue(list: ShellWord[], end: number, names: readonly string[]): string | null {
  for (let i = 1; i < end; i++) {
    const text = list[i].text;
    for (const name of names) {
      if (text === name) return list[i + 1]?.text ?? null;
      if (name.startsWith('--') && text.startsWith(`${name}=`)) return text.slice(name.length + 1);
      if (!name.startsWith('--') && text.startsWith(name) && text.length > name.length) return text.slice(name.length);
    }
  }
  return null;
}

const set = (...values: string[]) => new Set(values);

/** Wrappers that run the command after their options; null when the invocation runs no command. */
const WRAPPERS: Record<string, (list: ShellWord[]) => Unwrapped | null> = {
  sudo(list) {
    const end = skipOptions(
      list,
      1,
      set(
        '-u',
        '-g',
        '-h',
        '-p',
        '-C',
        '-D',
        '-r',
        '-t',
        '-U',
        '-T',
        '-R',
        '--user',
        '--group',
        '--host',
        '--prompt',
        '--close-from',
        '--chdir',
        '--role',
        '--type',
        '--other-user',
        '--command-timeout'
      )
    );
    // sudo -e edits files as root.
    if (hasOption(list, end, 'e', '--edit'))
      return { rest: [{ text: 'sudoedit', dynamic: false }, ...list.slice(end)] };
    if (hasOption(list, end, 'l', '--list') || hasOption(list, end, 'v', '--validate')) return null;
    return { rest: list.slice(end) };
  },
  doas: (list) => ({ rest: list.slice(skipOptions(list, 1, set('-u', '-C'))) }),
  nohup: (list) => ({ rest: list.slice(1) }),
  builtin: (list) => ({ rest: list.slice(1) }),
  unbuffer: (list) => ({ rest: list.slice(1) }),
  exec: (list) => ({ rest: list.slice(skipOptions(list, 1, set('-a'))) }),
  setsid: (list) => ({ rest: list.slice(skipOptions(list, 1, set())) }),
  nice: (list) => ({ rest: list.slice(skipOptions(list, 1, set('-n', '--adjustment'))) }),
  ionice(list) {
    const end = skipOptions(list, 1, set('-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid'));
    return hasOption(list, end, 'p', '--pid') ? null : { rest: list.slice(end) };
  },
  stdbuf: (list) => ({
    rest: list.slice(skipOptions(list, 1, set('-i', '-o', '-e', '--input', '--output', '--error'))),
  }),
  time: (list) => ({ rest: list.slice(skipOptions(list, 1, set('-f', '-o', '--format', '--output'))) }),
  timeout(list) {
    const end = skipOptions(list, 1, set('-s', '-k', '--signal', '--kill-after'));
    return { rest: list.slice(end + 1) };
  },
  command(list) {
    const end = skipOptions(list, 1, set());
    return hasOption(list, end, 'v') || hasOption(list, end, 'V') ? null : { rest: list.slice(end) };
  },
  xargs(list) {
    const end = skipOptions(
      list,
      1,
      set(
        '-a',
        '-d',
        '-E',
        '-I',
        '-L',
        '-n',
        '-P',
        '-s',
        '--arg-file',
        '--delimiter',
        '--eof',
        '--replace',
        '--max-lines',
        '--max-args',
        '--max-procs',
        '--max-chars',
        '--process-slot-var'
      )
    );
    return { rest: list.slice(end), extraArgs: true };
  },
  watch(list) {
    const end = skipOptions(list, 1, set('-n', '--interval', '-q', '--equexit'));
    const rest = list.slice(end);
    return hasOption(list, end, 'x', '--exec') ? { rest } : { rest: [], script: rest.map((w) => w.text).join(' ') };
  },
  flock(list) {
    const end = skipOptions(list, 1, set('-w', '-E', '--timeout', '--conflict-exit-code'));
    const rest = list.slice(end + 1);
    if (rest[0]?.text === '-c' || rest[0]?.text === '--command') return { rest: [], script: rest[1]?.text ?? '' };
    return { rest };
  },
  su(list) {
    const script = optionValue(list, list.length, ['-c', '--command']);
    return script === null ? null : { rest: [], script };
  },
  runuser(list) {
    const script = optionValue(list, list.length, ['-c', '--command']);
    if (script !== null) return { rest: [], script };
    return {
      rest: list.slice(skipOptions(list, 1, set('-u', '-g', '-G', '-s', '-w', '--user', '--group', '--shell'))),
    };
  },
  nsenter: (list) => ({
    rest: list.slice(skipOptions(list, 1, set('-t', '-S', '-G', '--target', '--setuid', '--setgid', '--wd'))),
  }),
  chroot(list) {
    const end = skipOptions(list, 1, set('--userspec', '--groups'));
    // Paths inside the new root are not the host's paths.
    return { rest: list.slice(end + 1), cwd: null };
  },
  env(list) {
    const env: Record<string, string> = {};
    let cwd: string | null | undefined;
    let i = 1;
    for (; i < list.length; i++) {
      const text = list[i].text;
      if (text === '--') {
        i++;
        break;
      }
      if (text === '-u' || text === '--unset' || text === '-C' || text === '--chdir') {
        if (text === '-C' || text === '--chdir') cwd = list[i + 1]?.text ?? null;
        i++;
        continue;
      }
      if (text === '-S' || text === '--split-string') {
        return {
          rest: [],
          script: list
            .slice(i + 1)
            .map((word) => word.text)
            .join(' '),
          env,
        };
      }
      if (text.startsWith('-')) continue;
      const assignment = ASSIGNMENT.exec(text);
      if (!assignment) break;
      if (!list[i].dynamic) env[assignment[1]] = assignment[2];
    }
    return { rest: list.slice(i), env, ...(cwd !== undefined ? { cwd } : {}) };
  },
};

class CommandExpander {
  readonly out: EffectiveCommand[] = [];

  expandAll(commands: ShellCommand[], context: ExpandContext) {
    for (const command of commands) this.expand(command, context);
  }

  private expandScript(script: string, context: ExpandContext) {
    if (context.depth >= MAX_DEPTH) return;
    this.expandAll(parseShellScript(script, context.depth + 1), { ...context, depth: context.depth + 1 });
  }

  private expand(command: ShellCommand, context: ExpandContext) {
    let list = [...command.words];
    const env: Record<string, string> = {};
    let extraArgs = false;
    let cwd = context.cwd;

    while (list[0] && ASSIGNMENT.test(list[0].text)) {
      const [, name, value] = ASSIGNMENT.exec(list[0].text)!;
      if (!list[0].dynamic) env[name] = value;
      list.shift();
    }
    if (list.length === 0) {
      Object.assign(context.env, env);
      if (command.writes.length > 0) this.push([], env, command.writes, false, cwd, context);
      return;
    }
    while (list[0] && !list[0].dynamic && KEYWORDS.has(list[0].text)) list.shift();
    if (list.length === 0 || NON_COMMAND_KEYWORDS.has(list[0].text)) {
      if (command.writes.length > 0) this.push([], env, command.writes, false, cwd, context);
      return;
    }

    for (let guard = 0; guard < 12 && list.length > 0; guard++) {
      const name = commandBaseName(list[0]);
      if (name === 'busybox' && list[1] && !list[1].text.startsWith('-')) {
        list = list.slice(1);
        continue;
      }
      const unwrap = WRAPPERS[name];
      if (!unwrap) break;
      const result = unwrap(list);
      if (!result) return;
      Object.assign(env, result.env ?? {});
      if (result.extraArgs) extraArgs = true;
      if (result.cwd !== undefined) cwd = result.cwd === null ? null : resolvePath(cwd, result.cwd);
      if (result.script !== undefined) {
        this.expandScript(result.script, { ...context, cwd, env: { ...context.env, ...env } });
        return;
      }
      list = result.rest;
    }
    if (list.length === 0) return;
    const name = commandBaseName(list[0]);

    if (name === 'cd' || name === 'pushd') {
      const target = list[1];
      context.cwd = target && !target.dynamic && target.text !== '-' ? resolvePath(context.cwd, target.text) : null;
      return;
    }
    if (name === 'popd') {
      context.cwd = null;
      return;
    }
    if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'readonly') {
      for (const word of list.slice(1)) {
        const assignment = ASSIGNMENT.exec(word.text);
        if (assignment && !word.dynamic) context.env[assignment[1]] = assignment[2];
      }
      return;
    }
    if (name === 'eval') {
      this.expandScript(
        list
          .slice(1)
          .map((word) => word.text)
          .join(' '),
        { ...context, cwd }
      );
      return;
    }
    if (isShellProgram(list[0])) {
      const invocation = shellInvocation(list);
      const childContext = { ...context, cwd, env: { ...context.env, ...env } };
      if (invocation.kind === 'script') this.expandScript(invocation.script.text, childContext);
      if (invocation.kind === 'stdin') {
        for (const body of command.heredocs) this.expandScript(body, childContext);
        const source = command.pipedFrom?.words;
        const sourceName = commandBaseName(source?.[0]);
        if (source && (sourceName === 'echo' || sourceName === 'printf')) {
          const args = source.slice(1).filter((word) => !/^-[neE]+$/.test(word.text));
          this.expandScript(
            (sourceName === 'printf' ? args.slice(0, 1) : args).map((w) => w.text).join(' '),
            childContext
          );
        }
      }
      return;
    }
    this.push(list, env, command.writes, extraArgs, cwd, context);
  }

  private push(
    argv: ShellWord[],
    env: Record<string, string>,
    writes: ShellWord[],
    extraArgs: boolean,
    cwd: string | null,
    context: ExpandContext
  ) {
    this.out.push({ argv, env: { ...context.env, ...env }, writes, extraArgs, cwd });
  }
}

/** The programs a node console command runs. `command` is the argv the console executes. */
export function consoleCommands(command: readonly string[]): EffectiveCommand[] {
  const expander = new CommandExpander();
  expander.expandAll([{ words: words(command), writes: [], heredocs: [] }], { cwd: null, env: {}, depth: 0 });
  return expander.out;
}

/** The programs a POSIX shell command string runs (SSH connectors run their command through a shell). */
export function shellStringCommands(script: string): EffectiveCommand[] {
  const expander = new CommandExpander();
  expander.expandAll(parseShellScript(script), { cwd: null, env: {}, depth: 0 });
  return expander.out;
}

export function commandText(command: EffectiveCommand): string {
  return command.argv.map((word) => (/\s/.test(word.text) ? JSON.stringify(word.text) : word.text)).join(' ');
}
