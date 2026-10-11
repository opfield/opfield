// Shared parts of the Shut Down and Isolate dialogs (canvas frames app-shutdown, app-kill): the scope
// select (all environments or one) and the list of consequences with live counts.
import { useEffect, useState } from "react";
import { SettingsInlineControl } from "@/components/common/SettingsControlRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/services/api";
import type {
  AppDetail,
  AppEnvironmentDetail,
  AppIncidentKind,
  AppIncidentPreview,
  AppIsolationSummary,
  AppShutdownSummary,
} from "@/types";
import { orderedEnvironments, plural } from "../app-shared";

/** `"all"` or an environment id. */
export type IncidentScope = string;
export const ALL_ENVIRONMENTS = "all";

/** Environments the caller may shut down or isolate one by one (apps:operate on them). */
export function operableEnvironments(app: AppDetail): AppEnvironmentDetail[] {
  return orderedEnvironments(app.environments).filter(
    (env) => app.permissions.operate || app.permissions.operateEnv?.[env.id]
  );
}

export function canOperateApp(app: AppDetail): boolean {
  return app.permissions.operate || operableEnvironments(app).length > 0;
}

/** The request's environmentIds for a scope (`null` = every environment). */
export function scopeEnvironmentIds(scope: IncidentScope): string[] | null {
  return scope === ALL_ENVIRONMENTS ? null : [scope];
}

/** Environments the kill switch holds (applying or active): a shutdown of them is refused. */
export function isolatedEnvironments(app: AppDetail): AppEnvironmentDetail[] {
  return orderedEnvironments(app.environments).filter((env) =>
    (env.incidents ?? []).some(
      (incident) =>
        incident.kind === "isolation" &&
        (incident.state === "applying" || incident.state === "active")
    )
  );
}

/**
 * Why Shut down is unavailable for a scope (the server answers 409 APP_ISOLATED): the scope holds an
 * environment the kill switch isolates. Null when the shutdown can run.
 */
export function shutdownBlockedReason(app: AppDetail, scope: IncidentScope): string | null {
  const isolated = isolatedEnvironments(app).filter(
    (env) => scope === ALL_ENVIRONMENTS || env.id === scope
  );
  if (isolated.length === 0) return null;
  const names = isolated.map((env) => env.name).join(", ");
  return `${names} ${isolated.length === 1 ? "is" : "are"} isolated by the app kill switch. Turn the kill switch off before shutting it down.`;
}

/** Why the Shut down button is unavailable: every scope the caller may shut down is isolated. */
export function shutdownUnavailableReason(app: AppDetail): string | null {
  const scopes = [
    ...(app.permissions.operate ? [ALL_ENVIRONMENTS] : []),
    ...operableEnvironments(app).map((env) => env.id),
  ];
  if (scopes.length === 0) return null;
  const reasons = scopes.map((scope) => shutdownBlockedReason(app, scope));
  if (reasons.some((reason) => reason === null)) return null;
  return shutdownBlockedReason(app, scopes[0]!);
}

export function defaultScope(app: AppDetail): IncidentScope {
  return app.permissions.operate ? ALL_ENVIRONMENTS : (operableEnvironments(app)[0]?.id ?? "");
}

export function ScopeSelect({
  app,
  value,
  onChange,
  disabled,
}: {
  app: AppDetail;
  value: IncidentScope;
  onChange: (value: IncidentScope) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsInlineControl label="Scope">
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label="Scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {app.permissions.operate && (
            <SelectItem value={ALL_ENVIRONMENTS}>All environments</SelectItem>
          )}
          {operableEnvironments(app).map((env) => (
            <SelectItem key={env.id} value={env.id}>
              {env.isProduction ? `${env.name} · Production` : env.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsInlineControl>
  );
}

/** Live counts of what the action would change in the scope; null while loading. */
export function useIncidentPreview<K extends AppIncidentKind>(
  app: AppDetail,
  kind: K,
  scope: IncidentScope,
  open: boolean
) {
  const [preview, setPreview] = useState<AppIncidentPreview<K> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !scope) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    api
      .previewAppIncident(app.id, kind, scopeEnvironmentIds(scope))
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Failed to count");
      });
    return () => {
      cancelled = true;
    };
  }, [app.id, kind, scope, open]);
  return { preview, error };
}

export function shutdownConsequences(summary: AppShutdownSummary): string[] {
  const lines: string[] = [];
  const workloads = summary.containers + summary.deployments;
  if (workloads > 0)
    lines.push(
      `${plural(workloads, "container and deployment", "containers and deployments")} stop`
    );
  if (summary.composeProjects > 0)
    lines.push(`${plural(summary.composeProjects, "Compose project")} stop`);
  const engines = [
    summary.databases > 0 ? plural(summary.databases, "managed database") : null,
    summary.storages > 0 ? plural(summary.storages, "managed storage engine") : null,
  ].filter(Boolean);
  if (engines.length > 0) lines.push(`${engines.join(" and ")} stop; their data stays`);
  const routes = [
    summary.routes > 0 ? plural(summary.routes, "route") : null,
    summary.pagesRoutes > 0 ? plural(summary.pagesRoutes, "Pages route") : null,
  ].filter(Boolean);
  if (routes.length > 0) lines.push(`${routes.join(" and ")} show the maintenance page`);
  if (lines.length === 0) lines.push("Nothing runs in this scope right now");
  return lines;
}

export function isolationConsequences(summary: AppIsolationSummary): string[] {
  const lines: string[] = [];
  if (summary.routes > 0) {
    lines.push(
      `${plural(summary.routes, "route")} show the maintenance page; no access code works`
    );
  }
  const cut = [
    summary.links > 0 ? plural(summary.links, "container link") : null,
    summary.bindings > 0 ? `${plural(summary.bindings, "database and storage binding")}` : null,
    summary.secureLinks > 0 ? plural(summary.secureLinks, "Secure Link") : null,
  ].filter(Boolean);
  if (cut.length > 0) lines.push(`${cut.join(", ")} ${cut.length === 1 ? "is" : "are"} cut`);
  const workloads = [
    summary.containers > 0 ? plural(summary.containers, "container") : null,
    summary.composeProjects > 0 ? plural(summary.composeProjects, "Compose project") : null,
  ].filter(Boolean);
  if (workloads.length > 0) lines.push(`${workloads.join(" and ")} lose network access`);
  if (summary.publications > 0) {
    lines.push(`${plural(summary.publications, "direct database or storage port")} close`);
  }
  lines.push("Nothing of the app is reachable; data stays as it is");
  lines.push("Turning it off restores the previous state");
  return lines;
}

export function Consequences({ items }: { items: string[] | null }) {
  if (!items) return <p className="text-sm text-muted-foreground">Counting what this changes…</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
