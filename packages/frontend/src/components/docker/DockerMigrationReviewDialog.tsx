import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  RotateCcw,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import { DetailRow } from "@/components/common/DetailRow";
import { Notice } from "@/components/common/Notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dockerMigrationError } from "@/lib/docker-migration-status";
import { formatBytes } from "@/lib/utils";
import type { DockerMigration, DockerMigrationIssue, DockerMigrationPreflight } from "@/types";
import type { MigrationResource } from "./DockerMigrationDialog";

function formatLabel(value: string) {
  const label = value.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function visibleMigrationPhase(phase: string) {
  return phase === "proxy_cutover" ? "cutover" : phase;
}

function WarningList({ issues }: { issues: DockerMigrationIssue[] }) {
  if (!issues.length) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-warning-text" />
        <h3 className="text-sm font-semibold">Warnings</h3>
        <Badge variant="warning" size="inline">
          {issues.length}
        </Badge>
      </div>
      <div className="divide-y divide-border border border-border">
        {issues.map((issue) => (
          <div key={`${issue.code}:${issue.message}`} className="px-4 py-3">
            <p className="text-sm">{issue.message}</p>
            {issue.detail ? (
              <p className="mt-1 text-xs text-muted-foreground">{issue.detail}</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function VerificationSection({ preflight }: { preflight: DockerMigrationPreflight }) {
  const blocked = preflight.blockers.length > 0;
  const rows = [
    ...preflight.blockers.map((issue) => ({
      key: `${issue.code}:${issue.message}`,
      kind: "blocker" as const,
      message: issue.message,
      detail: issue.detail,
    })),
    ...(preflight.verificationPlan ?? []).map((check) => ({
      key: check,
      kind: "check" as const,
      message: check,
      detail: undefined,
    })),
  ];

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        {blocked ? (
          <AlertTriangle className="h-4 w-4 text-destructive" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-success-text" />
        )}
        <h3 className="text-sm font-semibold">Verification</h3>
      </div>

      {rows.length > 0 ? (
        <ul className="text-sm">
          {rows.map((row, index) => {
            const isBlocker = row.kind === "blocker";
            const followsBlocker = rows[index - 1]?.kind === "blocker";
            const borderColor = "var(--color-border)";
            const errorBorderColor = "var(--color-destructive)";

            return (
              <li
                key={row.key}
                className={`flex items-start gap-2 border-x border-t px-4 py-3 last:border-b ${
                  isBlocker ? "bg-destructive/15" : ""
                }`}
                style={
                  isBlocker
                    ? { borderColor: errorBorderColor }
                    : {
                        borderLeftColor: borderColor,
                        borderRightColor: borderColor,
                        borderTopColor: followsBlocker ? errorBorderColor : borderColor,
                        borderBottomColor: borderColor,
                      }
                }
              >
                {isBlocker ? (
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                ) : (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <p>{row.message}</p>
                  {row.detail ? (
                    <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function MigrationProgress({ migration }: { migration: DockerMigration }) {
  const transferredBytes = Number(migration.progress.transferredBytes ?? 0);
  const totalBytes = Number(migration.progress.totalBytes ?? 0);
  const percent = totalBytes
    ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100))
    : null;
  const completed = migration.status === "completed";
  const migrationError = dockerMigrationError(migration);
  const statusVariant = completed
    ? "success"
    : migration.status === "failed" || migration.status === "needs_attention"
      ? "destructive"
      : migration.status === "cleanup_pending"
        ? "warning"
        : "secondary";

  return (
    <div className="space-y-5">
      <div className="divide-y divide-border border border-border">
        <DetailRow
          label="Status"
          value={<Badge variant={statusVariant}>{formatLabel(migration.status)}</Badge>}
        />
        <DetailRow label="Phase" value={formatLabel(visibleMigrationPhase(migration.phase))} />
      </div>

      {percent !== null ? (
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatBytes(transferredBytes)}</span>
            <span>{formatBytes(totalBytes)}</span>
          </div>
          <div className="h-2 overflow-hidden bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {migration.sourceState !== "running" ? (
        <Notice tone="info" title="The source was stopped">
          The target will remain stopped and no application health check will run.
        </Notice>
      ) : null}

      {migrationError ? (
        <Notice
          tone="destructive"
          role="alert"
          title={
            migration.status === "needs_attention"
              ? "Migration needs attention"
              : "Migration failed"
          }
        >
          {migrationError}
        </Notice>
      ) : null}

      {completed ? (
        <Notice tone="success" role="status" title="Migration completed">
          {migration.keepSource
            ? "The source is stopped and protected from restart."
            : "The verified source resource was removed."}
        </Notice>
      ) : null}
    </div>
  );
}

function PreflightReview({ preflight }: { preflight: DockerMigrationPreflight }) {
  return (
    <div className="space-y-5">
      <VerificationSection preflight={preflight} />
      <WarningList issues={preflight.warnings} />

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Migration plan</h3>
        <div className="divide-y divide-border border border-border">
          <DetailRow label="Source state" value={formatLabel(preflight.sourceState)} />
          {preflight.capacity ? (
            <DetailRow
              label="Target space"
              value={`${formatBytes(preflight.capacity.requiredBytes)} required · ${
                preflight.capacity.availableBytes == null
                  ? "unknown available"
                  : `${formatBytes(preflight.capacity.availableBytes)} available`
              }`}
            />
          ) : null}
          {preflight.artifacts.map((artifact) => (
            <div
              key={`${artifact.kind}:${artifact.sourceIdentity}`}
              className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-4 px-4 py-3 md:grid-cols-[10rem_minmax(0,1fr)]"
            >
              <span className="text-sm text-muted-foreground">{formatLabel(artifact.kind)}</span>
              <span className="min-w-0 text-right text-sm">
                <span className="block truncate" title={artifact.sourceIdentity}>
                  {artifact.sourceIdentity}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {artifact.sizeBytes == null ? "Size pending" : formatBytes(artifact.sizeBytes)}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {(preflight.deletionPlan?.length ?? 0) > 0 ? (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning-foreground" />
            <h3 className="text-sm font-semibold">Removed from source after verification</h3>
          </div>
          <div className="divide-y divide-border border border-border">
            {preflight.deletionPlan?.map((item) => (
              <DetailRow
                key={`${item.type}:${item.name}`}
                label={formatLabel(item.type)}
                value={`${item.name}${item.sizeBytes ? ` · ${formatBytes(item.sizeBytes)}` : ""}`}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function DockerMigrationReviewDialog({
  open,
  resource,
  targetLabel,
  preflight,
  migration,
  loading,
  onBack,
  onStart,
  onCancel,
  onRetryCleanup,
  onResolve,
  onClose,
}: {
  open: boolean;
  resource: MigrationResource;
  targetLabel: string;
  preflight: DockerMigrationPreflight | null;
  migration: DockerMigration | null;
  loading: boolean;
  onBack: () => void;
  onStart: () => void;
  onCancel: () => void;
  onRetryCleanup: () => void;
  onResolve?: () => void;
  onClose: () => void;
}) {
  const canCancel =
    migration &&
    ["pending", "running", "waiting", "cancelling"].includes(migration.status) &&
    !migration.cutoverAt;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{migration ? "Migration Progress" : "Migration Preflight"}</DialogTitle>
          <DialogDescription>
            {resource.displayName} → {targetLabel}
          </DialogDescription>
        </DialogHeader>

        {migration ? (
          <MigrationProgress migration={migration} />
        ) : preflight ? (
          <PreflightReview preflight={preflight} />
        ) : null}

        <DialogFooter>
          {!migration ? (
            <Button variant="outline" onClick={onBack} disabled={loading}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          ) : null}
          {canCancel ? (
            <Button variant="outline" onClick={onCancel} pending={loading}>
              Cancel and roll back
            </Button>
          ) : null}
          {migration?.status === "cleanup_pending" ? (
            <Button variant="outline" onClick={onRetryCleanup} pending={loading}>
              <RotateCcw className="h-4 w-4" />
              Retry cleanup
            </Button>
          ) : null}
          {migration?.status === "needs_attention" && onResolve ? (
            <Button variant="outline" onClick={onResolve} pending={loading}>
              <ShieldCheck className="h-4 w-4" />
              Resolve
            </Button>
          ) : null}
          {!migration && preflight ? (
            <Button onClick={onStart} pending={loading} disabled={preflight.blockers.length > 0}>
              <Truck className="h-4 w-4" />
              Start migration
            </Button>
          ) : null}
          {migration ? (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
