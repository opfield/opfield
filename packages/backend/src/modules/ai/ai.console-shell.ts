/**
 * A best-effort reading of what a node console command runs, for the guard that keeps agents off Opfield-managed
 * Docker objects. It follows POSIX shell syntax far enough to find every simple command a script runs: `;`, `&&`,
 * `||`, pipelines, subshells and groups, command substitutions (`$(...)`, backticks, `<(...)`), here-documents fed
 * to a shell, `sh -c`/`bash -c`/`eval`/`su -c` strings, and the wrappers that run another command (sudo, env, nohup,
 * timeout, xargs, ...). It never executes anything: a word the shell would expand at run time (`$VAR`, `$(...)`,
 * a glob) is marked dynamic so callers can treat its value as unknown.
 */

export interface ShellWord {
  text: string;
  /** The shell expands the word when it runs (variables, substitutions, globs, `~`): its text is not its value. */
  dynamic: boolean;
}

export interface ShellCommand {
  words: ShellWord[];
  /** Targets of output redirections (`>`, `>>`, `&>`, `>|`, `<>`). */
  writes: ShellWord[];
  /** Bodies of the here-documents fed to the command. */
  heredocs: string[];
  /** The previous command of a pipeline: this command reads its output. */
  pipedFrom?: ShellCommand;
}

const MAX_DEPTH = 8;
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'ksh', 'mksh', 'busybox']);

interface WordState {
  text: string;
  dynamic: boolean;
  quoted: boolean;
}

/** Index of the `)` closing the `(` before `start`, skipping quoted text and nested parentheses; -1 when none. */
function matchingParen(script: string, start: number): number {
  let depth = 1;
  for (let i = start; i < script.length; i++) {
    const char = script[i];
    if (char === '\\') {
      i++;
    } else if (char === "'") {
      const end = script.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (char === '"') {
      for (i++; i < script.length && script[i] !== '"'; i++) if (script[i] === '\\') i++;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function unescapedBacktick(script: string, start: number): number {
  for (let i = start; i < script.length; i++) {
    if (script[i] === '\\') i++;
    else if (script[i] === '`') return i;
  }
  return -1;
}

class ShellScanner {
  private readonly out: ShellCommand[] = [];
  private command: ShellCommand = { words: [], writes: [], heredocs: [] };
  private word: WordState | null = null;
  private redirect: 'write' | 'read' | 'heredoc' | null = null;
  private heredocStrip = false;
  private readonly pendingHeredocs: Array<{ delimiter: string; strip: boolean; command: ShellCommand }> = [];
  private i = 0;

  constructor(
    private readonly script: string,
    private readonly depth: number
  ) {}

  scan(): ShellCommand[] {
    const s = this.script;
    while (this.i < s.length) {
      const char = s[this.i];
      if (char === ' ' || char === '\t') {
        this.endWord();
        this.i++;
      } else if (char === '\n') {
        this.endCommand(false);
        this.readHeredocBodies();
        this.i++;
      } else if (char === '#' && !this.word) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (char === '\\') {
        if (s[this.i + 1] === '\n') this.i += 2;
        else {
          this.append(s[this.i + 1] ?? '', true);
          this.i += 2;
        }
      } else if (char === "'") {
        const end = s.indexOf("'", this.i + 1);
        const stop = end < 0 ? s.length : end;
        this.append(s.slice(this.i + 1, stop), true);
        this.i = stop + 1;
      } else if (char === '"') {
        this.doubleQuoted();
      } else if (char === '`') {
        const end = unescapedBacktick(s, this.i + 1);
        const stop = end < 0 ? s.length : end;
        this.substitution(s.slice(this.i + 1, stop), s.slice(this.i, stop + 1));
        this.i = stop + 1;
      } else if (char === '$') {
        this.dollar(false);
      } else if ((char === '<' || char === '>') && s[this.i + 1] === '(' && !this.word) {
        const end = matchingParen(s, this.i + 2);
        const stop = end < 0 ? s.length : end;
        this.substitution(s.slice(this.i + 2, stop), s.slice(this.i, stop + 1));
        this.i = stop + 1;
      } else if (char === '>' || char === '<') {
        this.redirection();
      } else if (char === '&' && s[this.i + 1] === '>') {
        this.endWord();
        this.i += s[this.i + 2] === '>' ? 3 : 2;
        this.redirect = 'write';
      } else if (char === ';' || char === '&' || char === '|' || char === '(' || char === ')') {
        this.operator(char);
      } else {
        if (char === '*' || char === '?' || char === '[' || (char === '~' && !this.word)) this.markDynamic();
        this.append(char, false);
        this.i++;
      }
    }
    this.endCommand(false);
    return this.out;
  }

  private append(text: string, quoted: boolean) {
    if (!this.word) this.word = { text: '', dynamic: false, quoted: false };
    this.word.text += text;
    if (quoted) this.word.quoted = true;
  }

  private markDynamic() {
    if (!this.word) this.word = { text: '', dynamic: false, quoted: false };
    this.word.dynamic = true;
  }

  private doubleQuoted() {
    const s = this.script;
    this.append('', true);
    this.i++;
    while (this.i < s.length && s[this.i] !== '"') {
      const char = s[this.i];
      if (char === '\\' && '$`"\\\n'.includes(s[this.i + 1] ?? '')) {
        if (s[this.i + 1] !== '\n') this.append(s[this.i + 1], true);
        this.i += 2;
      } else if (char === '$') {
        this.dollar(true);
      } else if (char === '`') {
        const end = unescapedBacktick(s, this.i + 1);
        const stop = end < 0 ? s.length : end;
        this.substitution(s.slice(this.i + 1, stop), s.slice(this.i, stop + 1));
        this.i = stop + 1;
      } else {
        this.append(char, true);
        this.i++;
      }
    }
    this.i++;
  }

  private dollar(inQuotes: boolean) {
    const s = this.script;
    const next = s[this.i + 1] ?? '';
    if (next === '(' && s[this.i + 2] === '(') {
      const end = matchingParen(s, this.i + 3);
      const stop = end < 0 ? s.length : Math.min(s.length, end + 1);
      this.append(s.slice(this.i, stop + 1), inQuotes);
      this.markDynamic();
      this.i = stop + 1;
    } else if (next === '(') {
      const end = matchingParen(s, this.i + 2);
      const stop = end < 0 ? s.length : end;
      this.substitution(s.slice(this.i + 2, stop), s.slice(this.i, stop + 1));
      this.i = stop + 1;
    } else if (next === '{') {
      const end = s.indexOf('}', this.i + 2);
      const stop = end < 0 ? s.length : end;
      this.append(s.slice(this.i, stop + 1), inQuotes);
      this.markDynamic();
      this.i = stop + 1;
    } else if (next === "'" && !inQuotes) {
      // ANSI-C quoting: escapes are kept as the escaped character.
      let j = this.i + 2;
      let text = '';
      for (; j < s.length && s[j] !== "'"; j++) {
        if (s[j] === '\\') j++;
        text += s[j] ?? '';
      }
      this.append(text, true);
      this.i = j + 1;
    } else if (/[A-Za-z_]/.test(next)) {
      let j = this.i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      this.append(s.slice(this.i, j), inQuotes);
      this.markDynamic();
      this.i = j;
    } else if (/[0-9@*#?$!-]/.test(next) && next !== '') {
      this.append(s.slice(this.i, this.i + 2), inQuotes);
      this.markDynamic();
      this.i += 2;
    } else {
      this.append('$', inQuotes);
      this.i++;
    }
  }

  /** A command substitution runs its own commands first; its output makes the word unknown. */
  private substitution(inner: string, raw: string) {
    this.out.push(...parseShellScript(inner, this.depth + 1));
    this.append(raw, false);
    this.markDynamic();
  }

  private redirection() {
    const s = this.script;
    const fdOnly = this.word && !this.word.quoted && /^\d+$/.test(this.word.text);
    if (fdOnly) this.word = null;
    else this.endWord();
    const rest = s.slice(this.i, this.i + 3);
    if (rest.startsWith('<<<')) {
      this.i += 3;
      this.redirect = 'read';
    } else if (rest.startsWith('<<')) {
      this.heredocStrip = rest[2] === '-';
      this.i += this.heredocStrip ? 3 : 2;
      this.redirect = 'heredoc';
    } else if (rest.startsWith('<>') || rest.startsWith('>>') || rest.startsWith('>|')) {
      this.i += 2;
      this.redirect = 'write';
    } else if (rest.startsWith('>&') || rest.startsWith('<&')) {
      this.i += 2;
      // `2>&1` duplicates a descriptor; `>&file` writes the file.
      if (/[\d-]/.test(s[this.i] ?? '')) {
        while (/[\d-]/.test(s[this.i] ?? '')) this.i++;
      } else {
        this.redirect = rest[0] === '>' ? 'write' : 'read';
      }
    } else {
      this.redirect = rest[0] === '>' ? 'write' : 'read';
      this.i++;
    }
  }

  private operator(char: string) {
    const s = this.script;
    this.endWord();
    if (char === '|') {
      if (s[this.i + 1] === '|') {
        this.endCommand(false);
        this.i += 2;
        return;
      }
      this.endCommand(true);
      this.i += s[this.i + 1] === '&' ? 2 : 1;
      return;
    }
    this.endCommand(false);
    this.i += (char === '&' || char === ';') && s[this.i + 1] === char ? 2 : 1;
  }

  private endWord() {
    const word = this.word;
    this.word = null;
    if (!word) return;
    const value: ShellWord = { text: word.text, dynamic: word.dynamic };
    if (this.redirect) {
      if (this.redirect === 'write') this.command.writes.push(value);
      if (this.redirect === 'heredoc') {
        this.pendingHeredocs.push({
          delimiter: word.text.replace(/['"]/g, ''),
          strip: this.heredocStrip,
          command: this.command,
        });
      }
      this.redirect = null;
      return;
    }
    // Group and subshell braces and the negation word start a new command.
    if (!word.quoted && (word.text === '{' || word.text === '}' || word.text === '!')) {
      this.endCommand(false);
      return;
    }
    this.command.words.push(value);
  }

  private endCommand(pipeToNext: boolean) {
    this.endWord();
    const command = this.command;
    if (command.words.length > 0 || command.writes.length > 0) {
      this.out.push(command);
      this.command = {
        words: [],
        writes: [],
        heredocs: [],
        ...(pipeToNext ? { pipedFrom: command } : {}),
      };
    } else {
      this.command = { words: [], writes: [], heredocs: [] };
    }
  }

  private readHeredocBodies() {
    const s = this.script;
    while (this.pendingHeredocs.length > 0) {
      const heredoc = this.pendingHeredocs.shift()!;
      const lines: string[] = [];
      let start = this.i + 1;
      while (start <= s.length) {
        const end = s.indexOf('\n', start);
        const stop = end < 0 ? s.length : end;
        const line = s.slice(start, stop);
        start = stop + 1;
        if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
        lines.push(line);
        if (end < 0) break;
      }
      heredoc.command.heredocs.push(lines.join('\n'));
      this.i = Math.min(s.length, start) - 1;
    }
  }
}

/** The simple commands a shell script runs, substitutions first. */
export function parseShellScript(script: string, depth = 0): ShellCommand[] {
  if (depth > MAX_DEPTH) return [];
  return new ShellScanner(script, depth).scan();
}

export function commandBaseName(word: ShellWord | undefined): string {
  if (!word) return '';
  const slash = word.text.lastIndexOf('/');
  return slash >= 0 ? word.text.slice(slash + 1) : word.text;
}

export function isShellProgram(word: ShellWord | undefined): boolean {
  return SHELLS.has(commandBaseName(word));
}

/**
 * The script a shell invocation runs: the `-c` string, `stdin` when it reads its commands from standard input, or
 * `file` when it runs a script file.
 */
export function shellInvocation(words: ShellWord[]):
  | { kind: 'script'; script: ShellWord }
  | { kind: 'stdin' }
  | {
      kind: 'file';
    } {
  let index = 1;
  if (commandBaseName(words[0]) === 'busybox') index = 2;
  let command = false;
  for (; index < words.length; index++) {
    const text = words[index].text;
    if (text === '--' || text === '-') {
      index++;
      break;
    }
    if (text === '-o' || text === '+o' || text === '-O' || text === '+O') {
      index++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(text)) {
      if (text.startsWith('-') && text.includes('c')) command = true;
      continue;
    }
    if (text.startsWith('--')) continue;
    break;
  }
  if (index < words.length) return command ? { kind: 'script', script: words[index] } : { kind: 'file' };
  return { kind: 'stdin' };
}
