import {
  BookOpen,
  Box,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  FileText,
  Globe,
  HelpCircle,
  Lock,
  Search,
  Send,
  Shield,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AIToolCall } from "@/types/ai";
import {
  AI_CONTROL_DISABLED,
  AI_DISCLOSURE_HEADER,
  AI_DISCLOSURE_HEADER_INTERACTIVE,
  AI_ICON_CONTROL,
} from "./ai-control-classes";

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  list_cas: ShieldCheck,
  get_ca: ShieldCheck,
  create_root_ca: ShieldCheck,
  create_intermediate_ca: ShieldCheck,
  delete_ca: ShieldCheck,
  list_certificates: FileText,
  get_certificate: FileText,
  issue_certificate: FileText,
  revoke_certificate: FileText,
  list_templates: FileText,
  create_template: FileText,
  delete_template: FileText,
  list_routes: Globe,
  get_route: Globe,
  create_route: Globe,
  update_route: Globe,
  delete_route: Globe,
  list_ssl_certificates: Lock,
  request_acme_cert: Lock,
  link_internal_cert: Lock,
  list_domains: Globe,
  create_domain: Globe,
  delete_domain: Globe,
  list_access_lists: Shield,
  create_access_list: Shield,
  delete_access_list: Shield,
  list_users: Users,
  update_user_role: Users,
  get_audit_log: Users,
  get_dashboard_stats: Users,
  list_docker_containers: Box,
  get_docker_container: Box,
  start_docker_container: Box,
  stop_docker_container: Box,
  restart_docker_container: Box,
  remove_docker_container: Box,
  get_docker_container_logs: Box,
  list_docker_images: Box,
  pull_docker_image: Box,
  list_docker_volumes: Box,
  list_docker_networks: Box,
  web_search: Search,
  internal_documentation: BookOpen,
  ask_question: HelpCircle,
  wait: Clock,
  fetch: Globe,
  download_artifact: Download,
  read_artifact: FileText,
  send_artifact: Download,
  read_tool_output: FileText,
  search_tool_output: Search,
};

interface ToolOutputArtifactManifest {
  outputOffloaded: true;
  artifactId: string;
  format: "json" | "text";
  sizeBytes: number;
  estimatedTokens: number;
  preview: string;
  downloadUrl: string;
}

interface AIToolCallBlockProps {
  toolCall: AIToolCall;
  compactSummary?: string;
  /** Interaction controls are rendered by the chat surface next to the composer. */
  onApprove?: (toolCallId: string) => void;
  onReject?: (toolCallId: string) => void;
  onAnswer?: (toolCallId: string, answer: string) => void;
}

export function AIToolCallBlock({ toolCall, compactSummary }: AIToolCallBlockProps) {
  const safeToolCall =
    toolCall && typeof toolCall === "object" ? toolCall : ({} as Partial<AIToolCall>);
  const toolCallKey = typeof safeToolCall.id === "string" ? safeToolCall.id : "unknown-tool-call";
  const [expanded, setExpanded] = useState(() => expandedToolCallKeys.has(toolCallKey));
  const toolName =
    typeof safeToolCall.name === "string" && safeToolCall.name ? safeToolCall.name : "unknown_tool";
  const isCompactContextTool = toolName === "compact_context";
  const toolArguments =
    safeToolCall.arguments &&
    typeof safeToolCall.arguments === "object" &&
    !Array.isArray(safeToolCall.arguments)
      ? safeToolCall.arguments
      : {};
  const toolStatus = safeToolCall.status ?? "failed";
  const Icon =
    toolStatus === "failed" || toolStatus === "rejected"
      ? X
      : CATEGORY_ICONS[toolName] || ShieldCheck;

  const statusIcon = () => {
    switch (toolStatus) {
      case "running":
        return null;
      case "completed":
        return null;
      case "failed":
        return null;
      case "awaiting_approval":
        return null;
      case "rejected":
        return null;
    }
  };

  const isSkipped =
    safeToolCall.result &&
    typeof safeToolCall.result === "object" &&
    "skipped" in (safeToolCall.result as Record<string, unknown>);
  const toolLabel =
    toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) +
    (isSkipped ? " (skipped)" : "");

  const hasArgs = !isCompactContextTool && Object.keys(toolArguments).length > 0;
  const shouldHideResult = toolName === "send_artifact";
  const toolOutputArtifact = getToolOutputArtifact(safeToolCall.result);
  const hasResult =
    !isCompactContextTool &&
    safeToolCall.result !== undefined &&
    !isSkipped &&
    !shouldHideResult &&
    !toolOutputArtifact;
  const compactSummaryText = isCompactContextTool
    ? getCompactSummaryText(compactSummary, safeToolCall.result)
    : "";
  const compactMetadataText = isCompactContextTool
    ? getCompactMetadataText(safeToolCall.result)
    : "";
  const hasCompactSummary = toolStatus === "completed" && compactSummaryText.length > 0;
  const hasError = !!safeToolCall.error;
  const hasContent =
    hasArgs ||
    hasResult ||
    !!toolOutputArtifact ||
    hasCompactSummary ||
    hasError ||
    toolStatus === "rejected";
  const canToggle = hasContent && !(isCompactContextTool && toolStatus === "running");
  const isExpandedChevronVisible = expanded || toolStatus === "running" || toolStatus === "failed";

  return (
    <div className="my-0.5 text-sm">
      {/* Disclosure header: stays a raw button so the stream keeps its inline, borderless rows. */}
      <button
        type="button"
        onClick={
          canToggle
            ? () =>
                setExpanded((value) => {
                  const next = !value;
                  setToolCallExpanded(toolCallKey, next);
                  return next;
                })
            : undefined
        }
        aria-expanded={canToggle ? expanded : undefined}
        className={cn(
          AI_DISCLOSURE_HEADER,
          canToggle ? AI_DISCLOSURE_HEADER_INTERACTIVE : "cursor-default"
        )}
      >
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${
            toolStatus === "running"
              ? "opacity-70"
              : toolStatus === "failed" || toolStatus === "rejected"
                ? "text-destructive"
                : "opacity-70"
          }`}
        />
        <span
          className={`truncate ${isSkipped ? "text-muted-foreground" : ""} ${
            toolStatus === "running" ? "thinking-shimmer text-muted-foreground" : ""
          }`}
        >
          {toolLabel}
        </span>
        {canToggle &&
          (expanded ? (
            <ChevronDown className="-ml-1 h-3 w-3 shrink-0 opacity-70 transition-opacity" />
          ) : (
            <ChevronRight
              className={`-ml-1 h-3 w-3 shrink-0 transition-opacity ${
                isExpandedChevronVisible
                  ? "opacity-70"
                  : "opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70"
              }`}
            />
          ))}
        {!isSkipped && statusIcon()}
      </button>

      {/* Animated expand/collapse */}
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {hasCompactSummary && (
            <div className="border border-border bg-muted/50 px-2.5 py-1.5">
              {compactMetadataText && (
                <p className="mb-1 text-xs text-muted-foreground">{compactMetadataText}</p>
              )}
              <div className="prose dark:prose-invert !max-w-none break-words text-sm prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-pre:my-2 prose-table:my-0 prose-code:text-xs prose-pre:text-xs prose-pre:rounded-none prose-code:rounded-none prose-code:before:content-none prose-code:after:content-none [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0">
                <Markdown remarkPlugins={[remarkGfm]} components={compactMarkdownComponents}>
                  {compactSummaryText}
                </Markdown>
              </div>
            </div>
          )}
          {hasArgs && (
            <pre className="overflow-x-auto whitespace-pre-wrap border border-border bg-muted px-2.5 py-1.5 text-xs">
              {JSON.stringify(toolArguments, null, 2)}
            </pre>
          )}
          {hasResult && (
            <pre
              data-ai-tool-result-scroll
              className={`dashboard-scrollbar max-h-48 overflow-auto overscroll-contain whitespace-pre-wrap border border-border bg-muted/50 px-2.5 py-1.5 text-xs ${hasArgs || hasCompactSummary ? "border-t-0" : ""}`}
            >
              {typeof safeToolCall.result === "string"
                ? safeToolCall.result
                : JSON.stringify(safeToolCall.result, null, 2)}
            </pre>
          )}
          {toolOutputArtifact && (
            <div className="border border-t-0 border-border bg-muted/50 px-2.5 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-foreground">Large output saved to this chat</div>
                  <div className="text-muted-foreground">
                    {formatBytes(toolOutputArtifact.sizeBytes)} ·{" "}
                    {toolOutputArtifact.format.toUpperCase()} · ~
                    {toolOutputArtifact.estimatedTokens.toLocaleString()} tokens
                  </div>
                </div>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs [&_svg]:size-3.5"
                >
                  <a href={toolOutputArtifact.downloadUrl} download>
                    <Download aria-hidden="true" />
                    Download
                  </a>
                </Button>
              </div>
              {toolOutputArtifact.preview && (
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap border border-border bg-background p-2 text-xs">
                  {toolOutputArtifact.preview}
                </pre>
              )}
            </div>
          )}
          {hasError && (
            <p
              className={`border border-border px-2.5 py-1.5 text-destructive ${
                hasArgs || hasResult ? "border-t-0" : ""
              }`}
            >
              {safeToolCall.error}
            </p>
          )}
          {toolStatus === "rejected" && (
            <p className="border border-border px-2.5 py-1.5 italic text-muted-foreground">
              Rejected by user
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const expandedToolCallKeys = new Set<string>();

function setToolCallExpanded(toolCallKey: string, expanded: boolean): void {
  if (expanded) {
    expandedToolCallKeys.add(toolCallKey);
  } else {
    expandedToolCallKeys.delete(toolCallKey);
  }
}

const compactMarkdownComponents = {
  pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
    <pre className="overflow-x-auto border border-border bg-muted p-2 text-foreground" {...props}>
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className={`${className} text-foreground`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="break-words bg-muted px-1 py-0.5 text-xs text-foreground" {...props}>
        {children}
      </code>
    );
  },
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="my-3 overflow-x-auto border border-border bg-background">
      <table
        className="min-w-full text-sm [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:px-2 [&_td]:py-1.5 [&_td]:border-t [&_td]:border-border"
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  a: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-primary underline" target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
};

function getCompactSummaryText(compactSummary: string | undefined, result: unknown): string {
  if (typeof compactSummary === "string" && compactSummary.trim()) return compactSummary.trim();
  if (!result || typeof result !== "object") return "";
  const summary = (result as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary.trim() : "";
}

function getCompactMetadataText(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const value = result as Record<string, unknown>;
  const trigger =
    value.trigger === "auto" || value.compactTrigger === "automatic" ? "Automatic" : "Manual";
  const sourceTokens =
    typeof value.sourceTokenEstimate === "number" ? value.sourceTokenEstimate : null;
  const resultTokens =
    typeof value.resultTokenEstimate === "number" ? value.resultTokenEstimate : null;
  const count =
    typeof value.compactedMessageCount === "number" ? value.compactedMessageCount : null;
  return [
    `${trigger} compaction`,
    count !== null ? `${count.toLocaleString()} messages summarized` : null,
    sourceTokens !== null && resultTokens !== null
      ? `~${sourceTokens.toLocaleString()} → ~${resultTokens.toLocaleString()} tokens`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function getToolOutputArtifact(result: unknown): ToolOutputArtifactManifest | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  if (
    value.outputOffloaded !== true ||
    typeof value.artifactId !== "string" ||
    (value.format !== "json" && value.format !== "text") ||
    typeof value.sizeBytes !== "number" ||
    typeof value.estimatedTokens !== "number" ||
    typeof value.preview !== "string" ||
    typeof value.downloadUrl !== "string"
  ) {
    return null;
  }
  return value as unknown as ToolOutputArtifactManifest;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function ApprovalBlock({
  toolCall,
  onApprove,
  onReject,
}: {
  toolCall: AIToolCall;
  onApprove?: (toolCallId: string) => void;
  onReject?: (toolCallId: string) => void;
}) {
  const isSending = toolCall.approvalDecisionPending === true;
  const hasError = !!toolCall.error;
  const label = hasError
    ? `Could not send decision: ${toolCall.error}`
    : isSending
      ? "Sending approval decision..."
      : "This action requires your approval";

  return (
    <div className="flex items-center gap-3 border border-warning bg-muted/30 px-3 py-2">
      <span className="min-w-0 flex-1 text-sm text-foreground">{label}</span>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" disabled={isSending} onClick={() => onReject?.(toolCall.id)}>
          Reject
        </Button>
        {/* Warning colours: the kit Button has no warning variant yet. */}
        <Button variant="warning" disabled={isSending} onClick={() => onApprove?.(toolCall.id)}>
          Approve
        </Button>
      </div>
    </div>
  );
}

export function QuestionBlock({
  toolCall,
  onAnswer,
}: {
  toolCall: AIToolCall;
  onAnswer?: (id: string, answer: string) => void;
}) {
  const [answerText, setAnswerText] = useState("");
  const safeToolCall =
    toolCall && typeof toolCall === "object" ? toolCall : ({} as Partial<AIToolCall>);
  const args = (
    safeToolCall.arguments &&
    typeof safeToolCall.arguments === "object" &&
    !Array.isArray(safeToolCall.arguments)
      ? safeToolCall.arguments
      : {}
  ) as {
    question?: string;
    options?: Array<{ label: string; description?: string }>;
    allowFreeText?: boolean;
  };
  const question = args.question || "Please provide more information";
  const options = args.options || [];
  const allowFreeText =
    args.allowFreeText !== undefined ? args.allowFreeText : options.length === 0;
  const status = safeToolCall.status ?? "failed";
  const isAnswered = status === "completed" || status === "failed";
  const isPending = status === "running";

  const handleSubmit = (text: string) => {
    if (isPending) return;
    if (!text.trim()) return;
    if (typeof safeToolCall.id === "string") onAnswer?.(safeToolCall.id, text.trim());
  };

  // Already answered
  if (isAnswered) {
    const answer = (safeToolCall.result as { answer?: string })?.answer;
    return (
      <div className="border border-border bg-muted/30 my-1.5 px-3 py-2">
        <p className="text-sm text-muted-foreground">{question}</p>
        {answer && <p className="text-sm mt-1">→ {answer}</p>}
      </div>
    );
  }

  // Not yet active (e.g. still processing on backend)
  if (status !== "awaiting_approval" && status !== "running") {
    return (
      <div className="border border-border bg-muted/30 my-1.5 px-3 py-2">
        <p className="text-sm text-muted-foreground">{question}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="thinking-shimmer">Waiting</span>
        </p>
      </div>
    );
  }

  return (
    <div className="bg-primary/5">
      <div className="px-3 py-2 border-b border-border">
        <p className="text-sm font-medium">{question}</p>
        {safeToolCall.error && (
          <p className="mt-1 text-xs text-destructive">
            Could not send answer: {safeToolCall.error}
          </p>
        )}
        {isPending && (
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="thinking-shimmer">Sending answer...</span>
          </p>
        )}
      </div>

      {options.length > 0 && (
        <div>
          {/* Answer options are list rows, not kit buttons: full width, text-left, row dividers. */}
          {options.map((opt, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleSubmit(opt.label)}
              disabled={isPending}
              className="w-full border-b border-border px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
            >
              <span>{opt.label}</span>
              {opt.description && (
                <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {(allowFreeText || options.length === 0) && (
        <div className="border-t border-border">
          <div className="relative flex">
            <input
              type="text"
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit(answerText);
              }}
              placeholder={options.length > 0 ? "Or type your answer..." : "Type your answer..."}
              className="w-full border-0 bg-background px-2.5 py-1.5 pr-8 text-sm focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring"
              autoFocus
              disabled={isPending}
            />
            <button
              type="button"
              className={cn(
                AI_ICON_CONTROL,
                AI_CONTROL_DISABLED,
                "absolute right-1.5 top-1/2 -translate-y-1/2 p-1"
              )}
              disabled={isPending || !answerText.trim()}
              onClick={() => handleSubmit(answerText)}
              aria-label="Send answer"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
