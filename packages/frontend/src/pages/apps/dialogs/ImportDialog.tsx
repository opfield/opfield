// Import existing (canvas frame app-import): pick resources of one type, several at once, and
// the environment they join. A resource of another app moves here. A resource on a node the
// environment does not allow is shown disabled: "Allow <node> in <env> first".
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { environmentLabel, readLastAppEnvironment } from "@/components/apps/app-create-context";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { ContentLoading } from "@/components/common/ContentLoading";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { api } from "@/services/api";
import { planIncludes } from "@/stores/license-paywall";
import type { AppDetail, AppMemberFamily, AppPlaceMemberInput, AppPlaceRefusal } from "@/types";
import { COMPOSE_PROJECT_LABEL } from "../app-resources";
import { orderedEnvironments } from "../app-shared";
import { nodeDisplayName, useNodeIndex } from "../use-node-index";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";

const FAMILY_TEXT: Record<AppMemberFamily, { title: string; plural: string; search: string }> = {
  containers: {
    title: "Import Containers",
    plural: "containers and deployments",
    search: "Search containers...",
  },
  compose: {
    title: "Import Compose Projects",
    plural: "Compose projects",
    search: "Search projects...",
  },
  databases: { title: "Import Databases", plural: "databases", search: "Search databases..." },
  storage: { title: "Import Storage", plural: "storage", search: "Search storage..." },
  routes: { title: "Import Routes", plural: "routes", search: "Search routes..." },
  pages: { title: "Import Pages Projects", plural: "Pages projects", search: "Search projects..." },
};

interface Candidate {
  key: string;
  member: AppPlaceMemberInput;
  name: string;
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
            kind: deployment ? "Deployment" : "Container",
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
        kind: "Compose project",
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
        kind: `${databaseTypeLabel(row.type)}${row.managed ? " · managed" : ""}`,
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
        kind: row.managed ? "Managed storage" : "Storage",
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
          kind: `Route · ${row.type}`,
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

export function ImportDialog({
  app,
  request,
  onClose,
  onImported,
}: {
  app: AppDetail;
  request: ImportRequest | null;
  onClose: () => void;
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
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [refused, setRefused] = useState<AppPlaceRefusal[]>([]);

  useEffect(() => {
    if (!request) return;
    const last = readLastAppEnvironment(app.id);
    const pick =
      environments.find((env) => env.id === request.environmentId) ??
      environments.find((env) => env.id === last) ??
      environments.find((env) => env.isProduction) ??
      environments[0];
    setEnvironmentId(pick?.id ?? null);
    setSearch("");
    setSelected([]);
    setRefused([]);
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
  }, [request, app.id, environments]);

  const environment = environments.find((env) => env.id === environmentId) ?? null;
  const allowed = new Set(environment?.allowedNodeIds ?? []);
  const query = search.trim().toLowerCase();
  const rows = candidates.filter(
    (row) =>
      // Already in the chosen environment: nothing to import.
      !(row.app?.id === app.id && row.app.environmentId === environmentId) &&
      (!query || row.name.toLowerCase().includes(query))
  );
  const blockedReason = (row: Candidate) =>
    row.nodeId && environment && !allowed.has(row.nodeId)
      ? `Allow ${nodeDisplayName(nodesById.get(row.nodeId), row.nodeId)} in ${environment.name} first`
      : null;
  const selectable = new Set(rows.filter((row) => !blockedReason(row)).map((row) => row.key));
  const chosen = selected.filter((key) => selectable.has(key));

  const toggle = (key: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...current, key] : current.filter((item) => item !== key)
    );

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
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={text.search}
            aria-label={text.search}
          />
          {refused.length > 0 && (
            <Notice tone="warning" title={`${refused.length} not imported`}>
              {refused.map((refusal) => (
                <span key={`${refusal.member.type}:${refusal.member.id}`} className="block">
                  {refusedName(refusal)}: {refusal.message}
                </span>
              ))}
            </Notice>
          )}
          {!loading && rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {query ? "Nothing matches your search." : `No ${text.plural} to import.`}
            </p>
          ) : (
            <div className="space-y-2">
              {rows.map((row) => {
                const blocked = blockedReason(row);
                const where = row.app
                  ? row.app.id === app.id
                    ? `in ${row.app.environmentName}`
                    : `in ${row.app.name}`
                  : "not in an app";
                const node = row.nodeId
                  ? nodeDisplayName(nodesById.get(row.nodeId), row.nodeId)
                  : null;
                return (
                  <CheckboxCard
                    key={row.key}
                    checked={chosen.includes(row.key)}
                    onCheckedChange={(checked) => toggle(row.key, checked)}
                    disabled={Boolean(blocked)}
                    label={row.name}
                    description={blocked ?? [row.kind, node, where].filter(Boolean).join(" · ")}
                  />
                );
              })}
            </div>
          )}
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
