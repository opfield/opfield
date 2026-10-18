import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Nginx + Handlebars stream parser
// ---------------------------------------------------------------------------

const NGINX_KEYWORDS = new Set([
  "server",
  "location",
  "upstream",
  "listen",
  "http2",
  "server_name",
  "proxy_pass",
  "proxy_set_header",
  "proxy_hide_header",
  "proxy_ignore_headers",
  "proxy_cache",
  "proxy_cache_path",
  "proxy_cache_valid",
  "proxy_cache_use_stale",
  "proxy_cache_background_update",
  "proxy_http_version",
  "proxy_connect_timeout",
  "proxy_send_timeout",
  "proxy_read_timeout",
  "proxy_buffering",
  "proxy_buffer_size",
  "proxy_buffers",
  "proxy_busy_buffers_size",
  "proxy_request_buffering",
  "proxy_redirect",
  "proxy_next_upstream",
  "proxy_temp_path",
  "ssl_certificate",
  "ssl_certificate_key",
  "ssl_trusted_certificate",
  "ssl_protocols",
  "ssl_ciphers",
  "ssl_prefer_server_ciphers",
  "ssl_session_cache",
  "ssl_session_timeout",
  "ssl_session_tickets",
  "ssl_stapling",
  "ssl_stapling_verify",
  "access_log",
  "error_log",
  "return",
  "rewrite",
  "try_files",
  "alias",
  "root",
  "index",
  "resolver",
  "resolver_timeout",
  "add_header",
  "add_trailer",
  "auth_basic",
  "auth_basic_user_file",
  "limit_req",
  "limit_req_zone",
  "limit_conn",
  "limit_conn_zone",
  "deny",
  "allow",
  "if",
  "set",
  "map",
  "include",
  "worker_processes",
  "events",
  "http",
  "types",
  "default_type",
  "sendfile",
  "client_max_body_size",
  "client_body_buffer_size",
  "client_body_timeout",
  "client_body_temp_path",
  "client_header_timeout",
  "large_client_header_buffers",
  "keepalive_timeout",
  "keepalive_requests",
  "underscores_in_headers",
  "reset_timedout_connection",
  "chunked_transfer_encoding",
  "expires",
  "etag",
  "gzip",
  "gzip_types",
]);

const yamlLang = StreamLanguage.define({
  token(stream) {
    if (stream.sol() && stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^[-?](?=\s)/)) return "punctuation";
    if (stream.match(/^[A-Za-z0-9_.-]+(?=\s*:)/)) return "propertyName";
    if (stream.match(/^(true|false|null|yes|no|on|off)\b/i)) return "bool";
    if (stream.match(/^-?(?:\d+\.?\d*|\.\d+)\b/)) return "number";
    if (stream.match(/^['"]/)) {
      const quote = stream.current();
      while (!stream.eol()) {
        const next = stream.next();
        if (next === quote && stream.string.charAt(stream.pos - 2) !== "\\") break;
      }
      return "string";
    }
    stream.next();
    return null;
  },
});

const NGINX_VALUES = new Set([
  "on",
  "off",
  "true",
  "false",
  "yes",
  "no",
  "http",
  "https",
  "ssl",
  "http2",
  "permanent",
  "redirect",
  "nodelay",
  "error",
  "timeout",
  "updating",
  "warn",
]);

interface ParserState {
  inHandlebars: boolean;
  inString: string | null; // quote char or null
  inComment: boolean;
}

const nginxHandlebarsLang = StreamLanguage.define<ParserState>({
  startState: () => ({ inHandlebars: false, inString: null, inComment: false }),
  token(stream, state) {
    // Inside Handlebars expression
    if (state.inHandlebars) {
      if (stream.match("}}") || stream.match("}}}")) {
        state.inHandlebars = false;
        return "meta";
      }
      if (
        stream.match("#if") ||
        stream.match("#unless") ||
        stream.match("#each") ||
        stream.match("/if") ||
        stream.match("/unless") ||
        stream.match("/each") ||
        stream.match("else")
      ) {
        return "meta";
      }
      if (stream.match("sanitize") || stream.match("eq")) {
        return "meta";
      }
      if (stream.match(/this\.\w+/)) return "meta";
      if (stream.match(/\w+/)) return "meta";
      stream.next();
      return "meta";
    }

    // Start of Handlebars
    if (stream.match("{{{") || stream.match("{{")) {
      state.inHandlebars = true;
      return "meta";
    }

    // Comment
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }

    // String (double quote)
    if (state.inString === '"' || (!state.inString && stream.peek() === '"')) {
      if (!state.inString) {
        stream.next();
        state.inString = '"';
        return "string";
      }
      if (stream.match(/[^"]*"/)) {
        state.inString = null;
        return "string";
      }
      stream.skipToEnd();
      return "string";
    }

    // String (single quote)
    if (state.inString === "'" || (!state.inString && stream.peek() === "'")) {
      if (!state.inString) {
        stream.next();
        state.inString = "'";
        return "string";
      }
      if (stream.match(/[^']*'/)) {
        state.inString = null;
        return "string";
      }
      stream.skipToEnd();
      return "string";
    }

    // Nginx variable ($...)
    if (stream.match(/\$\w+/)) return "variableName";

    // Number
    if (stream.match(/\d+[smhd]?\b/)) return "number";

    // Braces / semicolons
    if (stream.match("{") || stream.match("}")) return "brace";
    if (stream.match(";")) return "operator";

    // Word
    if (stream.match(/[\w._\-/]+/)) {
      const word = stream.current();
      if (NGINX_KEYWORDS.has(word)) return "keyword";
      if (NGINX_VALUES.has(word)) return "atom";
      return null;
    }

    stream.next();
    return null;
  },
});

// ---------------------------------------------------------------------------
// .env stream parser
// ---------------------------------------------------------------------------

const envLang = StreamLanguage.define<{ inValue: boolean }>({
  startState: () => ({ inValue: false }),
  token(stream, state) {
    // Comment
    if (stream.sol() && stream.match(/\s*#/)) {
      stream.skipToEnd();
      return "comment";
    }

    // Blank line
    if (stream.sol() && stream.match(/\s*$/)) {
      return null;
    }

    // Start of line: KEY part
    if (stream.sol()) {
      state.inValue = false;
      if (stream.match(/export\s+/)) return "keyword";
      if (stream.match(/[A-Za-z_][A-Za-z0-9_]*/)) return "variableName";
    }

    // Equals separator
    if (!state.inValue && stream.match("=")) {
      state.inValue = true;
      return "operator";
    }

    // Value part
    if (state.inValue) {
      // Quoted string
      if (stream.match(/"[^"]*"/) || stream.match(/'[^']*'/)) return "string";
      // Variable reference
      if (stream.match(/\$\{[^}]*\}/) || stream.match(/\$[A-Za-z_][A-Za-z0-9_]*/))
        return "variableName";
      // Number
      if (stream.match(/^\d+$/)) return "number";
      // Rest of value
      stream.skipToEnd();
      return "string";
    }

    stream.next();
    return null;
  },
});

// ---------------------------------------------------------------------------
// SQL stream parser
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "create",
  "table",
  "alter",
  "drop",
  "truncate",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "on",
  "group",
  "by",
  "order",
  "limit",
  "offset",
  "having",
  "as",
  "distinct",
  "union",
  "all",
  "with",
  "and",
  "or",
  "not",
  "null",
  "is",
  "in",
  "exists",
  "between",
  "like",
  "ilike",
  "returning",
  "primary",
  "key",
  "foreign",
  "references",
  "constraint",
  "default",
  "true",
  "false",
  "case",
  "when",
  "then",
  "else",
  "end",
  "begin",
  "commit",
  "rollback",
  "view",
  "index",
  "if",
  "replace",
]);

const SQL_TYPES = new Set([
  "text",
  "integer",
  "int",
  "bigint",
  "smallint",
  "boolean",
  "bool",
  "uuid",
  "json",
  "jsonb",
  "numeric",
  "decimal",
  "real",
  "double",
  "precision",
  "timestamp",
  "date",
  "time",
  "serial",
  "bigserial",
  "varchar",
  "char",
]);

const sqlLang = StreamLanguage.define<{ inBlockComment: boolean }>({
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match("*/")) {
        state.inBlockComment = false;
      } else {
        stream.next();
      }
      return "comment";
    }

    if (stream.match("--")) {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }

    if (stream.match(/'(?:[^']|'')*'/)) return "string";
    if (stream.match(/"(?:[^"]|"")*"/)) return "propertyName";
    if (stream.match(/\b\d+(\.\d+)?\b/)) return "number";
    if (stream.match(/[(),.;]/)) return "brace";
    if (stream.match(/<>|!=|<=|>=|=|<|>|\+|-|\*|\//)) return "operator";

    if (stream.match(/[A-Za-z_][A-Za-z0-9_$]*/)) {
      const word = stream.current().toLowerCase();
      if (SQL_KEYWORDS.has(word)) return "keyword";
      if (SQL_TYPES.has(word)) return "atom";
      return "variableName";
    }

    stream.next();
    return null;
  },
});

// ---------------------------------------------------------------------------
// Theme + highlighting
// ---------------------------------------------------------------------------

const EDITOR_FONT_SIZE_PX = 13;
const EDITOR_LINE_HEIGHT = 1.4;
const EDITOR_CONTENT_PADDING_PX = 8;

/**
 * Focus indicator of an editable code editor, drawn on its container like the ring of other inputs (a 1px ring inside
 * the border). An outline, not the inputs' inset box-shadow: the editor's own background would paint over that.
 * CodeMirror's outline on the focused editor element is switched off in the themes, so nothing inside the box draws one.
 */
export const CODE_EDITOR_FOCUS_CLASS =
  "focus-within:outline focus-within:outline-1 focus-within:outline-ring";

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--color-background)",
    color: "var(--color-foreground)",
    fontSize: `${EDITOR_FONT_SIZE_PX}px`,
    height: "100%",
  },
  "&.cm-focused": {
    outline: "none",
  },
  // The font goes on the scroller: CodeMirror's base theme sets `monospace` there, which
  // would override a font set on the editor root.
  ".cm-scroller": {
    backgroundColor: "var(--color-background)",
    overflow: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    lineHeight: EDITOR_LINE_HEIGHT,
  },
  ".cm-content": {
    caretColor: "var(--color-foreground)",
    padding: `${EDITOR_CONTENT_PADDING_PX}px 0`,
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-background)",
    color: "var(--color-muted-foreground)",
    border: "none",
    borderRight: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 50%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 40%, transparent)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--color-foreground)",
  },
});

const editorGutterBorderTheme = EditorView.theme({
  "& .cm-gutters": {
    borderRight: "1px solid var(--color-border)",
  },
});

const highlightStyles = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "var(--color-hue-violet)" },
    { tag: tags.string, color: "var(--color-hue-green)" },
    { tag: tags.number, color: "var(--color-hue-orange)" },
    { tag: tags.comment, color: "var(--color-muted-foreground)", fontStyle: "italic" },
    { tag: tags.variableName, color: "var(--color-hue-red)" },
    { tag: tags.atom, color: "var(--color-hue-orange)" },
    { tag: tags.propertyName, color: "var(--color-hue-blue)" },
    { tag: tags.operator, color: "var(--color-hue-cyan)" },
    { tag: tags.brace, color: "var(--color-hue-amber)" },
    {
      tag: tags.meta,
      color: "var(--color-hue-amber)",
      backgroundColor: "color-mix(in srgb, var(--color-hue-amber) 8%, transparent)",
      borderRadius: "2px",
    },
  ])
);

// ---------------------------------------------------------------------------
// Error line highlighting
// ---------------------------------------------------------------------------

const errorLineTheme = EditorView.baseTheme({
  ".cm-errorLine": {
    backgroundColor: "color-mix(in srgb, var(--color-destructive) 15%, transparent) !important",
  },
  ".cm-inlineError": {
    backgroundColor: "color-mix(in srgb, var(--color-destructive) 60%, transparent)",
    borderRadius: "2px",
  },
});

const errorLineMark = Decoration.line({ class: "cm-errorLine" });
const inlineErrorMark = Decoration.mark({ class: "cm-inlineError" });

function makeErrorDecorations(
  state: EditorState,
  lines: number[],
  ranges: Array<{ from: number; to: number }>
) {
  const builder = new RangeSetBuilder<Decoration>();
  const sortedLines = [...lines].sort((a, b) => a - b);
  for (const lineNum of sortedLines) {
    if (lineNum >= 1 && lineNum <= state.doc.lines) {
      builder.add(state.doc.line(lineNum).from, state.doc.line(lineNum).from, errorLineMark);
    }
  }
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, state.doc.length));
    const to = Math.max(from, Math.min(range.to, state.doc.length));
    if (from < to) {
      builder.add(from, to, inlineErrorMark);
    }
  }
  return builder.finish();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Height of an editor that shows `lines` lines without a vertical scrollbar: the theme's
 * line height and content padding, the 1px border on both sides when `bordered`, and one
 * pixel for browsers that round line boxes up to their layout unit.
 */
export function codeEditorHeightForLines(lines: number, bordered = true) {
  const content = lines * EDITOR_FONT_SIZE_PX * EDITOR_LINE_HEIGHT + EDITOR_CONTENT_PADDING_PX * 2;
  // toFixed drops float noise such as 197.99999999999997 before rounding up.
  return Math.ceil(Number(content.toFixed(3))) + (bordered ? 2 : 0) + 1;
}

export type CodeEditorLanguage = "nginx" | "env" | "json" | "plain" | "sql" | "xml" | "yaml";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  minHeight?: string;
  height?: string;
  /** Line numbers to highlight with red background (1-based) */
  errorLines?: number[];
  /** Character ranges to highlight inline with an error background */
  errorRanges?: Array<{ from: number; to: number }>;
  /** Syntax highlighting language (default: "nginx") */
  language?: CodeEditorLanguage;
  lineWrapping?: boolean;
  showLineNumbers?: boolean;
  showGutterBorder?: boolean;
  bordered?: boolean;
  /** Keep viewport position when refreshing a read-only generated document. */
  preserveScrollOnChange?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  className = "",
  minHeight = "300px",
  height,
  errorLines = [],
  errorRanges = [],
  language = "nginx",
  lineWrapping = true,
  showLineNumbers = true,
  showGutterBorder = false,
  bordered = true,
  preserveScrollOnChange = false,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const errorCompartmentRef = useRef(new Compartment());
  const initialValueRef = useRef(value);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    errorCompartmentRef.current = new Compartment();

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        ...(showLineNumbers ? [lineNumbers()] : []),
        history(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        indentUnit.of("    "),
        ...(language === "plain"
          ? []
          : [
              language === "json"
                ? json()
                : language === "env"
                  ? envLang
                  : language === "sql"
                    ? sqlLang
                    : language === "yaml"
                      ? yamlLang
                      : language === "xml"
                        ? html()
                        : nginxHandlebarsLang,
            ]),
        ...(language === "json" ? [foldGutter(), keymap.of(foldKeymap)] : []),
        editorTheme,
        ...(showGutterBorder ? [Prec.highest(editorGutterBorderTheme)] : []),
        highlightStyles,
        // Wrapped lines also break inside long unbroken values (paths, hashes) instead of running past the edge.
        ...(lineWrapping
          ? [
              EditorView.lineWrapping,
              EditorView.theme({ ".cm-content": { overflowWrap: "anywhere" } }),
            ]
          : []),
        EditorState.readOnly.of(readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        errorLineTheme,
        errorCompartmentRef.current.of(EditorView.decorations.of(Decoration.none)),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly, language, lineWrapping, showLineNumbers, showGutterBorder]);

  // Sync external value
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      const scrollTop = view.scrollDOM.scrollTop;
      const scrollLeft = view.scrollDOM.scrollLeft;
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
      if (preserveScrollOnChange)
        view.requestMeasure({
          read: () => ({ scrollTop, scrollLeft }),
          write: (position) => {
            view.scrollDOM.scrollTop = position.scrollTop;
            view.scrollDOM.scrollLeft = position.scrollLeft;
          },
        });
    }
  }, [value, preserveScrollOnChange]);

  // Sync error lines via compartment
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const decos =
      errorLines.length > 0 || errorRanges.length > 0
        ? makeErrorDecorations(view.state, errorLines, errorRanges)
        : Decoration.none;
    view.dispatch({
      effects: errorCompartmentRef.current.reconfigure(EditorView.decorations.of(decos)),
    });
  }, [errorLines, errorRanges]);

  return (
    <div
      ref={containerRef}
      // A fixed height wins: `flex-1` would let a flex parent stretch the editor to all its lines.
      // "100%" still fills its parent.
      className={`${bordered ? "border border-border" : ""} overflow-hidden ${height && height !== "100%" ? "flex-none" : "flex-1 min-h-0"} ${readOnly ? "" : `${CODE_EDITOR_FOCUS_CLASS} ${bordered ? "focus-within:-outline-offset-2" : "focus-within:-outline-offset-1"}`} ${className}`}
      style={{
        minHeight: height ? undefined : minHeight,
        ...(height ? { height } : {}),
      }}
    />
  );
}
