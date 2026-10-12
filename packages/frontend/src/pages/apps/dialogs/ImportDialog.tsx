// Import existing (canvas apps/ImportPicker): pick resources of one type, several at once, and the
// environment they join, in one panel like the scope picker. Rows are grouped by node; a node the
// environment does not allow says so once, in its header, with an Allow link. A resource of another
// app moves here.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { environmentLabel, readLastAppEnvironment } from "@/components/apps/app-create-context";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { SCOPE_PICKER_VIEWPORT } from "@/components/common/ScopePicker";
import { ScopeSearchFilter } from "@/components/common/ScopeSearchFilter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { databaseTypeLabel } from "@/lib/database-type";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { planIncludes } from "@/stores/license-paywall";
import type { AppDetail, AppMemberFamily, AppPlaceMemberInput, AppPlaceRefusal } from "@/types";
import { COMPOSE_PROJECT_LABEL } from "../app-resources";
import { orderedEnvironments } from "../app-shared";
import { nodeDisplayName, useNodeIndex } from "../use-node-index";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";

const FAMILY_TEXT: Record<
  AppMemberFamily,
  { title: string; plural: string; search: string; unbound: string }
> = {
  containers: {
    title: "Import Containers",
    plural: "containers and deployments",
    search: "Search containers...",
    unbound: "No node",
  },
  compose: {
    title: "Import Compose Projects",
    plural: "Compose projects",
    search: "Search projects...",
    unbound: "No node",
  },
  databases: {
    title: "Import Databases",
    plural: "databases",
    search: "Search databases...",
    unbound: "External",
  },
  storage: {
    title: "Import Storage",
    plural: "storage",
    search: "Search storage...",
    unbound: "External",
  },
  routes: {
    title: "Import Routes",
    plural: "routes",
    search: "Search routes...",
    unbound: "No node",
  },
  pages: {
    title: "Import Pages Projects",
    plural: "Pages projects",
    search: "Search projects...",
    unbound: "No node",
  },
};

interface Candidate {
  key: string;
  member: AppPlaceMemberInput;
  name: string;
  /** Second line under the name (the image of a container). */
  detail: string | null;
  kind: string;
  nodeId: string | null;
  app: { id: string; name: string; environmentId: string; environmentName: string } | null;
}

async function loadCandidates(family: AppMemberFamily): Promise<Candidate[]> {
  switch (family) {
    case "containers": {
      const rows = await api.listDockerContainerSnapshots();
      return rows
        .filter((row) => !row.labels?.[COMPOSE_PROJECT_LABEL])
        .map((row) => {
          const nodeId = row.nodeId ?? row._nodeId ?? null;
          const deployment = row.kind === "deployment";
          return {
            key: `${nodeId}:${row.id}`,
            member: deployment
              ? { type: "deployment", id: row.deploymentId ?? row.id, nodeId: nodeId ?? undefined }
              : { type: "container", id: row.name, nodeId: nodeId ?? undefined },
            name: row.name,
            detail: row.image || null,
            kind: deployment ? "deployment" : "container",
            nodeId,
            app: row.app ?? null,
          } satisfies Candidate;
        });
    }
    case "compose": {
      const rows = await api.listDockerComposeProjects();
      return rows.map((row) => ({
        key: row.id,
        member: { type: "compose", id: row.id, nodeId: row.nodeId },
        name: row.name,
        detail: null,
        kind: "compose project",
        nodeId: row.nodeId,
        app: row.app ?? null,
      }));
    }
    case "databases": {
      if (!planIncludes("external-database-connections")) return [];
      const rows = (await api.listDatabases({ limit: 200 })).data;
      return rows.map((row) => ({
        key: row.id,
        member: { type: "database", id: row.id },
        name: row.name,
        detail: null,
        kind: `${row.managed ? "managed " : ""}${databaseTypeLabel(row.type)}`,
        nodeId: row.managed?.nodeId ?? null,
        app: row.app ?? null,
      }));
    }
    case "storage": {
      if (!planIncludes("storage-connections")) return [];
      const rows = (await api.listObjectStorages({ limit: 200 })).data;
      return rows.map((row) => ({
        key: row.id,
        member: { type: "storage", id: row.id },
        name: row.name,
        detail: null,
        kind: row.managed ? "managed storage" : "storage",
        nodeId: row.managed?.nodeId ?? null,
        app: row.app ?? null,
      }));
    }
    case "routes": {
      const rows = (await api.listProxyHosts({ limit: 100 })).data;
      return rows
        .filter((row) => !row.isSystem)
        .map((row) => ({
          key: row.id,
          member: { type: "route", id: row.id },
          name: row.domainNames[0] ?? row.slug,
          detail: row.domainNames.length > 1 ? row.domainNames.slice(1).join(", ") : null,
          kind: `route · ${row.type}`,
          nodeId: row.nodeId ?? null,
          app: row.app ?? null,
        }));
    }
    case "pages": {
      if (!planIncludes("pages")) return [];
      const rows = (await api.listPageProjects({ limit: 100 })).data;
      return rows.map((row) => ({
        key: row.id,
        member: { type: "pages", id: row.id },
        name: row.name,
        detail: null,
        kind: "Pages project",
        nodeId: row.nodeId,
        app: row.app ?? null,
      }));
    }
  }
}

export interface ImportRequest {
  family: AppMemberFamily;
  environmentId?: string | null;
}

interface Section {
  key: string;
  /** Header label; null for the one section of a family whose rows have no node. */
  label: string | null;
  nodeId: string | null;
  allowed: boolean;
  rows: Candidate[];
}

export function ImportDialog({
  app,
  request,
  onClose,
  onImported,
}: {
  app: AppDetail;
  request: ImportRequest | null;
  onClose: () => void;
  /** Refreshes the app: after an import, and after Allow adds a node to the environment. */
  onImported: () => void;
}) {
  const shownRequest = useRetainedDialogValue(request, request !== null);
  const family = shownRequest?.family ?? "databases";
  const text = FAMILY_TEXT[family];
  const { byId: nodesById } = useNodeIndex();
  const environments = useMemo(
    () => orderedEnvironments(app.environments).filter((env) => app.permissions.envManage[env.id]),
    [app]
  );
  // The app refreshes after Allow and after an import; that must not reset the open dialog.
  const environmentsRef = useRef(environments);
  environmentsRef.current = environments;
  const appIdRef = useRef(app.id);
  appIdRef.current = app.id;
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [refused, setRefused] = useState<AppPlaceRefusal[]>([]);
  /** Allowed nodes per environment as Allow returned them, until the app refresh catches up. */
  const [allowedOverride, setAllowedOverride] = useState<Record<string, string[]>>({});
  const [allowingNodeId, setAllowingNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    const options = environmentsRef.current;
    const last = readLastAppEnvironment(appIdRef.current);
    const pick =
      options.find((env) => env.id === request.environmentId) ??
      options.find((env) => env.id === last) ??
      options.find((env) => env.isProduction) ??
      options[0];
    setEnvironmentId(pick?.id ?? null);
    setSearch("");
    setSelected([]);
    setRefused([]);
    setAllowedOverride({});
    setLoading(true);
    let cancelled = false;
    loadCandidates(request.family)
      .then((rows) => {
        if (!cancelled) setCandidates(rows.sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((error) => {
        if (!cancelled) toastApiError(error, "Failed to load resources");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const environment = environments.find((env) => env.id === environmentId) ?? null;
  const canManage = Boolean(environment && app.permissions.envManage[environment.id]);
  const allowed = new Set([
    ...(environment?.allowedNodeIds ?? []),
    ...(environment ? (allowedOverride[environment.id] ?? []) : []),
  ]);
  const isAllowed = (nodeId: string | null) => !nodeId || !environment || allowed.has(nodeId);
  const nodeName = (nodeId: string) => nodeDisplayName(nodesById.get(nodeId), nodeId);

  // Already in the chosen environment: nothing to import.
  const importable = candidates.filter(
    (row) => !(row.app?.id === app.id && row.app.environmentId === environmentId)
  );
  const query = search.trim().toLowerCase();
  const visible = importable.filter(
    (row) =>
      !query ||
      row.name.toLowerCase().includes(query) ||
      Boolean(row.detail?.toLowerCase().includes(query))
  );
  const selectable = new Set(
    importable.filter((row) => isAllowed(row.nodeId)).map((row) => row.key)
  );
  const chosen = selected.filter((key) => selectable.has(key));

  const sections: Section[] = [];
  const unbound = visible.filter((row) => !row.nodeId);
  const byNode = new Map<string, Candidate[]>();
  for (const row of visible) {
    if (!row.nodeId) continue;
    byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
  }
  if (unbound.length > 0) {
    sections.push({
      key: "unbound",
      label: byNode.size > 0 ? text.unbound : null,
      nodeId: null,
      allowed: true,
      rows: unbound,
    });
  }
  for (const [nodeId, rows] of [...byNode].sort(([a], [b]) =>
    nodeName(a).localeCompare(nodeName(b))
  )) {
    sections.push({
      key: nodeId,
      label: nodeName(nodeId),
      nodeId,
      allowed: isAllowed(nodeId),
      rows,
    });
  }

  const toggle = (key: string) =>
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    );

  const allowNode = async (nodeId: string) => {
    if (!environment) return;
    setAllowingNodeId(nodeId);
    try {
      const result = await api.allowAppNode(app.id, environment.id, nodeId);
      setAllowedOverride((current) => ({
        ...current,
        [environment.id]: result.nodes.map((node) => node.nodeId),
      }));
      toast.success(`${nodeName(nodeId)} allowed in ${environment.name}`);
      onImported();
    } catch (error) {
      toastApiError(error, "Failed to allow the node");
    } finally {
      setAllowingNodeId(null);
    }
  };

  const submit = async () => {
    if (!environment || chosen.length === 0) return;
    setImporting(true);
    try {
      const members = candidates.filter((row) => chosen.includes(row.key)).map((row) => row.member);
      const result = await api.placeAppMembers({
        target: { appId: app.id, environmentId: environment.id },
        members,
      });
      if (result.placed > 0) {
        toast.success(`${result.placed} imported into ${environment.name}`);
        onImported();
      }
      if (result.refused.length > 0) {
        setRefused(result.refused);
        setSelected([]);
        return;
      }
      onClose();
    } catch (error) {
      toastApiError(error, "Failed to import");
    } finally {
      setImporting(false);
    }
  };

  const refusedName = (refusal: AppPlaceRefusal) =>
    candidates.find(
      (row) =>
        row.member.type === refusal.member.type &&
        row.member.id === refusal.member.id &&
        (row.member.nodeId ?? null) === (refusal.member.nodeId ?? null)
    )?.name ??
    refusal.member.id ??
    refusal.member.type;

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={APP_DIALOG_WIDTH}>
        <ContentLoading loading={loading && candidates.length === 0} />
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>
            Add existing {text.plural} to {app.name}, in the environment you pick. One in another
            app moves here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="app-import-environment">
              Environment
            </label>
            <Select value={environmentId ?? undefined} onValueChange={setEnvironmentId}>
              <SelectTrigger id="app-import-environment" aria-label="Environment">
                <SelectValue placeholder="Select an environment" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {environmentLabel(env)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {refused.length > 0 && (
            <Notice tone="warning" title={`${refused.length} not imported`}>
              {refused.map((refusal) => (
                <span key={`${refusal.member.type}:${refusal.member.id}`} className="block">
                  {refusedName(refusal)}: {refusal.message}
                </span>
              ))}
            </Notice>
          )}
          <div className="flex min-h-0 flex-col border border-border">
            <ScopeSearchFilter
              search={search}
              onSearchChange={setSearch}
              placeholder={text.search}
            />
            <div className={SCOPE_PICKER_VIEWPORT}>
              {!loading && sections.length === 0 ? (
                <EmptyState
                  message={
                    query ? `Nothing matches “${search.trim()}”.` : `No ${text.plural} to import.`
                  }
                  embedded
                />
              ) : (
                sections.map((section) => (
                  <div key={section.key}>
                    {section.label !== null && (
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-1.5">
                        <p className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          {section.label}
                        </p>
                        {!section.allowed && section.nodeId && environment && (
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              Not allowed in {environment.name}
                            </span>
                            {canManage && (
                              <Button
                                variant="link"
                                className="h-auto p-0 text-xs"
                                disabled={allowingNodeId !== null}
                                onClick={() => void allowNode(section.nodeId as string)}
                              >
                                Allow
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {section.rows.map((row) => {
                      const enabled = section.allowed;
                      return (
                        <div key={row.key} className={cn(!enabled && "opacity-40")}>
                          <label
                            className={cn(
                              "flex items-center gap-3 px-3 py-2",
                              enabled
                                ? "cursor-pointer transition-colors hover:bg-accent"
                                : "cursor-default"
                            )}
                          >
                            <input
                              type="checkbox"
                              className="form-checkbox"
                              checked={chosen.includes(row.key)}
                              disabled={!enabled}
                              onChange={() => enabled && toggle(row.key)}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm">{row.name}</p>
                              {row.detail && (
                                <p className="truncate font-mono text-xs text-muted-foreground">
                                  {row.detail}
                                </p>
                              )}
                            </div>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {row.app && row.app.id !== app.id
                                ? `in ${row.app.name} · moves here`
                                : row.kind}
                            </span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-border px-3 py-2">
              <p className="text-xs text-muted-foreground">
                {chosen.length} of {importable.length} selected
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={importing}
            disabled={!environment || chosen.length === 0}
          >
            {chosen.length > 0 ? `Import ${chosen.length}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
