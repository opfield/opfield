import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { DockerBuild, DockerBuildLogChunk } from "@/types";
import { DockerLogViewport } from "./DockerLogViewport";
import { ACTIVE_DOCKER_BUILD_STATUSES, DOCKER_BUILD_STATUS_VARIANT } from "./docker-build-status";

const VULNERABILITY_VARIANT: Record<string, "secondary" | "destructive" | "warning"> = {
  critical: "destructive",
  high: "destructive",
  medium: "warning",
  low: "secondary",
  negligible: "secondary",
  unknown: "secondary",
};

const OS_PACKAGE_TYPES = new Set(["deb", "rpm", "apk", "alpm"]);
const VULNERABILITY_SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;

function MetaRow({
  label,
  children,
  header = false,
}: {
  label: string;
  children: ReactNode;
  header?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 items-center justify-between gap-4 px-4 py-3 ${
        header ? "bg-muted/40" : ""
      }`}
    >
      <span
        className={`shrink-0 text-sm ${
          header ? "font-medium text-foreground" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
      <span className="min-w-0 text-right text-sm">{children}</span>
    </div>
  );
}

interface DockerBuildDetailsDialogProps {
  open: boolean;
  build: DockerBuild | null;
  onOpenChange: (open: boolean) => void;
  onExited: () => void;
}

export function DockerBuildDetailsDialog({
  open,
  build,
  onOpenChange,
  onExited,
}: DockerBuildDetailsDialogProps) {
  const [logs, setLogs] = useState<DockerBuildLogChunk[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [showSystemFindings, setShowSystemFindings] = useState(false);
  const logRequestId = useRef(0);
  const buildId = build?.id ?? null;
  const refreshLogs = useCallback(async () => {
    if (!buildId) return;
    const requestId = ++logRequestId.current;
    try {
      const next = await api.getDockerBuildLogs(buildId);
      if (requestId === logRequestId.current) setLogs(next);
    } catch {
      // Keep the current log output until a realtime refresh succeeds.
    }
  }, [buildId]);

  useEffect(() => {
    setShowSystemFindings(false);
    if (!open || !buildId) return;
    setLogs([]);
    setLoadingLogs(true);
    void refreshLogs().finally(() => setLoadingLogs(false));
    return () => {
      logRequestId.current += 1;
    };
  }, [buildId, open, refreshLogs]);

  useEffect(() => {
    if (!open || !buildId || !build || !ACTIVE_DOCKER_BUILD_STATUSES.has(build.status)) return;
    const interval = window.setInterval(() => {
      if (!document.hidden) void refreshLogs();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [build, buildId, open, refreshLogs]);

  useRealtime(
    open && buildId ? "docker.build.log" : null,
    (payload) => {
      const event = payload as { buildId?: string } | undefined;
      if (event?.buildId === buildId) void refreshLogs();
    },
    { onReconnect: refreshLogs }
  );

  const scanSummary = build?.artifact?.scanSummary ?? null;
  const applicationOnly = scanSummary?.policyScope === "application";
  const validOSCounts =
    scanSummary?.osPackages &&
    VULNERABILITY_SEVERITIES.every(
      (severity) =>
        Number.isSafeInteger(scanSummary.osPackages![severity]) &&
        scanSummary.osPackages![severity] >= 0 &&
        Number.isSafeInteger(scanSummary[severity]) &&
        scanSummary.osPackages![severity] <= scanSummary[severity]
    );
  const osVulnerabilityTotal = validOSCounts
    ? VULNERABILITY_SEVERITIES.reduce(
        (total, severity) => total + scanSummary!.osPackages![severity],
        0
      )
    : null;
  const applicationView = applicationOnly && osVulnerabilityTotal !== null && !showSystemFindings;
  const vulnerabilities = (scanSummary?.vulnerabilities ?? []).filter(
    (finding) => !applicationView || !OS_PACKAGE_TYPES.has(finding.packageType.trim().toLowerCase())
  );
  const visibleCount = (severity: (typeof VULNERABILITY_SEVERITIES)[number]) =>
    (scanSummary?.[severity] ?? 0) - (applicationView ? scanSummary!.osPackages![severity] : 0);
  const vulnerabilityCounts = VULNERABILITY_SEVERITIES.filter(
    (severity) => visibleCount(severity) > 0
  );
  const visibleTotal = VULNERABILITY_SEVERITIES.reduce(
    (total, severity) => total + visibleCount(severity),
    0
  );
  const vulnerabilityTotal = scanSummary
    ? scanSummary.critical +
      scanSummary.high +
      scanSummary.medium +
      scanSummary.low +
      scanSummary.unknown
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            onExited();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Build Details</DialogTitle>
          <DialogDescription>{build?.repositoryFullPath}</DialogDescription>
        </DialogHeader>
        {build && (
          <div className="divide-y divide-border overflow-hidden border border-border bg-card">
            <MetaRow label="Status" header>
              <Badge variant={DOCKER_BUILD_STATUS_VARIANT[build.status]}>
                {build.status.replaceAll("_", " ")}
              </Badge>
            </MetaRow>
            <MetaRow label="Commit">
              <span className="break-all font-mono text-xs">{build.commitSha}</span>
            </MetaRow>
            {build.serviceName && <MetaRow label="Compose service">{build.serviceName}</MetaRow>}
            <MetaRow label="Platform">{build.platform ?? "Not assigned"}</MetaRow>
            <MetaRow label="Build Worker">
              <Badge variant="secondary">
                {build.builderName ?? build.builderNodeId ?? "Waiting"}
              </Badge>
            </MetaRow>
            <MetaRow label="Attempt">
              {build.attempt} of {build.maxAttempts}
            </MetaRow>
            {build.errorMessage && (
              <MetaRow label="Error">
                <span className="break-words text-destructive">{build.errorMessage}</span>
              </MetaRow>
            )}
            {scanSummary?.skipped && (
              <MetaRow label="Vulnerability scan">
                <Badge variant="secondary">Disabled</Badge>
              </MetaRow>
            )}
          </div>
        )}
        {scanSummary && !scanSummary.skipped && vulnerabilityTotal > 0 && (
          <PanelShell
            title="Vulnerabilities"
            description={`${visibleTotal} ${applicationView ? "application-scope findings" : "findings"} detected by ${scanSummary.scanner || "the image scanner"}`}
            actions={
              <div className="flex flex-wrap justify-end gap-1">
                {vulnerabilityCounts.map((severity) => (
                  <Badge key={severity} variant={VULNERABILITY_VARIANT[severity]} size="inline">
                    {visibleCount(severity)} {severity}
                  </Badge>
                ))}
              </div>
            }
            bodyClassName="divide-y divide-border"
          >
            {applicationOnly && (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                {osVulnerabilityTotal === null
                  ? "Application dependency policy requires complete OS package counts. Rebuild with an updated Build Worker."
                  : `Application dependency policy: ${osVulnerabilityTotal} system package findings are report-only. Runtime binaries and unclassified packages still count.`}
              </p>
            )}
            {applicationOnly && osVulnerabilityTotal !== null && osVulnerabilityTotal > 0 && (
              <SettingsControlRow
                title="Include system packages"
                description="Show report-only findings from the full image scan."
              >
                <Switch
                  ariaLabel="Include system packages"
                  checked={showSystemFindings}
                  onChange={setShowSystemFindings}
                />
              </SettingsControlRow>
            )}
            {vulnerabilities.length > 0 ? (
              vulnerabilities.map((vulnerability, index) => (
                <div
                  key={`${vulnerability.id}:${vulnerability.packageName}:${index}`}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs font-medium">{vulnerability.id}</div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {vulnerability.packageName || "Unknown package"}
                      {vulnerability.installedVersion ? ` @ ${vulnerability.installedVersion}` : ""}
                      {vulnerability.packageType ? ` · ${vulnerability.packageType}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {vulnerability.fixedVersions.length > 0
                        ? `Fixed in ${vulnerability.fixedVersions.join(", ")}`
                        : vulnerability.fixState || "No fix reported"}
                    </p>
                    {applicationOnly &&
                      osVulnerabilityTotal !== null &&
                      OS_PACKAGE_TYPES.has(vulnerability.packageType.trim().toLowerCase()) && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          OS package · Report only
                        </p>
                      )}
                  </div>
                  <Badge
                    variant={
                      VULNERABILITY_VARIANT[vulnerability.severity.toLowerCase()] ?? "secondary"
                    }
                    size="inline"
                  >
                    {vulnerability.severity}
                  </Badge>
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-xs text-muted-foreground">
                {applicationView && visibleTotal === 0
                  ? "No application-scope vulnerabilities detected."
                  : "Detailed findings were not retained for this view."}
              </div>
            )}
            {(scanSummary.vulnerabilitiesTruncated ?? 0) > 0 && (
              <div className="px-4 py-3 text-xs text-muted-foreground">
                {scanSummary.vulnerabilitiesTruncated} additional findings were not retained from
                the full image report.
              </div>
            )}
          </PanelShell>
        )}
        {build && (
          <DockerLogViewport
            key={build.id}
            lines={logs}
            keyFn={(line) => line.sequence}
            renderContent={(line) => line.content}
            emptyState={
              <div className="px-4 text-xs text-muted-foreground">
                {loadingLogs ? "Loading build log output…" : "No build log output yet."}
              </div>
            }
            bordered
            className="h-72"
            initialScrollToEnd
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
