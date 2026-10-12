import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import {
  type DatabaseConnection,
  DEFAULT_MANAGED_POSTGRES_CONFIG,
  MANAGED_POSTGRES_MAX_CONNECTIONS,
  MANAGED_POSTGRES_MIN_CONNECTIONS,
} from "@/types";

const FORM_ANIMATION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.16 },
};

function minimumMemoryMb(type: DatabaseConnection["type"]) {
  return type === "clickhouse" ? 512 : 128;
}

function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

export function ManagedDatabaseSettingsTab({
  database,
  onSaved,
}: {
  database: DatabaseConnection;
  onSaved: () => void;
}) {
  const managed = database.managed!;
  const [name, setName] = useState(database.name);
  const [tags, setTags] = useState(database.tags.join(", "));
  const [cpuCores, setCpuCores] = useState(String(managed.runtimeConfig.cpuCores || 1));
  const [memoryMb, setMemoryMb] = useState(
    String(Math.max(minimumMemoryMb(database.type), managed.runtimeConfig.memoryMb))
  );
  const [swapMb, setSwapMb] = useState(String(Math.max(0, managed.runtimeConfig.swapMb)));
  const [interactiveQueryBudgetSeconds, setInteractiveQueryBudgetSeconds] = useState(
    String(database.interactiveQueryBudgetSeconds ?? 300)
  );
  const [publishTcp, setPublishTcp] = useState(
    managed.publishTcp ?? managed.publishedPort !== null
  );
  const [publishedPort, setPublishedPort] = useState(
    managed.publishedPort == null ? "" : String(managed.publishedPort)
  );
  const [publishedNativePort, setPublishedNativePort] = useState(
    managed.publishedNativePort == null ? "" : String(managed.publishedNativePort)
  );
  const [publishNativeTcp, setPublishNativeTcp] = useState(
    managed.publishNativeTcp ?? managed.publishedNativePort !== null
  );
  const [tlsEnabled, setTlsEnabled] = useState(managed.tlsEnabled ?? true);
  const savedMaxConnections =
    managed.postgresConfig?.maxConnections ?? DEFAULT_MANAGED_POSTGRES_CONFIG.maxConnections;
  const [maxConnections, setMaxConnections] = useState(String(savedMaxConnections));
  const [saving, setSaving] = useState(false);
  const [confirmingRecreate, setConfirmingRecreate] = useState(false);

  useEffect(() => {
    setName(database.name);
    setTags(database.tags.join(", "));
    setCpuCores(String(managed.runtimeConfig.cpuCores || 1));
    setMemoryMb(String(Math.max(minimumMemoryMb(database.type), managed.runtimeConfig.memoryMb)));
    setSwapMb(String(Math.max(0, managed.runtimeConfig.swapMb)));
    setInteractiveQueryBudgetSeconds(String(database.interactiveQueryBudgetSeconds ?? 300));
    setPublishTcp(managed.publishTcp ?? managed.publishedPort !== null);
    setPublishedPort(managed.publishedPort == null ? "" : String(managed.publishedPort));
    setPublishedNativePort(
      managed.publishedNativePort == null ? "" : String(managed.publishedNativePort)
    );
    setPublishNativeTcp(managed.publishNativeTcp ?? managed.publishedNativePort !== null);
    setTlsEnabled(managed.tlsEnabled ?? true);
    setMaxConnections(String(savedMaxConnections));
  }, [
    savedMaxConnections,
    database.interactiveQueryBudgetSeconds,
    database.name,
    database.tags,
    database.type,
    managed,
  ]);

  const requestedPort = useMemo(() => {
    const value = publishedPort.trim();
    return value ? Number(value) : null;
  }, [publishedPort]);
  const requestedNativePort = useMemo(() => {
    const value = publishedNativePort.trim();
    return value ? Number(value) : null;
  }, [publishedNativePort]);
  const portIsValid =
    !publishTcp ||
    !publishedPort.trim() ||
    (Number.isInteger(requestedPort) &&
      requestedPort != null &&
      requestedPort >= 1 &&
      requestedPort <= 65535);
  const nativePortIsValid =
    database.type !== "clickhouse" ||
    !publishTcp ||
    !publishNativeTcp ||
    !publishedNativePort.trim() ||
    (Number.isInteger(requestedNativePort) &&
      requestedNativePort != null &&
      requestedNativePort >= 1 &&
      requestedNativePort <= 65535);
  const publicationChanged =
    publishTcp !== (managed.publishTcp ?? managed.publishedPort !== null) ||
    (publishTcp ? requestedPort : null) !== managed.publishedPort ||
    (database.type === "clickhouse" &&
      publishTcp &&
      publishNativeTcp !== (managed.publishNativeTcp ?? managed.publishedNativePort !== null)) ||
    (publishTcp && database.type === "clickhouse" && publishNativeTcp
      ? requestedNativePort
      : null) !== (managed.publishedNativePort ?? null) ||
    tlsEnabled !== (managed.tlsEnabled ?? true);
  const queryBudget = Number(interactiveQueryBudgetSeconds);
  const queryBudgetValid =
    database.type === "redis" ||
    (Number.isInteger(queryBudget) && queryBudget >= 30 && queryBudget <= 600);
  const queryBudgetChanged =
    database.type !== "redis" && queryBudget !== (database.interactiveQueryBudgetSeconds ?? 300);
  const requestedMaxConnections = /^\d+$/.test(maxConnections.trim())
    ? Number(maxConnections)
    : Number.NaN;
  const maxConnectionsValid =
    database.type !== "postgres" ||
    (requestedMaxConnections >= MANAGED_POSTGRES_MIN_CONNECTIONS &&
      requestedMaxConnections <= MANAGED_POSTGRES_MAX_CONNECTIONS);
  const maxConnectionsChanged =
    database.type === "postgres" && requestedMaxConnections !== savedMaxConnections;
  // Both recreate the database container.
  const recreates = publicationChanged || maxConnectionsChanged;
  const managedSettingsChanged =
    name.trim() !== database.name ||
    JSON.stringify(parseTags(tags)) !== JSON.stringify(database.tags) ||
    Number(cpuCores) !== managed.runtimeConfig.cpuCores ||
    Number(memoryMb) !== managed.runtimeConfig.memoryMb ||
    Number(swapMb) !== managed.runtimeConfig.swapMb ||
    recreates;

  // The backend rejects a second change with 409 until the previous one is
  // reconciled; the page reloads on the "ready" event and unlocks the form.
  const operationPending =
    managed.status === "creating" || managed.status === "updating" || managed.status === "deleting";

  const save = async () => {
    const cpu = Number(cpuCores);
    const memory = Number(memoryMb);
    const swap = Number(swapMb);
    if (
      !name.trim() ||
      cpu <= 0 ||
      !Number.isInteger(memory) ||
      memory < minimumMemoryMb(database.type) ||
      !Number.isInteger(swap) ||
      swap < 0 ||
      !portIsValid ||
      !nativePortIsValid ||
      !queryBudgetValid ||
      !maxConnectionsValid
    ) {
      toast.error("Enter valid managed database settings");
      return;
    }
    if (recreates) {
      setConfirmingRecreate(true);
      const confirmed = await confirm({
        title: "Save & Recreate",
        description:
          "Recreating this database will temporarily take it offline. It usually takes about 15 seconds while the database starts and passes its readiness check. Continue?",
        confirmLabel: "Recreate",
        variant: "default",
      });
      setConfirmingRecreate(false);
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      if (queryBudgetChanged) {
        await api.updateDatabase(database.id, {
          interactiveQueryBudgetSeconds: queryBudget,
        });
      }
      if (managedSettingsChanged) {
        await api.updateManagedDatabase(managed.id, {
          name: name.trim(),
          tags: parseTags(tags),
          cpuCores: cpu,
          memoryMb: memory,
          swapMb: swap,
          publishTcp,
          publishedPort: publishTcp ? requestedPort : null,
          ...(database.type === "clickhouse"
            ? {
                publishNativeTcp: publishTcp && publishNativeTcp,
                publishedNativePort: publishTcp && publishNativeTcp ? requestedNativePort : null,
              }
            : {}),
          tlsEnabled,
          ...(maxConnectionsChanged
            ? { postgresConfig: { maxConnections: requestedMaxConnections } }
            : {}),
        });
      }
      toast.success(
        recreates ? "Database settings updated — container recreated" : "Database settings updated"
      );
      onSaved();
    } catch (error) {
      toastApiError(error, "Failed to update managed database");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatedHeight>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="managed-database-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="managed-database-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="managed-database-tags" className="text-sm font-medium">
            Tags
          </label>
          <Input
            id="managed-database-tags"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="team, red:production, green:analytics"
          />
          <p className="text-xs text-muted-foreground">
            Use color:name for colored tags. Supported colors: blue, red, green, yellow, purple,
            pink, orange, gray.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor="managed-database-cpu" className="text-sm font-medium">
              CPU cores
            </label>
            <Input
              id="managed-database-cpu"
              type="number"
              min={0.1}
              step={0.1}
              value={cpuCores}
              onChange={(event) => setCpuCores(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="managed-database-memory" className="text-sm font-medium">
              Memory, MB
            </label>
            <Input
              id="managed-database-memory"
              type="number"
              min={minimumMemoryMb(database.type)}
              value={memoryMb}
              onChange={(event) => setMemoryMb(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="managed-database-swap" className="text-sm font-medium">
              Swap, MB
            </label>
            <Input
              id="managed-database-swap"
              type="number"
              min={0}
              value={swapMb}
              onChange={(event) => setSwapMb(event.target.value)}
            />
          </div>
        </div>

        {database.type !== "redis" && (
          <PanelShell>
            <SettingsControlRow
              controlsClassName="sm:min-w-0"
              title="Interactive query budget"
              description="Total SQL Console time per session, 30–600 s"
            >
              <Input
                aria-label="Interactive query budget"
                type="number"
                min={30}
                max={600}
                value={interactiveQueryBudgetSeconds}
                onChange={(event) => setInteractiveQueryBudgetSeconds(event.target.value)}
                disabled={saving || confirmingRecreate || managed.status === "paused"}
                className="w-32"
              />
            </SettingsControlRow>
            {database.type === "postgres" && (
              <SettingsControlRow
                controlsClassName="sm:min-w-0"
                title="Maximum connections"
                description={`PostgreSQL max_connections, ${MANAGED_POSTGRES_MIN_CONNECTIONS}–${MANAGED_POSTGRES_MAX_CONNECTIONS}`}
              >
                <Input
                  aria-label="Maximum connections"
                  aria-invalid={!maxConnectionsValid}
                  type="number"
                  min={MANAGED_POSTGRES_MIN_CONNECTIONS}
                  max={MANAGED_POSTGRES_MAX_CONNECTIONS}
                  value={maxConnections}
                  onChange={(event) => setMaxConnections(event.target.value)}
                  disabled={saving || confirmingRecreate || managed.status === "paused"}
                  className="w-32"
                />
              </SettingsControlRow>
            )}
          </PanelShell>
        )}

        <PanelShell
          title="Publish TCP port"
          description="Enables direct network connections in addition to secure managed links."
          headerBorder={publishTcp}
          actions={
            <Switch
              checked={publishTcp}
              onChange={(checked) => {
                setPublishTcp(checked);
                if (!checked) setPublishNativeTcp(false);
              }}
              disabled={saving || confirmingRecreate || managed.status === "paused"}
              ariaLabel="Publish TCP port"
            />
          }
        >
          <AnimatePresence initial={false} mode="popLayout">
            {publishTcp && (
              <motion.div key="published-tcp-port" {...FORM_ANIMATION}>
                <SettingsControlRow
                  controlsClassName="sm:min-w-0"
                  title="Published TCP port"
                  description="Leave empty to let Docker allocate a free port. Changing publication recreates only the database container; its storage is retained."
                >
                  <Input
                    id="managed-database-published-port"
                    aria-label="Published TCP port"
                    type="number"
                    min={1}
                    max={65535}
                    value={publishedPort}
                    onChange={(event) => setPublishedPort(event.target.value)}
                    placeholder="Automatic"
                    disabled={saving || confirmingRecreate || managed.status === "paused"}
                  />
                </SettingsControlRow>
                {database.type === "clickhouse" && (
                  <>
                    <SettingsControlRow
                      title="Publish native TCP port"
                      description="Expose the ClickHouse native protocol for native clients."
                      controlsClassName="sm:min-w-0"
                    >
                      <Switch
                        checked={publishNativeTcp}
                        onChange={(checked) => {
                          setPublishNativeTcp(checked);
                          if (!checked) setPublishedNativePort("");
                        }}
                        disabled={saving || confirmingRecreate || managed.status === "paused"}
                        ariaLabel="Publish native TCP port"
                      />
                    </SettingsControlRow>
                    {publishNativeTcp && (
                      <SettingsControlRow
                        controlsClassName="sm:min-w-0"
                        title="Native TCP port"
                        description="Leave empty to let Docker allocate a free port."
                      >
                        <Input
                          aria-label="Native TCP port"
                          type="number"
                          min={1}
                          max={65535}
                          value={publishedNativePort}
                          onChange={(event) => setPublishedNativePort(event.target.value)}
                          placeholder="Automatic"
                          disabled={saving || confirmingRecreate || managed.status === "paused"}
                        />
                      </SettingsControlRow>
                    )}
                  </>
                )}
                <SettingsControlRow
                  title="TLS"
                  description="Encrypt direct database traffic. Secure managed links always remain encrypted."
                  controlsClassName="sm:min-w-0"
                >
                  <Switch
                    checked={tlsEnabled}
                    onChange={setTlsEnabled}
                    disabled={saving || confirmingRecreate || managed.status === "paused"}
                    ariaLabel="Enable TLS"
                  />
                </SettingsControlRow>
              </motion.div>
            )}
          </AnimatePresence>
        </PanelShell>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            onClick={() => void save()}
            pending={saving || operationPending}
            disabled={
              confirmingRecreate ||
              managed.status === "paused" ||
              !portIsValid ||
              !nativePortIsValid ||
              !maxConnectionsValid
            }
          >
            {operationPending
              ? "Applying previous change..."
              : saving
                ? recreates
                  ? "Recreating database..."
                  : "Save Changes"
                : recreates
                  ? "Save & Recreate"
                  : "Save Changes"}
          </Button>
        </DialogFooter>
      </div>
    </AnimatedHeight>
  );
}
