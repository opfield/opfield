import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { isGatewayManagedDockerNetwork } from "@/lib/docker-networks";
import { api } from "@/services/api";
import type { DockerNetwork } from "@/types";

function normalizeDockerNetwork(network: DockerNetwork | Record<string, unknown>): DockerNetwork {
  const raw = network as Record<string, unknown>;
  return {
    id: String(raw.id ?? raw.Id ?? ""),
    name: String(raw.name ?? raw.Name ?? ""),
    driver: String(raw.driver ?? raw.Driver ?? ""),
    scope: String(raw.scope ?? raw.Scope ?? ""),
    ipam: (raw.ipam ?? raw.IPAM ?? undefined) as DockerNetwork["ipam"],
    containers: (raw.containers ?? raw.Containers ?? undefined) as DockerNetwork["containers"],
  };
}

export interface NetworkEntry {
  name: string;
  networkId: string;
  ipAddress: string;
  gateway: string;
  aliases: string[];
}

export function readAttachedNetworks(
  networks: Record<string, Record<string, unknown>> = {}
): NetworkEntry[] {
  return Object.entries(networks)
    .filter(([name]) => !isGatewayManagedDockerNetwork(name))
    .map(([name, config]) => ({
      name,
      networkId: String(
        config.NetworkID ?? config.networkID ?? config.networkId ?? config.ID ?? config.id ?? ""
      ),
      ipAddress: String(config.IPAddress ?? config.ipAddress ?? ""),
      gateway: String(config.Gateway ?? config.gateway ?? ""),
      aliases: Array.isArray(config.Aliases ?? config.aliases)
        ? ((config.Aliases ?? config.aliases) as unknown[]).map((alias) => String(alias))
        : [],
    }));
}

function isNetworkDraft(network: NetworkEntry) {
  return !network.name && !network.networkId;
}

function isBuiltInDockerNetwork(name: string) {
  return ["bridge", "host", "none"].includes(name);
}

export function NetworksSection({
  nodeId,
  networks,
  setNetworks,
  networksChanged,
  canManageNetworks,
  canListNetworks,
}: {
  nodeId: string;
  networks: NetworkEntry[];
  setNetworks: React.Dispatch<React.SetStateAction<NetworkEntry[]>>;
  networksChanged: boolean;
  canManageNetworks: boolean;
  canListNetworks: boolean;
}) {
  const [allNetworks, setAllNetworks] = useState<DockerNetwork[]>([]);
  // The network picker the section opens with; realtime reloads refresh it in place.
  const [networksLoading, setNetworksLoading] = useState(canListNetworks);
  useContentLoading(networksLoading);

  const selectedNetworkIds = useMemo(
    () => new Set(networks.map((network) => network.networkId).filter(Boolean)),
    [networks]
  );
  const hasAvailableNetwork = useMemo(
    () => allNetworks.some((network) => !selectedNetworkIds.has(network.id)),
    [allNetworks, selectedNetworkIds]
  );
  const hasEmptyNetworkRow = networks.some(isNetworkDraft);
  const addDisabledReason = networksLoading
    ? null
    : hasEmptyNetworkRow
      ? "Choose a network for the empty row first"
      : !hasAvailableNetwork
        ? "This container is already attached to every network on this node. Create a network on the Networks page to attach another."
        : null;

  const loadNetworks = useCallback(async () => {
    if (!canListNetworks) return;
    setNetworksLoading(true);
    try {
      const rows = await api.listDockerNetworks(nodeId);
      setAllNetworks(
        (rows ?? [])
          .map((network) => normalizeDockerNetwork(network))
          .filter((network) => !isGatewayManagedDockerNetwork(network.name))
      );
    } catch (err) {
      toastApiError(err, "Failed to load networks");
    } finally {
      setNetworksLoading(false);
    }
  }, [canListNetworks, nodeId]);

  useEffect(() => {
    if (!canListNetworks) return;
    void loadNetworks();
  }, [canListNetworks, loadNetworks]);

  useRealtime("docker.network.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (!ev || ev.nodeId !== nodeId) return;
    void loadNetworks();
  });

  const addNetwork = () =>
    setNetworks((current) => [
      ...current,
      { name: "", networkId: "", ipAddress: "", gateway: "", aliases: [] },
    ]);

  const removeNetwork = (index: number) =>
    setNetworks((current) => current.filter((_, idx) => idx !== index));

  const updateNetwork = (index: number, networkId: string) => {
    const selected = allNetworks.find((network) => network.id === networkId);
    setNetworks((current) =>
      current.map((entry, idx) =>
        idx === index
          ? {
              ...entry,
              name: selected?.name ?? "",
              networkId,
              ipAddress: "",
              gateway: "",
              aliases: [],
            }
          : entry
      )
    );
  };

  return (
    <PanelShell
      title={
        <SettingsHelpTitle
          label="Networks"
          help="Attached Docker networks determine which containers can reach this container and which network-scoped DNS names and aliases it receives."
        />
      }
      description="Applied instantly without container recreation"
      dirty={networksChanged}
      actions={
        canManageNetworks && canListNetworks ? (
          // The wrapper carries the reason: a disabled button shows no tooltip of its own.
          <span title={addDisabledReason ?? undefined}>
            <Button onClick={addNetwork} disabled={networksLoading || !!addDisabledReason}>
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </span>
        ) : null
      }
    >
      {networks.length > 0 ? (
        <>
          <div
            className={`grid ${
              canManageNetworks
                ? "grid-cols-[minmax(0,1fr)_120px_120px_36px]"
                : "grid-cols-[minmax(0,1fr)_120px_120px]"
            } border-b border-border bg-header text-xs font-medium text-muted-foreground uppercase tracking-wider`}
          >
            <div className="px-3 py-2">Network</div>
            <div className="px-3 py-2 border-l border-border">IP</div>
            <div className="px-3 py-2 border-l border-border">Gateway</div>
            {canManageNetworks && <div />}
          </div>
          <div>
            {networks.map((network, index) => {
              const selectableNetworks = allNetworks.filter(
                (available) =>
                  available.id === network.networkId || !selectedNetworkIds.has(available.id)
              );
              const canRemoveNetwork =
                canManageNetworks && (!network.name || !isBuiltInDockerNetwork(network.name));

              return (
                <div
                  key={`${network.name}:${network.networkId}:${index}`}
                  className={`grid ${
                    canManageNetworks
                      ? "grid-cols-[minmax(0,1fr)_120px_120px_36px]"
                      : "grid-cols-[minmax(0,1fr)_120px_120px]"
                  } border-b border-border last:border-b-0`}
                >
                  <div className="min-w-0">
                    {!isNetworkDraft(network) && network.name ? (
                      <div className="flex min-h-9 min-w-0 items-center px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <span className="block truncate font-medium">{network.name}</span>
                          {network.aliases.length > 0 && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {network.aliases.join(", ")}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <Select
                        value={network.networkId}
                        onValueChange={(value) => updateNetwork(index, value)}
                        disabled={
                          !canManageNetworks || networksLoading || selectableNetworks.length === 0
                        }
                      >
                        <SelectTrigger className="h-9 border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                          <SelectValue
                            placeholder={
                              networksLoading ? "Loading networks..." : "Select a network"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {selectableNetworks.map((available) => (
                            <SelectItem key={available.id} value={available.id}>
                              {available.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="flex items-center border-l border-border px-3 py-2 text-xs font-mono text-muted-foreground">
                    <span className="truncate">{network.ipAddress || "-"}</span>
                  </div>
                  <div className="flex items-center border-l border-border px-3 py-2 text-xs font-mono text-muted-foreground">
                    <span className="truncate">{network.gateway || "-"}</span>
                  </div>
                  {canManageNetworks && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 rounded-none border-l border-border"
                      disabled={!canRemoveNetwork}
                      onClick={() => removeNetwork(index)}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <EmptyState message="No networks" embedded />
      )}
    </PanelShell>
  );
}
