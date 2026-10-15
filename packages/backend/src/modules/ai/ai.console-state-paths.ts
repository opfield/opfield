import type { EffectiveCommand } from './ai.console-commands.js';
import { has, parseOptions, resolvePath, optionSet as set, values } from './ai.console-options.js';
import { commandBaseName, type ShellWord } from './ai.console-shell.js';

const PROTECTED_PATHS = [
  // State and configuration of the node's Opfield daemons (docker-daemon, nginx-daemon, monitoring-daemon, ...).
  /^\/(?:var\/lib|etc)\/[a-z0-9-]+-daemon(?:\/|$)/,
  /^\/(?:var\/lib|etc|opt)\/opfield[a-z0-9-]*(?:\/|$)/,
  // Docker's own data root: the containers, volumes and networks Opfield manages live there.
  /^\/var\/lib\/docker(?:\/|$)/,
];

/** Files a file tool writes, removes or changes. */
function writtenPaths(command: EffectiveCommand): ShellWord[] {
  const program = commandBaseName(command.argv[0]);
  const args = command.argv.slice(1);
  const positionals = (valueOptions: ReadonlySet<string> = set()) => parseOptions(args, valueOptions).positionals;
  const target = () => {
    const parsed = parseOptions(
      args,
      set('-t', '--target-directory', '-m', '--mode', '-o', '-g', '-S', '--suffix', '-e', '--rsh')
    );
    const directory = values(parsed, '-t', '--target-directory').at(-1);
    return directory ? [{ text: directory, dynamic: false }] : parsed.positionals.slice(-1);
  };
  switch (program) {
    case 'truncate':
      return positionals(set('-s', '--size', '-r', '--reference'));
    case 'touch':
      return positionals(set('-d', '--date', '-r', '--reference', '-t'));
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
    case 'mv':
    case 'tee':
    case 'chattr':
    case 'setfacl':
    case 'sudoedit':
    case 'vi':
    case 'vim':
    case 'nano':
    case 'ed':
    case 'ex':
      return positionals();
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const parsed = parseOptions(args, set('--reference', '--from'));
      return has(parsed, '--reference') ? parsed.positionals : parsed.positionals.slice(1);
    }
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync':
      return target();
    case 'dd':
      return args.filter((word) => word.text.startsWith('of=')).map((word) => ({ ...word, text: word.text.slice(3) }));
    case 'sed': {
      const parsed = parseOptions(args, set('-e', '--expression', '-f', '--file', '-l', '--line-length'));
      const inPlace = [...parsed.options.keys()].some((key) => key === '-i' || key.startsWith('--in-place'));
      if (!inPlace) return [];
      return has(parsed, '-e', '--expression', '-f', '--file') ? parsed.positionals : parsed.positionals.slice(1);
    }
    case 'perl':
      return args.some((word) => /^-[a-zA-Z]*i/.test(word.text))
        ? args.filter((word) => word.text.startsWith('/'))
        : [];
    case 'find': {
      const destructive = args.some((word) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(word.text));
      if (!destructive) return [];
      const end = args.findIndex((word) => /^[-(!]/.test(word.text));
      return args.slice(0, end < 0 ? args.length : end);
    }
    default:
      return [];
  }
}

/** Protected daemon and Docker state paths a command writes, changes or removes, with the tool that does it. */
export function protectedStateWrites(command: EffectiveCommand): Array<{ verb: string; path: string }> {
  const program = commandBaseName(command.argv[0]);
  const written = [
    ...writtenPaths(command).map((word) => ({ word, verb: program })),
    ...command.writes.map((word) => ({ word, verb: 'output redirection' })),
  ];
  const out: Array<{ verb: string; path: string }> = [];
  for (const { word, verb } of written) {
    if (word.text.startsWith('$') || word.text.startsWith('~')) continue;
    const path = resolvePath(command.cwd, word.text);
    if (path && PROTECTED_PATHS.some((pattern) => pattern.test(path))) out.push({ verb, path });
  }
  return out;
}
