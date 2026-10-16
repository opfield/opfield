import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { CopyValueField } from "@/components/common/CopyValueField";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DockerImageCleanupSettings, DockerWebhook } from "@/types";

type WebhookSectionProps =
  | {
      nodeId: string;
      target?: "container";
      containerName: string;
      deploymentId?: never;
      initialWebhook?: never;
      onWebhookChange?: never;
      disabled?: boolean;
      allowWebhook?: boolean;
      allowCleanup?: boolean;
    }
  | {
      nodeId: string;
      target: "deployment";
      deploymentId: string;
      containerName?: never;
      initialWebhook?: DockerWebhook | null;
      onWebhookChange?: (webhook: DockerWebhook | null) => void;
      disabled?: boolean;
      allowWebhook?: boolean;
      allowCleanup?: boolean;
    };

export function WebhookSection(props: WebhookSectionProps) {
  const isDeployment = props.target === "deployment";
  const allowWebhook = props.allowWebhook ?? true;
  const allowCleanup = props.allowCleanup ?? true;
  const nodeId = props.nodeId;
  const targetName = isDeployment ? props.deploymentId : props.containerName;
  const onWebhookChange = isDeployment ? props.onWebhookChange : undefined;
  const [webhook, setWebhookState] = useState<DockerWebhook | null>(
    isDeployment ? (props.initialWebhook ?? null) : null
  );
  const [loading, setLoading] = useState(true);

  const [cleanup, setCleanup] = useState<DockerImageCleanupSettings | null>(null);
  const [cleanupEnabled, setCleanupEnabled] = useState(false);
  const [retentionCount, setRetentionCount] = useState("2");

  const setWebhook = useCallback(
    (next: DockerWebhook | null) => {
      setWebhookState(next);
      if (isDeployment) {
        onWebhookChange?.(next);
      }
    },
    [isDeployment, onWebhookChange]
  );

  const fetchSettings = useCallback(async () => {
    const webhookRequest = allowWebhook
      ? isDeployment
        ? api.getDeploymentWebhook(nodeId, targetName)
        : api.getContainerWebhook(nodeId, targetName)
      : Promise.resolve(null);
    const cleanupRequest = allowCleanup
      ? isDeployment
        ? api.getDeploymentImageCleanup(nodeId, targetName)
        : api.getContainerImageCleanup(nodeId, targetName)
      : Promise.resolve(null);

    try {
      const [webhookResult, cleanupResult] = await Promise.allSettled([
        webhookRequest,
        cleanupRequest,
      ]);
      if (webhookResult.status === "fulfilled") {
        setWebhook(webhookResult.value);
      }
      if (cleanupResult.status === "fulfilled" && cleanupResult.value) {
        setCleanup(cleanupResult.value);
        setCleanupEnabled(cleanupResult.value.enabled);
        setRetentionCount(String(cleanupResult.value.retentionCount));
      }
    } finally {
      setLoading(false);
    }
  }, [allowCleanup, allowWebhook, isDeployment, nodeId, setWebhook, targetName]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useRealtime("docker.webhook.changed", (payload: unknown) => {
    const p = payload as Record<string, unknown>;
    if (
      allowWebhook &&
      p.nodeId === nodeId &&
      (isDeployment
        ? p.deploymentId === targetName || p.targetId === targetName
        : p.containerName === targetName)
    ) {
      fetchSettings();
    }
  });

  useRealtime("docker.image-cleanup.changed", (payload: unknown) => {
    const p = payload as Record<string, unknown>;
    if (
      allowCleanup &&
      p.nodeId === nodeId &&
      (isDeployment
        ? p.targetType === "deployment" && p.deploymentId === targetName
        : p.targetType === "container" && p.containerName === targetName)
    ) {
      setCleanup(p as unknown as DockerImageCleanupSettings);
      setCleanupEnabled(Boolean(p.enabled));
      setRetentionCount(String(p.retentionCount ?? 2));
    }
  });

  const webhookEnabled = !!webhook?.enabled;
  const webhookUrl = webhookEnabled
    ? `${window.location.origin}/api/webhooks/docker/${webhook.token}`
    : "";
  const curlExample = webhookEnabled
    ? `curl -X POST ${webhookUrl} \\\n  -H "Content-Type: application/json" \\\n  -d '{"tag":"v1.0.0"}'`
    : "";

  const handleEnable = async () => {
    try {
      const data = isDeployment
        ? await api.upsertDeploymentWebhook(nodeId, targetName, { enabled: true })
        : await api.upsertContainerWebhook(nodeId, targetName, { enabled: true });
      setWebhook(data);
    } catch (err) {
      toastApiError(err, "Failed to enable webhook");
    }
  };

  const autoSave = useCallback(
    async (patch: { enabled?: boolean; retentionCount?: number }) => {
      try {
        const data = isDeployment
          ? await api.upsertDeploymentImageCleanup(nodeId, targetName, patch)
          : await api.upsertContainerImageCleanup(nodeId, targetName, patch);
        setCleanup(data);
        setCleanupEnabled(data.enabled);
        setRetentionCount(String(data.retentionCount));
      } catch (err) {
        toastApiError(err, "Failed to save");
      }
    },
    [isDeployment, nodeId, targetName]
  );

  const handleCleanupToggle = useCallback(
    (v: boolean) => {
      setCleanupEnabled(v);
      autoSave({ enabled: v });
    },
    [autoSave]
  );

  const handleRetentionBlur = useCallback(() => {
    const v = Math.max(1, Math.min(50, Number(retentionCount) || 2));
    setRetentionCount(String(v));
    if (cleanupEnabled && v !== cleanup?.retentionCount) {
      autoSave({ retentionCount: v });
    }
  }, [autoSave, cleanup?.retentionCount, cleanupEnabled, retentionCount]);

  const handleRegenerate = async () => {
    const ok = await confirm({
      title: "Regenerate Webhook URL",
      description:
        "This will invalidate the current webhook URL. Any CI pipelines using the old URL will stop working. Continue?",
      confirmLabel: "Regenerate",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const data = isDeployment
        ? await api.regenerateDeploymentWebhookToken(nodeId, targetName)
        : await api.regenerateWebhookToken(nodeId, targetName);
      setWebhook(data);
      toast.success("Webhook URL regenerated");
    } catch (err) {
      toastApiError(err, "Failed to regenerate");
    }
  };

  const handleDisable = async () => {
    const ok = await confirm({
      title: "Disable Webhook URL",
      description:
        "This will disable the current webhook URL. CI pipelines using this URL will stop working. Image cleanup settings are managed separately. Continue?",
      confirmLabel: "Disable",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      if (isDeployment) {
        await api.deleteDeploymentWebhook(nodeId, targetName);
      } else {
        await api.deleteContainerWebhook(nodeId, targetName);
      }
      setWebhook(null);
    } catch (err) {
      toastApiError(err, "Failed to disable");
    }
  };

  // The enclosing tab waits for the first answer; there is no separate placeholder.
  useContentLoading((allowWebhook || allowCleanup) && loading);

  if ((!allowWebhook && !allowCleanup) || loading) return null;

  const handleToggle = async (enabled: boolean) => {
    if (enabled) {
      await handleEnable();
    } else {
      await handleDisable();
    }
  };

  return (
    <>
      {allowWebhook && (
        <PanelShell
          title={
            <SettingsHelpTitle
              label="Webhook"
              help={`Creates a secret URL that CI can call to trigger a managed ${isDeployment ? "deployment" : "container"} image update. Treat the URL as a credential.`}
            />
          }
          description={`Trigger ${isDeployment ? "deployment" : "container"} updates from CI pipelines`}
          headerBorder={webhookEnabled}
          actions={
            <Switch checked={webhookEnabled} onChange={handleToggle} disabled={props.disabled} />
          }
        >
          {webhookEnabled ? (
            <div className="divide-y divide-border">
              <div className="px-4 py-3">
                <CopyValueField
                  label="Webhook URL"
                  value={webhookUrl}
                  actions={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 rounded-none border-l border-border bg-header text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={handleRegenerate}
                      title="Regenerate URL"
                      aria-label="Regenerate URL"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  }
                />
              </div>

              <div className="px-4 py-3">
                <CopyCodeBlock label="Example" value={curlExample} />
              </div>
            </div>
          ) : null}
        </PanelShell>
      )}

      {allowCleanup && (
        <PanelShell
          title={
            <SettingsHelpTitle
              label="Image Cleanup"
              help="Removes older image versions after each update, Git-source builds included. The version the container runs counts toward N; the newest others stay for rollback. Housekeeping applies the same limit to build images on every node."
            />
          }
          description="Remove old image versions after updates and builds"
          actions={
            <Switch
              checked={cleanupEnabled}
              onChange={handleCleanupToggle}
              disabled={props.disabled}
            />
          }
        >
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p
                className={`text-sm font-medium ${!cleanupEnabled ? "text-muted-foreground" : ""}`}
              >
                Keep last N versions
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Versions kept, the running one included
              </p>
            </div>
            <Input
              type="number"
              className="w-20 shrink-0"
              value={retentionCount}
              onChange={(e) => setRetentionCount(e.target.value)}
              disabled={!cleanupEnabled || props.disabled}
              min={1}
              max={50}
              onBlur={handleRetentionBlur}
            />
          </div>
        </PanelShell>
      )}
    </>
  );
}
