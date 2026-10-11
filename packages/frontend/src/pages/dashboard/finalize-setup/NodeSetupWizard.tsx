import { Check, Loader2, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { HostAccessInstallOptions } from "@/components/nodes/HostAccessInstallOptions";
import { UnreleasedInstallerNote } from "@/components/nodes/UnreleasedInstallerNote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_HOST_ACCESS_INSTALL_OPTIONS,
  withHostAccessInstallFlags,
} from "@/lib/node-host-access";
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { CreateNodeResponse, NodeType } from "@/types";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

const NODE_TYPES: Array<{ value: NodeType; label: string; description: string }> = [
  {
    value: "nginx",
    label: "Ingress",
    description: "Serve public domains and routes with the Nginx daemon.",
  },
  { value: "docker", label: "Docker", description: "Manage containers and compose applications." },
  {
    value: "builder",
    label: "Build Worker",
    description: "Build untrusted Git sources with the isolated BuildKit and runsc profile.",
  },
  {
    value: "storage",
    label: "Storage",
    description: "Run managed database, object storage, and backup workloads.",
  },
  {
    value: "monitoring",
    label: "Monitoring",
    description: "Collect infrastructure health and metrics.",
  },
];
type Enrollment = Pick<CreateNodeResponse, "node" | "installerRelease" | "installCommands">;

export function NodeSetupWizard({
  open,
  onBack,
  onConfigured,
  onSkipped,
  completionActionLabel = "Back to checklist",
}: {
  open: boolean;
  onBack: () => void;
  onConfigured: () => Promise<void>;
  onSkipped: () => Promise<void>;
  completionActionLabel?: string;
}) {
  const [type, setType] = useState<NodeType>("nginx");
  const [name, setName] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [saving, setSaving] = useState(false);
  const [online, setOnline] = useState(false);
  const [targetId, setTargetId] = useState("public");
  const [transport, setTransport] = useState<"curl" | "wget">("curl");
  const [hostAccess, setHostAccess] = useState(DEFAULT_HOST_ACCESS_INSTALL_OPTIONS);
  const statusErrorShown = useRef(false);

  useEffect(() => {
    if (!open) return;
    setType("nginx");
    setName("");
    setEnrollment(null);
    setSaving(false);
    setOnline(false);
    setTargetId("public");
    setTransport("curl");
    setHostAccess(DEFAULT_HOST_ACCESS_INSTALL_OPTIONS);
    statusErrorShown.current = false;
  }, [open]);

  useEffect(() => {
    if (!open || !enrollment || online) return;
    let active = true;
    const refresh = async () => {
      try {
        const node = await api.getNode(enrollment.node.id);
        if (!active) return;
        statusErrorShown.current = false;
        if (node.status === "online") {
          setOnline(true);
        }
      } catch (cause) {
        if (active && !statusErrorShown.current) {
          statusErrorShown.current = true;
          toast.error(cause instanceof Error ? cause.message : "Failed to refresh node status");
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enrollment, online, open]);

  const selected = NODE_TYPES.find((item) => item.value === type)!;
  const targets = enrollment?.installCommands ?? [];

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      setEnrollment(await api.createNode({ type, hostname: "pending", displayName: name.trim() }));
    } catch (cause) {
      if (!handleLicenseApiError(cause, "Managed nodes")) {
        toast.error(
          cause instanceof Error ? cause.message : "Failed to create the node enrollment"
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const skipEnrollment = async () => {
    if (!enrollment) return;
    const approved = await confirm({
      title: "Discard Pending Node?",
      description:
        "This removes the pending node and invalidates its one-time enrollment command. You can create a new enrollment later from Nodes.",
      confirmLabel: "Delete pending node",
      variant: "destructive",
    });
    if (!approved) return;
    await api.deleteNode(enrollment.node.id);
    await onSkipped();
  };

  const selectedTarget = targets.find((target) => target.target === targetId) ?? targets[0];
  const command = withHostAccessInstallFlags(selectedTarget?.[transport] ?? "", hostAccess);

  const stepKey = online ? "complete" : enrollment ? "enrollment" : "details";
  return (
    <FinalizeSetupWizardDialog
      open={open}
      title="Connect Your First Node"
      description={
        <>
          <p>
            Nodes are secure agents that let Gateway operate infrastructure outside this control
            plane. They keep the credentials and host-level work on the machine where it belongs,
            while Gateway gives you one place to configure and observe it.
          </p>
          <p>
            Choose Ingress to serve public domains and routes, Docker for runtime containers, Build
            Worker for isolated Git builds, Storage for managed database, object storage, and backup
            workloads, or Monitoring for health and metrics. A host can run more than one node type
            when it has more than one job.
          </p>
          <p>
            This step creates a one-time enrollment command. Run it on the target host and keep this
            dialog open; Gateway detects the connection automatically. You can add, remove, and
            configure more nodes later from Nodes.
          </p>
        </>
      }
      stepKey={stepKey}
      onBack={enrollment ? undefined : onBack}
      onSkip={enrollment && !online ? skipEnrollment : undefined}
      footerStatus={
        enrollment && !online ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waiting for the node to come online…
          </span>
        ) : undefined
      }
      footer={
        online ? (
          <Button onClick={() => void onConfigured()}>
            <Check /> {completionActionLabel}
          </Button>
        ) : !enrollment ? (
          <Button onClick={() => void create()} pending={saving} disabled={!name.trim()}>
            <Server />
            Create enrollment
          </Button>
        ) : null
      }
    >
      {online ? (
        <FinalizeSetupCompletion
          title="Node connected"
          continueIn="Continue from Nodes to add more hosts, inspect their health, and configure the services each node provides."
        >
          Gateway can now communicate with this node and use it for the selected infrastructure
          role.
        </FinalizeSetupCompletion>
      ) : enrollment ? (
        <div className="space-y-4">
          <div className="border border-border p-4">
            <p className="text-sm font-medium">Run this command on the target host</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep this wizard open. Gateway checks the node automatically every few seconds.
            </p>
          </div>
          <UnreleasedInstallerNote installerRelease={enrollment.installerRelease} />
          <div className="flex flex-wrap items-center gap-2">
            {targets.length > 1 && (
              <Tabs value={selectedTarget?.target ?? "public"} onValueChange={setTargetId}>
                <TabsList>
                  {targets.map((target) => (
                    <TabsTrigger key={target.target} value={target.target}>
                      {target.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}
            <Tabs
              value={transport}
              onValueChange={(value) => setTransport(value as "curl" | "wget")}
            >
              <TabsList>
                <TabsTrigger value="curl">curl</TabsTrigger>
                <TabsTrigger value="wget">wget</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <HostAccessInstallOptions value={hostAccess} onChange={setHostAccess} />
          {selectedTarget && (
            <CopyCodeBlock
              label={`${transport} command`}
              value={command}
              copyValue={command.replace(/\s*\\\n\s*/g, " ")}
              className="[&>p]:hidden"
              codeClassName="min-h-0"
            />
          )}
        </div>
      ) : (
        <PanelShell
          title="Node enrollment"
          description="Choose what this host will contribute to Gateway and give it a recognizable name."
        >
          <SettingsControlRow title="Node type" description={selected.description}>
            <Select value={type} onValueChange={(value) => setType(value as NodeType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NODE_TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
          <SettingsControlRow
            title="Node name"
            description="Shown throughout Gateway after the node connects."
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="US-East ingress"
              autoFocus
            />
          </SettingsControlRow>
        </PanelShell>
      )}
    </FinalizeSetupWizardDialog>
  );
}
