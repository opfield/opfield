import { isInternalRegistryImage, workloadImageLabel } from "@/lib/workload-image-label";
import type { AuditLogEntry } from "@/types";
import { formatAuditResourceType, getAuditActionLabel } from "./audit-action-labels";

export type AuditExportFormat = "csv" | "tsv" | "txt" | "html";

export interface AuditFilterUserOption {
  id: string;
  label: string;
}

export function mergeAuditFilterValues(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function mergeAuditFilterUsers(
  current: AuditFilterUserOption[],
  incoming: AuditFilterUserOption[]
): AuditFilterUserOption[] {
  const merged = new Map(current.map((option) => [option.id, option]));
  for (const option of incoming) merged.set(option.id, option);
  return [...merged.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export { formatAuditResourceType, formatAuditToken } from "./audit-action-labels";

export function getAuditEntryUserKey(entry: AuditLogEntry): string {
  return entry.userId ?? "system";
}

export function getAuditEntryUserLabel(entry: AuditLogEntry): string {
  return entry.userName || entry.userEmail || (entry.userId ? entry.userId : "System");
}

/** A readable name for the audited resource, from the fields its action records. */
function getAuditResourceNameFromDetails(details: AuditLogEntry["details"]): string | null {
  if (!details) return null;
  for (const key of [
    "newName",
    "name",
    "displayName",
    "hostname",
    "commonName",
    "cn",
    "domain",
    "containerName",
    "imageRef",
    "key",
  ]) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  for (const key of ["domainNames", "domains"]) {
    const value = details[key];
    if (!Array.isArray(value)) continue;
    const names = value.filter((item): item is string => typeof item === "string" && !!item.trim());
    if (names.length) return names.join(", ");
  }
  return null;
}

/** The resource's readable name (the Opfield account for the cloud link); empty when only its ID is known. */
export function getAuditResourceName(entry: AuditLogEntry): string {
  if (entry.resourceType === "cloud-link") return entry.resourceName || "Opfield account";
  return entry.resourceName ?? getAuditResourceNameFromDetails(entry.details) ?? "";
}

/**
 * "Type / name" for an audit entry's resource; the title adds the ID when a name hides it. The cloud link is named
 * after its Opfield account, never its agent ID.
 */
/**
 * Label and hover text of the entry's resource. The audit log shows the ID when no name is known; an activity
 * feed (`feed`) never does: it shows the type alone, keeps the ID in the hover text, and names a Git-built image
 * instead of its internal registry reference.
 */
export function getAuditResourceDisplay(
  entry: AuditLogEntry,
  options: { feed?: boolean } = {}
): { label: string; title: string } {
  if (entry.resourceType === "cloud-link") {
    const label = entry.resourceName || "Opfield account";
    return { label, title: entry.resourceId ? `${label} (${entry.resourceId})` : label };
  }
  const rawName = entry.resourceName ?? getAuditResourceNameFromDetails(entry.details);
  const resourceName =
    options.feed && rawName && isInternalRegistryImage(rawName)
      ? workloadImageLabel({ image: rawName }).text
      : rawName;
  const resourceValue = resourceName ?? (options.feed ? null : entry.resourceId);
  const resourceType = formatAuditResourceType(entry.resourceType);
  const label = resourceValue ? `${resourceType} / ${resourceValue}` : resourceType;
  const title =
    entry.resourceId && resourceValue !== entry.resourceId
      ? `${label} (${entry.resourceId})`
      : label;
  return { label, title };
}

/** The entry's plain description, for actions that have one; null otherwise. */
export function getAuditDescription(entry: AuditLogEntry): string | null {
  return entry.summary?.trim() || null;
}

export function buildAuditExportFilename(format: AuditExportFormat): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `opfield-audit-log-${timestamp}.${format}`;
}

export function downloadTextFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function auditEntryToExportRow(entry: AuditLogEntry): string[] {
  return [
    new Date(entry.createdAt).toLocaleString(),
    getAuditEntryUserLabel(entry),
    entry.userId ?? "",
    getAuditActionLabel(entry.action),
    entry.action,
    entry.resourceType,
    entry.resourceId ?? "",
    getAuditResourceName(entry),
    entry.summary ?? "",
    entry.ipAddress ?? "",
    entry.userAgent ?? "",
    JSON.stringify(entry.details ?? {}),
  ];
}

const AUDIT_EXPORT_HEADERS = [
  "Time",
  "User",
  "User ID",
  "Action",
  "Action key",
  "Resource Type",
  "Resource ID",
  "Resource",
  "Description",
  "IP Address",
  "User Agent",
  "Details",
];

function escapeDelimitedValue(value: string, delimiter: "," | "\t"): string {
  const normalized = delimiter === "\t" ? value.replace(/[\t\r\n]+/g, " ") : value;
  const safeValue = /^[\t\r\n ]*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  if (delimiter === "\t") return safeValue;
  if (!/[",\r\n]/.test(safeValue)) return safeValue;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function formatDelimitedAuditExport(entries: AuditLogEntry[], delimiter: "," | "\t"): string {
  const rows = [AUDIT_EXPORT_HEADERS, ...entries.map(auditEntryToExportRow)];
  return rows
    .map((row) => row.map((value) => escapeDelimitedValue(value, delimiter)).join(delimiter))
    .join("\n");
}

function formatTextAuditExport(entries: AuditLogEntry[]): string {
  return entries
    .map((entry) => {
      const row = auditEntryToExportRow(entry);
      return AUDIT_EXPORT_HEADERS.map((header, index) => `${header}: ${row[index]}`).join("\n");
    })
    .join("\n\n---\n\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The stand-alone HTML export's stylesheet, in the console's current theme colours (read from the
 * theme tokens at export time; a token that cannot be read leaves the browser default).
 */
function auditExportStyle(): string {
  const style = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const token = (name: string) => style?.getPropertyValue(name).trim() ?? "";
  const declare = (property: string, value: string) => (value ? `${property}:${value};` : "");
  const border = token("--color-border");
  return [
    `body{font-family:system-ui,sans-serif;${declare("background", token("--color-background"))}${declare("color", token("--color-foreground"))}}`,
    "table{border-collapse:collapse;width:100%}",
    `th,td{border:1px solid${border ? ` ${border}` : ""};padding:6px;text-align:left;vertical-align:top}`,
    `th{${declare("background", token("--color-header"))}}`,
  ].join("");
}

function formatHtmlAuditExport(entries: AuditLogEntry[]): string {
  const head = AUDIT_EXPORT_HEADERS.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = entries
    .map(
      (entry) =>
        `<tr>${auditEntryToExportRow(entry)
          .map((value) => `<td>${escapeHtml(value)}</td>`)
          .join("")}</tr>`
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Opfield Audit Log</title><style>${auditExportStyle()}</style></head><body><h1>Opfield Audit Log</h1><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export function formatAuditExport(
  entries: AuditLogEntry[],
  format: AuditExportFormat
): { content: string; type: string } {
  if (format === "csv") {
    return { content: formatDelimitedAuditExport(entries, ","), type: "text/csv;charset=utf-8" };
  }
  if (format === "tsv") {
    return {
      content: formatDelimitedAuditExport(entries, "\t"),
      type: "text/tab-separated-values;charset=utf-8",
    };
  }
  if (format === "html") {
    return { content: formatHtmlAuditExport(entries), type: "text/html;charset=utf-8" };
  }
  return { content: formatTextAuditExport(entries), type: "text/plain;charset=utf-8" };
}
