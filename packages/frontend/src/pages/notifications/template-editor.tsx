import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json as cmJson } from "@codemirror/lang-json";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import {
  placeholder as cmPlaceholder,
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
} from "@codemirror/view";
import { HelpCircle } from "lucide-react";
import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { ReferenceTable } from "@/components/common/ReferenceTable";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export const UNIVERSAL_VARIABLES = [
  { name: "{{notification.type}}", description: "Notification event type" },
  { name: "{{notification.title}}", description: "Notification title" },
  { name: "{{notification.message}}", description: "Rendered alert message" },
  { name: "{{notification.timestamp}}", description: "Notification ISO timestamp" },
  { name: "{{alert.id}}", description: "Alert rule ID" },
  { name: "{{alert.name}}", description: "Alert rule name" },
  { name: "{{alert.status}}", description: "Alert status" },
  { name: "{{alert.severity}}", description: "Alert severity" },
  { name: "{{alert.severity.emoji}}", description: "Severity emoji" },
  { name: "{{alert.severity.color}}", description: "Severity color (int)" },
  { name: "{{resource.type}}", description: "Resource type" },
  { name: "{{resource.id}}", description: "Real resource ID when known" },
  { name: "{{resource.key}}", description: "Internal alert resource key" },
  { name: "{{resource.name}}", description: "Resource display name" },
  { name: "{{metric.name}}", description: "Metric name" },
  { name: "{{metric.value}}", description: "Current metric value" },
  { name: "{{metric.threshold}}", description: "Configured threshold" },
  { name: "{{metric.operator}}", description: "Comparison operator" },
  { name: "{{metric.duration}}", description: "Fire-after duration (seconds)" },
  { name: "{{node.id}}", description: "Node ID when related" },
  { name: "{{node.name}}", description: "Node hostname/display name" },
  { name: "{{health.status}}", description: "Health status" },
  { name: "{{certificate.days_until_expiry}}", description: "Days until certificate expiry" },
  { name: "{{certificate.expiry_date}}", description: "Certificate expiry date" },
  { name: "{{state.current}}", description: "Current state for stateful events" },
  { name: "{{event.name}}", description: "Event pattern/name" },
  { name: "{{fired.at}}", description: "When alert started firing" },
  { name: "{{fired.duration}}", description: "How long the alert lasted, such as 3m 37s" },
  { name: "{{fired.duration.seconds}}", description: "How long the alert lasted, in seconds" },
  { name: "{{resolution.reason}}", description: "Resolve reason when known" },
  { name: "{{gateway.url}}", description: "Opfield URL" },
];

export { AnimatedHeight };

// ── CodeMirror Template Editor ──────────────────────────────────────

// Handlebars highlighter — variables purple, helpers blue, variable args inside helpers purple
const hbsVarMark = Decoration.mark({ class: "cm-hbs-var" });
const hbsHelperMark = Decoration.mark({ class: "cm-hbs-helper" });
const hbsArgVarMark = Decoration.mark({ class: "cm-hbs-var" }); // higher-priority purple for args

function buildHbsDecos(view: EditorView) {
  const hbsRegex = /\{\{[#/]?[a-zA-Z_][\w.]*(?:\s[^}]*)?\}\}/g;
  const hbsArgVarRegex = /[a-zA-Z_][\w.]*/g;
  const ranges: import("@codemirror/state").Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    let m: RegExpExecArray | null;
    while ((m = hbsRegex.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      const inner = m[0].slice(2, -2).trim();
      const isHelper = inner.startsWith("#") || inner.startsWith("/") || inner.includes(" ");
      // Whole block
      ranges.push((isHelper ? hbsHelperMark : hbsVarMark).range(start, end));
      // For helpers, recolor variable-like arguments inside
      if (isHelper) {
        const nameMatch = inner.match(/^[#/]?[a-zA-Z_][\w.]*/);
        const argsStart = nameMatch ? nameMatch[0].length : 0;
        const argsStr = inner.slice(argsStart);
        hbsArgVarRegex.lastIndex = 0;
        let a: RegExpExecArray | null;
        while ((a = hbsArgVarRegex.exec(argsStr))) {
          const argAbsStart = start + 2 + argsStart + a.index;
          ranges.push(hbsArgVarMark.range(argAbsStart, argAbsStart + a[0].length));
        }
      }
    }
  }
  return Decoration.set(
    ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
  );
}

const hbsHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHbsDecos(view);
    }
    update(update: any) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = buildHbsDecos(update.view);
    }
  },
  { decorations: (v) => v.decorations }
);

const cmTheme = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "transparent" },
  ".cm-content": { fontFamily: "Menlo, Monaco, 'Courier New', monospace", padding: "8px 0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--color-muted-foreground)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 50%, transparent)",
  },
  ".cm-selectionBackground": { backgroundColor: "var(--color-accent)" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--color-accent)" },
  "&.cm-focused": { outline: "1px solid var(--color-ring)", outlineOffset: "-1px" },
  ".cm-line": { padding: "0 12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-foreground)" },
  ".cm-hbs-var": { color: "var(--color-hue-violet) !important", fontWeight: "600" },
  ".cm-hbs-helper": { color: "var(--color-hue-blue) !important", fontWeight: "600" },
});

export interface TemplateEditorHandle {
  insert: (text: string) => void;
}

// ── Template Cheatsheet ───────────────────────────────────────────

const HELPERS_CHEATSHEET = [
  { name: "round", usage: "{{round value 1}}", description: "Round to N decimals" },
  { name: "math", usage: '{{math value "+" 10}}', description: "Arithmetic (+, -, *, /, %)" },
  { name: "percent", usage: "{{percent used total}}", description: "Calculate percentage" },
  {
    name: "formatDuration",
    usage: "{{formatDuration seconds}}",
    description: 'Human format: "5m 30s"',
  },
  { name: "timeago", usage: "{{timeago timestamp}}", description: '"3 minutes ago"' },
  {
    name: "dateformat",
    usage: '{{dateformat timestamp "YYYY-MM-DD HH:mm"}}',
    description: "Custom date format",
  },
  {
    name: "pluralize",
    usage: '{{pluralize count "item" "items"}}',
    description: "Singular/plural",
  },
  { name: "uppercase", usage: "{{uppercase str}}", description: "UPPERCASE" },
  { name: "lowercase", usage: "{{lowercase str}}", description: "lowercase" },
  { name: "truncate", usage: "{{truncate str 50}}", description: "Truncate with ellipsis" },
  { name: "default", usage: '{{default value "N/A"}}', description: "Fallback for null" },
  {
    name: "coalesce",
    usage: "{{coalesce node.name resource.name resource.key}}",
    description: "First non-empty value",
  },
  { name: "json", usage: "{{json obj}}", description: "JSON.stringify" },
  { name: "join", usage: '{{join array ", "}}', description: "Join array elements" },
  {
    name: "eq / ne / gt / lt",
    usage: "{{#if (gt value 90)}}...{{/if}}",
    description: "Conditional logic",
  },
];

export function TemplateCheatsheetLink({
  variables,
}: {
  variables: Array<{ name: string; description: string }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <HelpCircle className="h-3.5 w-3.5" /> Variables & helpers cheatsheet
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Template Cheatsheet</DialogTitle>
            <DialogDescription>
              Variables and Handlebars helpers available in templates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <ReferenceTable
              title="Variables"
              termLabel="Variable"
              rows={variables.map((variable) => ({
                term: variable.name,
                description: variable.description,
              }))}
            />
            <ReferenceTable
              title="Helpers"
              termLabel="Usage"
              rows={HELPERS_CHEATSHEET.map((helper) => ({
                term: helper.usage,
                description: helper.description,
              }))}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── CodeMirror Template Editor ──────────────────────────────────────

const DEFAULT_TEMPLATE_PLACEHOLDER =
  "CPU at {{metric.value}}% on {{resource.name}} (threshold: {{metric.operator}} {{metric.threshold}}%)";

export const TemplateEditor = React.forwardRef<
  TemplateEditorHandle,
  { value: string; onChange: (v: string) => void; minHeight?: number; placeholder?: string }
>(function TemplateEditor(
  { value, onChange, minHeight = 260, placeholder = DEFAULT_TEMPLATE_PLACEHOLDER },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialValueRef = useRef(value);
  const placeholderRef = useRef(placeholder);
  const placeholderCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const isInternalChange = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        EditorView.editable.of(true),
        drawSelection(),
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        syntaxHighlighting(defaultHighlightStyle),
        cmJson(),
        hbsHighlighter,
        cmTheme,
        placeholderCompartment.current.of(cmPlaceholder(placeholderRef.current)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            isInternalChange.current = true;
            onChangeRef.current(update.state.doc.toString());
            isInternalChange.current = false;
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // The example follows the rule being edited (a metric, an event, a resolve).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || placeholderRef.current === placeholder) return;
    placeholderRef.current = placeholder;
    view.dispatch({
      effects: placeholderCompartment.current.reconfigure(cmPlaceholder(placeholder)),
    });
  }, [placeholder]);

  // Sync external value changes (e.g., preset switch)
  useEffect(() => {
    if (isInternalChange.current) return;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: value.length },
      });
    }
  }, [value]);

  useImperativeHandle(ref, () => ({
    insert: (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      // Sync React state
      onChangeRef.current(view.state.doc.toString());
    },
  }));

  return (
    <div
      ref={containerRef}
      className="overflow-hidden border border-input bg-background"
      style={{ minHeight }}
    />
  );
});
