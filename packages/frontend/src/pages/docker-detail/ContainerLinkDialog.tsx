import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_PROXY_UPSTREAM,
  isProxyUpstreamValid,
  ProxyUpstreamFields,
  type ProxyUpstreamSelection,
} from "@/components/proxy/ProxyUpstreamEditor";
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
import type {
  ContainerLinkCreateInput,
  ContainerLinkEndpoint,
  ContainerLinkEnvironment,
  DockerContainer,
} from "@/types";
import { aliasFromName, composeServiceResourceId, environmentNames } from "./container-link-format";

const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENVIRONMENT_FIELDS: Array<{
  field: keyof ContainerLinkEnvironment;
  label: string;
  placeholder: string;
}> = [
  { field: "host", label: "Host", placeholder: "API_HOST" },
  { field: "port", label: "Port", placeholder: "API_PORT" },
  { field: "url", label: "URL", placeholder: "API_URL" },
];

const EMPTY_SELECTION: ProxyUpstreamSelection = {
  ...DEFAULT_PROXY_UPSTREAM,
  kind: "docker_container",
};

/** The target the picker's selection names, with the name its default alias comes from. */
function selectedTarget(
  selection: ProxyUpstreamSelection,
  workloads: DockerContainer[]
): { endpoint: ContainerLinkEndpoint; name: string } | null {
  if (selection.kind === "docker_deployment") {
    const deployment = workloads.find(
      (workload) =>
        workload.kind === "deployment" &&
        (workload.deploymentId ?? workload.id) === selection.deploymentId
    );
    const nodeId = deployment?.nodeId ?? deployment?._nodeId;
    if (!deployment || !nodeId || !selection.deploymentId) return null;
    return {
      endpoint: { nodeId, type: "deployment", resourceId: selection.deploymentId },
      name: deployment.name,
    };
  }
  if (!selection.dockerNodeId) return null;
  if (selection.containerName) {
    return {
      endpoint: {
        nodeId: selection.dockerNodeId,
        type: "container",
        resourceId: selection.containerName,
      },
      name: selection.containerName,
    };
  }
  if (selection.composeProjectId && selection.composeServiceName) {
    return {
      endpoint: {
        nodeId: selection.dockerNodeId,
        type: "compose_service",
        resourceId: composeServiceResourceId(
          selection.composeProjectId,
          selection.composeServiceName
        ),
      },
      name: selection.composeServiceName,
    };
  }
  return null;
}

/**
 * A workload that can start the link. `key`, `nodeId`, `type`, `workloadName` and
 * `canSetEnvironment` are set when the sources come from different workloads (opened from an app).
 */
export interface ContainerLinkSourceOption {
  resourceId: string;
  label: string;
  key?: string;
  nodeId?: string;
  type?: ContainerLinkEndpoint["type"];
  workloadName?: string;
  canSetEnvironment?: boolean;
}

const sourceKey = (source: ContainerLinkSourceOption) => source.key ?? source.resourceId;

export function ContainerLinkDialog({
  open,
  onOpenChange,
  sourceNodeId,
  sourceType,
  sources,
  workloadName,
  workloads,
  canSetEnvironment,
  onCreate,
  beforeFields,
  description,
  sourceLabel,
  sourcesLoading,
  emptySourcesMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceNodeId: string;
  sourceType: ContainerLinkEndpoint["type"];
  /** The workloads that can start the link: one, or the services of a Compose project. */
  sources: ContainerLinkSourceOption[];
  workloadName: string;
  workloads: DockerContainer[];
  canSetEnvironment: boolean;
  onCreate: (input: ContainerLinkCreateInput) => Promise<boolean>;
  /** Fields above the form (the App and Environment of a link created from an app). */
  beforeFields?: ReactNode;
  description?: string;
  /** Always show the source picker under this label (sources of an app environment). */
  sourceLabel?: string;
  sourcesLoading?: boolean;
  /** Shown instead of the source picker when there is no source. */
  emptySourcesMessage?: string;
}) {
  const [sourceKeyValue, setSourceKeyValue] = useState("");
  const [selection, setSelection] = useState<ProxyUpstreamSelection>(EMPTY_SELECTION);
  const [alias, setAlias] = useState("");
  const [aliasEdited, setAliasEdited] = useState(false);
  const [environment, setEnvironment] = useState<ContainerLinkEnvironment>({});
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSourceKeyValue(sources[0] ? sourceKey(sources[0]) : "");
    setSelection(EMPTY_SELECTION);
    setAlias("");
    setAliasEdited(false);
    setEnvironment({});
  }, [open, sources]);

  const source = sources.find((candidate) => sourceKey(candidate) === sourceKeyValue) ?? null;
  const sourceWorkloadName = source?.workloadName ?? workloadName;
  const sourceCanSetEnvironment = source?.canSetEnvironment ?? canSetEnvironment;

  const target = useMemo(() => selectedTarget(selection, workloads), [selection, workloads]);
  const targetName = target?.name ?? "";

  useEffect(() => {
    if (!aliasEdited) setAlias(aliasFromName(targetName));
  }, [aliasEdited, targetName]);

  const names = environmentNames(environment);
  const environmentValid =
    names.every((name) => ENVIRONMENT_VARIABLE.test(name)) && new Set(names).size === names.length;
  const canCreate =
    Boolean(source) &&
    Boolean(target) &&
    isProxyUpstreamValid(selection) &&
    ALIAS_PATTERN.test(alias) &&
    environmentValid;

  const create = async () => {
    if (!target || !source || !selection.containerPort) return;
    const trimmed = Object.fromEntries(
      ENVIRONMENT_FIELDS.flatMap(({ field }) => {
        const name = environment[field]?.trim();
        return name ? [[field, name]] : [];
      })
    ) as ContainerLinkEnvironment;
    setPending(true);
    try {
      const created = await onCreate({
        sourceNodeId: source.nodeId ?? sourceNodeId,
        sourceType: source.type ?? sourceType,
        sourceResourceId: source.resourceId,
        targetNodeId: target.endpoint.nodeId,
        targetType: target.endpoint.type,
        targetResourceId: target.endpoint.resourceId,
        targetPort: selection.containerPort,
        alias,
        ...(names.length > 0 && sourceCanSetEnvironment ? { environment: trimmed } : {}),
      });
      if (created) onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Container Link</DialogTitle>
          <DialogDescription>
            {description ??
              `${workloadName} will reach one port of another workload by an alias on a private network.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {beforeFields}
          {sourceLabel && !sourcesLoading && sources.length === 0 && emptySourcesMessage ? (
            <p className="text-sm text-muted-foreground">{emptySourcesMessage}</p>
          ) : (
            (sources.length > 1 || sourceLabel) && (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{sourceLabel ?? "Service"}</span>
                <Select
                  value={sourceKeyValue}
                  onValueChange={setSourceKeyValue}
                  disabled={pending || sourcesLoading}
                >
                  <SelectTrigger aria-label={sourceLabel ?? "Service"}>
                    <SelectValue
                      placeholder={
                        sourcesLoading
                          ? "Loading…"
                          : sourceLabel
                            ? "Select a source"
                            : "Select service"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((option) => (
                      <SelectItem key={sourceKey(option)} value={sourceKey(option)}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )
          )}

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Target type</span>
            <Select
              value={selection.kind}
              onValueChange={(kind) =>
                setSelection({
                  ...EMPTY_SELECTION,
                  kind: kind as "docker_container" | "docker_deployment",
                })
              }
              disabled={pending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="docker_container">
                  Docker container or Compose service
                </SelectItem>
                <SelectItem value="docker_deployment">Docker deployment</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <ProxyUpstreamFields
            layout="form"
            value={selection}
            onChange={setSelection}
            containers={workloads}
            disabled={pending}
            allowManual={false}
            showTargetSelect={false}
            showScheme={false}
            resourceDescription="The workload to reach, on any node. It needs no published port."
            portDescription="TCP port of the target the link opens"
          />

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Alias</span>
            <Input
              value={alias}
              onChange={(event) => {
                setAlias(event.target.value.toLowerCase());
                setAliasEdited(true);
              }}
              placeholder="api"
              aria-invalid={alias !== "" && !ALIAS_PATTERN.test(alias)}
              disabled={pending}
            />
            <span className="block text-xs text-muted-foreground">
              The name {sourceWorkloadName} uses to connect, as alias:port. Lower-case letters,
              numbers and hyphens; unique among its links.
            </span>
          </label>

          {sourceCanSetEnvironment && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Environment variables (optional)</span>
              <div className="grid gap-2 sm:grid-cols-3">
                {ENVIRONMENT_FIELDS.map(({ field, label, placeholder }) => (
                  <label key={field} className="block space-y-1.5">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <Input
                      value={environment[field] ?? ""}
                      onChange={(event) =>
                        setEnvironment((current) => ({ ...current, [field]: event.target.value }))
                      }
                      placeholder={placeholder}
                      disabled={pending}
                    />
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Names of variables that hold the target's host, port or URL. Setting any of them
                restarts {sourceWorkloadName} once.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void create()}
            disabled={!canCreate}
            pending={pending}
          >
            Add link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
