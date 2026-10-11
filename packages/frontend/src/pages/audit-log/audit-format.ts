import type { AuditLogEntry } from "@/types";

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

const AUDIT_TOKEN_ACRONYMS = new Set([
  "acme",
  "ai",
  "api",
  "ca",
  "dns",
  "ip",
  "mcp",
  "oauth",
  "pki",
  "ssl",
  "tls",
]);

export function formatAuditToken(value: string): string {
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) =>
      AUDIT_TOKEN_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(" ");
}

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

/** "Type / name" for an audit entry's resource; the title adds the ID when a name hides it. */
export function getAuditResourceDisplay(entry: AuditLogEntry): { label: string; title: string } {
  const resourceName = entry.resourceName ?? getAuditResourceNameFromDetails(entry.details);
  const resourceValue = resourceName ?? entry.resourceId;
  const resourceType = formatAuditToken(entry.resourceType);
  const label = resourceValue ? `${resourceType} / ${resourceValue}` : resourceType;
  const title =
    resourceName && entry.resourceId && resourceName !== entry.resourceId
      ? `${label} (${entry.resourceId})`
      : label;
  return { label, title };
}

export function buildAuditExportFilename(format: AuditExportFormat): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `gateway-audit-log-${timestamp}.${format}`;
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
    entry.action,
    entry.resourceType,
    entry.resourceId ?? "",
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
  "Resource Type",
  "Resource ID",
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Opfield Audit Log</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#eee}table{border-collapse:collapse;width:100%}th,td{border:1px solid #444;padding:6px;text-align:left;vertical-align:top}th{background:#222}</style></head><body><h1>Opfield Audit Log</h1><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
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
