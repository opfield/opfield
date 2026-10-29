import { LEGACY_NGINX_DIR } from '@/lib/legacy-compat.js';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('ConfigValidatorService');

type ConfigToken =
  | { type: 'statement' | 'blockOpen'; words: string[]; line: number }
  | { type: 'blockClose'; line: number };

interface ParsedConfig {
  tokens: ConfigToken[];
  /** First lexical error. nginx stops reading there; this reader goes on, so nothing after it goes unchecked. */
  syntaxError: string | null;
}

type DenyList = 'advanced' | 'raw' | 'none';

interface CheckOptions {
  denyList: DenyList;
  /** Size, line length and brace checks for stored text; rendered output is checked for directives only. */
  limits: { maxLength: number } | null;
  /** nginx syntax and block structure, for snippets that Handlebars does not assemble into whole statements. */
  syntax: boolean;
  /** Statements (see statementKey) allowed even though their directive is forbidden. */
  allowedStatements?: ReadonlySet<string>;
  /** The text is inserted into a non-root location Opfield renders. */
  insideLocation?: boolean;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

/** `{{logPath}}`, the route's log file prefix, always renders inside nginx's log directory. */
const TEMPLATE_LOG_PATH = /{{\s*logPath\s*}}/g;

/** Statements with forbidden directive names that Opfield's own templates emit, in their template form. */
const OPFIELD_TEMPLATE_STATEMENTS: readonly RegExp[] = [
  /include\s+{{\s*pagesRouteIncludePath\s*}}\s*;/g,
  // legacy-name: the legacy nginx tree in templates saved before 2.12.1 — remove once every node reports none
  new RegExp(
    String.raw`auth_basic_user_file\s+(?:\/etc\/nginx\/opfield|${LEGACY_NGINX_DIR.replaceAll('/', '/')})\/htpasswd\/access-list-{{\s*accessList\.id\s*}}\s*;`,
    'g'
  ),
];

const RAW_MAX_LENGTH = 262144;
const ADVANCED_MAX_LENGTH = 65536;

function isNginxSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

function statementKey(words: readonly string[]): string {
  return words.join('\u0000');
}

/** The argument nginx stores for a token: quotes removed, `\"`, `\'`, `\\`, `\t`, `\r` and `\n` unescaped. */
function unescapeWord(raw: string): string {
  let word = '';
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    const next = raw[index + 1];
    if (char === '\\' && next !== undefined) {
      if (next === '"' || next === "'" || next === '\\') {
        word += next;
        index++;
        continue;
      }
      const control = next === 't' ? '\t' : next === 'r' ? '\r' : next === 'n' ? '\n' : null;
      if (control) {
        word += control;
        index++;
        continue;
      }
    }
    word += char;
  }
  return word;
}

export class ConfigValidatorService {
  private static readonly HANDLEBARS_EXPR_RE = /{{{[\s\S]*?}}}|{{[\s\S]*?}}/g;

  private static stripHandlebarsExpressions(snippet: string): string {
    return snippet.replace(ConfigValidatorService.HANDLEBARS_EXPR_RE, blank);
  }

  /**
   * Directives that must never appear anywhere in user-supplied advanced config snippets.
   * Each entry is checked against the parsed directive name.
   */
  private static readonly ADVANCED_ALWAYS_FORBIDDEN_DIRECTIVES: readonly string[] = [
    'load_module',
    'lua_',
    'perl_',
    'include',
    'access_log',
    'error_log',
    'pid',
    'worker_processes',
    'daemon',
    'master_process',
    'env',
    'ssl_certificate',
    'ssl_certificate_key',
    'internal',
    'satisfy',
    // Advanced location blocks receive the host access policy during rendering.
    // User directives here could replace or disable that protection.
    'allow',
    'deny',
    'auth_basic',
    'auth_basic_user_file',
    'auth_request',
    'auth_request_set',
    'content_by_lua',
  ];

  private static readonly RAW_FORBIDDEN_DIRECTIVES: readonly string[] = [
    'load_module',
    'lua_',
    'perl_',
    'include',
    'pid',
    'worker_processes',
    'daemon',
    'master_process',
    'env',
    'auth_basic_user_file',
    'content_by_lua',
  ];

  /**
   * Directives that are forbidden only at the top level of the advanced snippet
   * (server scope). They are allowed inside custom non-root location blocks.
   */
  private static readonly TOP_LEVEL_FORBIDDEN_DIRECTIVES: readonly string[] = [
    'proxy_pass',
    'root',
    'alias',
    'fastcgi_pass',
    'uwsgi_pass',
    'scgi_pass',
    'grpc_pass',
  ];

  private static readonly ROOT_LOCATION_PATTERNS: readonly RegExp[] = [/^\/$/, /^=\s*\/$/, /^\^~\s*\/$/];

  private static readonly NGINX_LOG_DIRECTORY = '/var/log/nginx/';

  /**
   * nginx opens log files as root when it loads the config, with a log_format of the config's choosing, so a raw
   * config could write any file on the node through access_log or error_log. Outside unrestricted configs logs go
   * to nginx's log directory, to syslog, or nowhere.
   */
  private static logTargetAllowed(name: string, target: string | undefined): boolean {
    if (target === undefined || target.startsWith('syslog:')) return true;
    if (name === 'access_log' && target === 'off') return true;
    if (name === 'error_log' && (target === 'stderr' || target.startsWith('memory:'))) return true;
    return (
      target.startsWith(ConfigValidatorService.NGINX_LOG_DIRECTORY) &&
      !target.includes('$') &&
      !target.split('/').includes('..')
    );
  }

  private static matchesForbiddenDirective(name: string, directive: string): boolean {
    const forbidden = directive.trim().toLowerCase();
    if (!name || !forbidden) return false;
    if (forbidden === 'lua_') {
      return name.startsWith('lua_') || name.includes('_by_lua');
    }
    if (forbidden.endsWith('_') || forbidden === 'content_by_lua') {
      return name.startsWith(forbidden);
    }
    return name === forbidden;
  }

  private static isRootLocation(rest: string): boolean {
    const normalized = rest.trim().replace(/\s+/g, ' ');
    return ConfigValidatorService.ROOT_LOCATION_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  /**
   * Split config text into statements and blocks the way nginx reads it (ngx_conf_read_token): `#` starts a
   * comment and quotes start a string only at the beginning of a token, a backslash escapes the next character
   * inside and outside strings, and `${` stays part of a variable. A tokenizer that disagrees with nginx on any
   * of these would let a directive hide inside what it takes for a comment or a string. After a syntax error it
   * keeps reading: blanked Handlebars expressions leave statements nginx never sees in that form.
   */
  private static parse(text: string): ParsedConfig {
    const tokens: ConfigToken[] = [];
    let words: string[] = [];
    let line = 1;
    let statementLine = 1;
    let start = 0;
    let lastSpace = true;
    let needSpace = false;
    let comment = false;
    let escaped = false;
    let doubleQuoted = false;
    let singleQuoted = false;
    let variable = false;

    const reset = () => {
      words = [];
      lastSpace = true;
      needSpace = false;
      variable = false;
    };
    const end = (type: 'statement' | 'blockOpen') => {
      tokens.push({ type, words, line: statementLine });
      reset();
    };
    let syntaxError: string | null = null;
    const error = (message: string) => {
      syntaxError ??= `${message} on line ${line}`;
    };

    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (char === '\n') {
        line++;
        comment = false;
      }
      if (comment) continue;
      if (escaped) {
        escaped = false;
        continue;
      }

      if (needSpace) {
        if (isNginxSpace(char)) {
          lastSpace = true;
          needSpace = false;
          continue;
        }
        if (char === ';') {
          end('statement');
          continue;
        }
        if (char === '{') {
          end('blockOpen');
          continue;
        }
        if (char !== ')') error(`Unexpected "${char}"`);
        lastSpace = true;
        needSpace = false;
      }

      if (lastSpace) {
        start = index;
        if (words.length === 0) statementLine = line;
        if (isNginxSpace(char)) continue;
        switch (char) {
          case ';':
          case '{':
            if (words.length === 0) error(`Unexpected "${char}"`);
            end(char === '{' ? 'blockOpen' : 'statement');
            continue;
          case '}':
            if (words.length !== 0) {
              error('Unexpected "}"');
              end('statement');
            }
            tokens.push({ type: 'blockClose', line });
            reset();
            continue;
          case '#':
            comment = true;
            continue;
          case '\\':
            escaped = true;
            lastSpace = false;
            continue;
          case '"':
            start = index + 1;
            doubleQuoted = true;
            lastSpace = false;
            continue;
          case "'":
            start = index + 1;
            singleQuoted = true;
            lastSpace = false;
            continue;
          case '$':
            variable = true;
            lastSpace = false;
            continue;
          default:
            lastSpace = false;
            continue;
        }
      }

      if (char === '{' && variable) continue;
      variable = false;
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '$') {
        variable = true;
        continue;
      }
      let found = false;
      if (doubleQuoted) {
        if (char === '"') {
          doubleQuoted = false;
          needSpace = true;
          found = true;
        }
      } else if (singleQuoted) {
        if (char === "'") {
          singleQuoted = false;
          needSpace = true;
          found = true;
        }
      } else if (isNginxSpace(char) || char === ';' || char === '{') {
        lastSpace = true;
        found = true;
      }
      if (!found) continue;
      words.push(unescapeWord(text.slice(start, index)));
      if (char === ';') end('statement');
      else if (char === '{') end('blockOpen');
    }

    if (words.length > 0 || !lastSpace) {
      error('Unexpected end of config, expecting ";" or "}"');
      if (!lastSpace && !needSpace) words.push(unescapeWord(text.slice(start)));
      end('statement');
    }
    return { tokens, syntaxError };
  }

  private static forbiddenDirectiveErrors(
    tokens: readonly ConfigToken[],
    denyList: DenyList,
    allowedStatements?: ReadonlySet<string>,
    insideLocation = false
  ): string[] {
    if (denyList === 'none') return [];
    const errors: string[] = [];
    const blockStack: Array<{ type: 'location'; root: boolean } | { type: 'other' }> = insideLocation
      ? [{ type: 'location', root: false }]
      : [];
    for (const token of tokens) {
      if (token.type === 'blockClose') {
        blockStack.pop();
        continue;
      }
      // nginx matches directive names case-sensitively; comparing lowercase only rejects more.
      const name = token.words[0]?.toLowerCase() ?? '';
      if (!name) {
        if (token.type === 'blockOpen') blockStack.push({ type: 'other' });
        continue;
      }
      const allowed = allowedStatements?.has(statementKey(token.words)) === true;

      if (denyList === 'raw') {
        if (allowed) continue;
        for (const directive of ConfigValidatorService.RAW_FORBIDDEN_DIRECTIVES) {
          if (ConfigValidatorService.matchesForbiddenDirective(name, directive)) {
            errors.push(`Forbidden directive "${directive.trim()}" found on line ${token.line}`);
          }
        }
        if (
          (name === 'access_log' || name === 'error_log') &&
          !ConfigValidatorService.logTargetAllowed(name, token.words[1])
        ) {
          errors.push(
            `Directive "${name}" may only write to ${ConfigValidatorService.NGINX_LOG_DIRECTORY} found on line ${token.line}`
          );
        }
        continue;
      }

      const isTopLevel = blockStack.length === 0;
      for (const directive of ConfigValidatorService.ADVANCED_ALWAYS_FORBIDDEN_DIRECTIVES) {
        if (ConfigValidatorService.matchesForbiddenDirective(name, directive)) {
          errors.push(`Forbidden directive "${directive.trim()}" found on line ${token.line}`);
        }
      }
      if (isTopLevel) {
        for (const directive of ConfigValidatorService.TOP_LEVEL_FORBIDDEN_DIRECTIVES) {
          if (ConfigValidatorService.matchesForbiddenDirective(name, directive)) {
            errors.push(`Forbidden top-level directive "${directive.trim()}" found on line ${token.line}`);
          }
        }
      }
      if (token.type === 'blockOpen') {
        if (name === 'location') {
          const isRoot = ConfigValidatorService.isRootLocation(token.words.slice(1).join(' '));
          if (isTopLevel && isRoot) {
            errors.push(`Forbidden root location block found on line ${token.line}`);
          }
          blockStack.push({ type: 'location', root: isRoot });
        } else {
          blockStack.push({ type: 'other' });
        }
      }
    }
    return errors;
  }

  /** A snippet is inserted into a block Opfield renders, so it must not close that block or leave its own open. */
  private static blockStructureErrors(tokens: readonly ConfigToken[]): string[] {
    const open: number[] = [];
    for (const token of tokens) {
      if (token.type === 'blockOpen') open.push(token.line);
      if (token.type !== 'blockClose') continue;
      if (open.pop() === undefined) return [`Unexpected "}" on line ${token.line}`];
    }
    return open.length > 0 ? [`Block opened on line ${open[open.length - 1]} is not closed`] : [];
  }

  private check(source: string, nginxText: string, options: CheckOptions): ConfigValidationResult {
    const errors: string[] = [];

    // 1. Null byte check
    if (source.includes('\0')) {
      errors.push('Config snippet contains null bytes');
    }

    // 2. Maximum length check
    if (options.limits && source.length > options.limits.maxLength) {
      errors.push(`Config exceeds maximum length of ${options.limits.maxLength / 1024} KB`);
    }

    // 3. Forbidden directives, read the way nginx reads them
    const parsed = ConfigValidatorService.parse(nginxText);
    errors.push(
      ...ConfigValidatorService.forbiddenDirectiveErrors(
        parsed.tokens,
        options.denyList,
        options.allowedStatements,
        options.insideLocation
      )
    );

    if (options.syntax) {
      if (parsed.syntaxError) errors.push(parsed.syntaxError);
      errors.push(...ConfigValidatorService.blockStructureErrors(parsed.tokens));
    }

    if (options.limits) {
      // 4. Excessively long line
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 4096) {
          errors.push(`Line ${i + 1} exceeds maximum length of 4096 characters`);
        }
      }

      // 5. Balanced braces
      let braceDepth = 0;
      for (let i = 0; i < nginxText.length; i++) {
        if (nginxText[i] === '{') braceDepth++;
        if (nginxText[i] === '}') braceDepth--;
        if (braceDepth < 0) {
          errors.push('Unbalanced curly braces: unexpected closing brace');
          break;
        }
      }
      if (braceDepth > 0) {
        errors.push('Unbalanced curly braces: missing closing brace(s)');
      }
    }

    if (errors.length > 0) {
      logger.debug('Config validation failed', { errorCount: errors.length, errors });
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a raw Nginx config snippet for safety.
   *
   * Checks performed:
   * 1. No null bytes
   * 2. No forbidden / dangerous directives
   * 3. Valid nginx syntax with balanced blocks and curly braces
   * 4. No excessively long lines (> 4096 chars)
   * 5. Maximum snippet length (64 KB)
   */
  validate(snippet: string, rawMode = false, bypassRawValidation = false): ConfigValidationResult {
    return this.check(snippet, rawMode ? snippet : ConfigValidatorService.stripHandlebarsExpressions(snippet), {
      denyList: rawMode ? (bypassRawValidation ? 'none' : 'raw') : 'advanced',
      limits: { maxLength: rawMode ? RAW_MAX_LENGTH : ADVANCED_MAX_LENGTH },
      syntax: true,
    });
  }

  /**
   * Validate directives Opfield inserts into a non-root location it renders (Additional Route advanced config).
   * They get the advanced deny-list as if written inside such a location, so location directives like proxy_pass
   * stay allowed. With `unrestricted` only the structure is checked: complete directives that cannot close the
   * location or run into the directives Opfield renders after them.
   */
  validateLocationSnippet(snippet: string, unrestricted = false): ConfigValidationResult {
    return this.check(snippet, snippet, {
      denyList: unrestricted ? 'none' : 'advanced',
      limits: { maxLength: ADVANCED_MAX_LENGTH },
      syntax: true,
      insideLocation: true,
    });
  }

  /**
   * Validate custom nginx template content. A template is raw server configuration rendered by Handlebars:
   * expressions are blanked as in advanced snippets and the raw deny-list applies. The Pages include, the access
   * list password file and the `{{logPath}}` logs that Opfield's own templates emit stay allowed in their template
   * form.
   */
  validateTemplate(content: string): ConfigValidationResult {
    const withoutOpfieldStatements = OPFIELD_TEMPLATE_STATEMENTS.reduce(
      (text, pattern) => text.replace(pattern, blank),
      content.replace(TEMPLATE_LOG_PATH, `${ConfigValidatorService.NGINX_LOG_DIRECTORY}proxy`)
    );
    return this.check(content, ConfigValidatorService.stripHandlebarsExpressions(withoutOpfieldStatements), {
      denyList: 'raw',
      limits: { maxLength: RAW_MAX_LENGTH },
      syntax: false,
    });
  }

  /**
   * Validate what a custom template rendered to. Handlebars can assemble any directive from literals and values,
   * so the output gets the raw deny-list too. Statements authorized elsewhere stay allowed: the given ones (the
   * Pages include and password file paths Opfield generated) and every statement of the route's own advanced
   * snippets, which were validated, or deliberately left unrestricted, when the route was saved.
   */
  validateRenderedTemplate(
    rendered: string,
    trusted: { statements?: readonly (readonly string[])[]; snippets?: readonly string[] } = {}
  ): ConfigValidationResult {
    const allowedStatements = new Set((trusted.statements ?? []).map(statementKey));
    for (const snippet of trusted.snippets ?? []) {
      for (const token of ConfigValidatorService.parse(snippet).tokens) {
        if (token.type !== 'blockClose') allowedStatements.add(statementKey(token.words));
      }
    }
    return this.check(rendered, rendered, { denyList: 'raw', limits: null, syntax: false, allowedStatements });
  }
}
