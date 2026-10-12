import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import {
  clearDockerMigrationOwnedByTab,
  markDockerMigrationOwnedByTab,
} from "@/lib/docker-migration-navigation";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { DockerMigration, DockerMigrationPreflight, Node } from "@/types";
import { isNodeIncompatible, isNodeUpdating } from "@/types";
import { confirmDockerMigrationResolve } from "./confirm-docker-migration-resolve";
import { DockerMigrationReviewDialog } from "./DockerMigrationReviewDialog";
import { DockerMigrationSetupDialog } from "./DockerMigrationSetupDialog";

export type MigrationResource =
  | {
      type: "container";
      nodeId: string;
      containerName: string;
      displayName: string;
      sourceState: string;
    }
  | {
      type: "deployment";
      nodeId: string;
      deploymentId: string;
      displayName: string;
      sourceState: string;
    };

type DialogSurface = "setup" | "between" | "review";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cleanup_pending",
  "needs_attention",
  "cancelled",
]);

const DIALOG_TRANSITION_MS = 160;

export function DockerMigrationDialog({
  open,
  onOpenChange,
  onCutover,
  initialMigration,
  resource,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCutover?: (migration: DockerMigration) => void;
  initialMigration?: DockerMigration | null;
  resource: MigrationResource;
}) {
  const [surface, setSurface] = useState<DialogSurface>("setup");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [targetNodeId, setTargetNodeId] = useState("");
  const [keepSource, setKeepSource] = useState(false);
  const [preflight, setPreflight] = useState<DockerMigrationPreflight | null>(null);
  const [migration, setMigration] = useState<DockerMigration | null>(null);
  // Target nodes load on every opening; the setup dialog waits for them.
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [loadingAction, setLoadingAction] = useState(false);
  const transitionTimer = useRef<number | null>(null);
  const routedMigration = useRef<string | null>(null);
  const wasOpen = useRef(false);

  const clearTransitionTimer = useCallback(() => {
    if (transitionTimer.current !== null) {
      window.clearTimeout(transitionTimer.current);
      transitionTimer.current = null;
    }
  }, []);

  const transitionTo = useCallback(
    (next: Exclude<DialogSurface, "between">) => {
      clearTransitionTimer();
      setSurface("between");
      transitionTimer.current = window.setTimeout(() => {
        setSurface(next);
        transitionTimer.current = null;
      }, DIALOG_TRANSITION_MS);
    },
    [clearTransitionTimer]
  );

  useEffect(() => {
    if (open && !wasOpen.current) {
      clearTransitionTimer();
      setSurface(initialMigration ? "review" : "setup");
      setTargetNodeId(initialMigration?.targetNodeId ?? "");
      setKeepSource(false);
      setPreflight(null);
      setMigration(initialMigration ?? null);
      routedMigration.current = initialMigration?.id ?? null;
    }
    if (!open && wasOpen.current) clearTransitionTimer();
    wasOpen.current = open;
  }, [clearTransitionTimer, initialMigration, open]);

  useEffect(() => () => clearTransitionTimer(), [clearTransitionTimer]);

  useEffect(() => {
    if (!open || initialMigration) {
      setTargetsLoaded(false);
      return;
    }
    let cancelled = false;
    api
      .listNodes({ type: "docker", limit: 100 })
      .then((response) => {
        if (cancelled) return;
        setNodes(
          response.data.filter(
            (node) =>
              node.id !== resource.nodeId &&
              node.status === "online" &&
              node.isConnected &&
              !isNodeUpdating(node) &&
              !isNodeIncompatible(node)
          )
        );
      })
      .catch((error) => {
        if (!cancelled) toastApiError(error, "Failed to load Docker nodes");
      })
      .finally(() => {
        if (!cancelled) setTargetsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [initialMigration, open, resource.nodeId]);
  const loadingTargets = open && !initialMigration && !targetsLoaded;

  const loadMigration = useCallback(async (id: string) => {
    try {
      setMigration(await api.getDockerMigration(id));
    } catch {}
  }, []);

  useRealtime("docker.migration.changed", (payload) => {
    const event = payload as { id?: string; migrationId?: string };
    const id = event.migrationId ?? event.id;
    if (migration && id === migration.id) void loadMigration(migration.id);
  });

  useEffect(() => {
    if (!migration || TERMINAL_STATUSES.has(migration.status)) return;
    const timer = window.setInterval(() => void loadMigration(migration.id), 5_000);
    return () => window.clearInterval(timer);
  }, [loadMigration, migration]);

  useEffect(() => {
    if (!migration?.cutoverAt || routedMigration.current === migration.id) {
      return;
    }
    routedMigration.current = migration.id;
    onCutover?.(migration);
  }, [migration, onCutover]);

  const request = useMemo(
    () => ({
      resource:
        resource.type === "container"
          ? { type: "container" as const, containerName: resource.containerName }
          : { type: "deployment" as const, deploymentId: resource.deploymentId },
      sourceNodeId: resource.nodeId,
      targetNodeId,
      keepSource,
    }),
    [keepSource, resource, targetNodeId]
  );

  const runPreflight = async () => {
    if (!targetNodeId) return;
    setLoadingAction(true);
    try {
      setPreflight(await api.preflightDockerMigration(request));
      transitionTo("review");
    } catch (error) {
      if (!handleLicenseApiError(error, "Cross-node migration")) {
        toastApiError(error, "Migration preflight failed");
      }
    } finally {
      setLoadingAction(false);
    }
  };

  const startMigration = async () => {
    if (!preflight) return;
    setLoadingAction(true);
    try {
      const started = await api.startDockerMigration({
        ...request,
        preflightFingerprint: preflight.fingerprint,
      });
      markDockerMigrationOwnedByTab(started.id);
      setMigration(started);
      toast.success("Migration started");
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "MIGRATION_PREFLIGHT_STALE") {
        setPreflight(null);
        transitionTo("setup");
      }
      if (!handleLicenseApiError(error, "Cross-node migration")) {
        toastApiError(error, "Failed to start migration");
      }
    } finally {
      setLoadingAction(false);
    }
  };

  const cancelMigration = async () => {
    if (!migration) return;
    setLoadingAction(true);
    try {
      setMigration(await api.cancelDockerMigration(migration.id));
    } catch (error) {
      toastApiError(error, "Failed to cancel migration");
    } finally {
      setLoadingAction(false);
    }
  };

  const retryCleanup = async () => {
    if (!migration) return;
    setLoadingAction(true);
    try {
      setMigration(await api.retryDockerMigrationCleanup(migration.id));
    } catch (error) {
      toastApiError(error, "Failed to retry cleanup");
    } finally {
      setLoadingAction(false);
    }
  };

  const resolveMigration = async () => {
    if (!migration) return;
    const side = await confirmDockerMigrationResolve(migration);
    if (!side) return;
    setLoadingAction(true);
    try {
      setMigration(await api.resolveDockerMigration(migration.id, side));
      toast.success("Migration resolved");
    } catch (error) {
      toastApiError(error, "Failed to resolve migration");
    } finally {
      setLoadingAction(false);
    }
  };

  const changeTargetNode = (value: string) => {
    setTargetNodeId(value);
    setPreflight(null);
  };

  const changeKeepSource = (value: boolean) => {
    setKeepSource(value);
    setPreflight(null);
  };

  const backToSetup = () => {
    setPreflight(null);
    transitionTo("setup");
  };

  const closeDialog = () => {
    if (migration) clearDockerMigrationOwnedByTab(migration.id);
    onOpenChange(false);
  };

  const targetNode = nodes.find((node) => node.id === targetNodeId);

  return (
    <>
      <DockerMigrationSetupDialog
        open={open && surface === "setup"}
        resource={resource}
        nodes={nodes}
        targetNodeId={targetNodeId}
        keepSource={keepSource}
        loadingTargets={loadingTargets}
        loadingPreflight={loadingAction}
        onTargetNodeChange={changeTargetNode}
        onKeepSourceChange={changeKeepSource}
        onRunPreflight={() => void runPreflight()}
        onClose={closeDialog}
      />
      <DockerMigrationReviewDialog
        open={open && surface === "review"}
        resource={resource}
        targetLabel={
          targetNode?.displayName ||
          targetNode?.hostname ||
          initialMigration?.targetNodeSlug ||
          "Target node"
        }
        preflight={preflight}
        migration={migration}
        loading={loadingAction}
        onBack={backToSetup}
        onStart={() => void startMigration()}
        onCancel={() => void cancelMigration()}
        onRetryCleanup={() => void retryCleanup()}
        onResolve={() => void resolveMigration()}
        onClose={closeDialog}
      />
    </>
  );
}
