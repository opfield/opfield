import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, KeyRound, Plus, Server, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { ContentLoading } from "@/components/common/ContentLoading";
import { CopyValueField } from "@/components/common/CopyValueField";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { api } from "@/services/api";
import type { ExternalSshConnector, ExternalSshConnectorRequest } from "@/types/integrations";

type SshSetupStep =
  | "target_connection"
  | "jump_connection"
  | "jump_authentication"
  | "target_authentication"
  | "review";
type SshAuthChoice = "password" | "generate_key" | "reuse_jump_key";
type ConnectorPurpose = "target" | "jump";

const STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

function initialForm(host = ""): ExternalSshConnectorRequest {
  return {
    name: host ? `SSH ${host}` : "",
    host,
    port: 22,
    username: "root",
    authMethod: "password",
    secret: "",
    hostFingerprint: "",
    enabled: true,
  };
}

function isCancelled(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : (error as { name?: string } | null)?.name === "AbortError";
}

export function ExternalSshConnectorDialog({
  open,
  initialHost = "",
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  initialHost?: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (connector: ExternalSshConnector) => void;
}) {
  const [connectors, setConnectors] = useState<ExternalSshConnector[]>([]);
  // The jump server options load on every open; the dialog waits for them.
  const [connectorsLoaded, setConnectorsLoaded] = useState(false);
  const connectorsLoading = open && !connectorsLoaded;
  const [form, setForm] = useState<ExternalSshConnectorRequest>(() => initialForm(initialHost));
  const [jumpForm, setJumpForm] = useState<ExternalSshConnectorRequest>(() => initialForm());
  const [jumpSelection, setJumpSelection] = useState("direct");
  const [step, setStep] = useState<SshSetupStep>("target_connection");
  const [saving, setSaving] = useState<ConnectorPurpose | null>(null);
  const [checkingHostKey, setCheckingHostKey] = useState<ConnectorPurpose | null>(null);
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null);
  const [generatedKeyPurpose, setGeneratedKeyPurpose] = useState<ConnectorPurpose | null>(null);
  const [createdConnector, setCreatedConnector] = useState<ExternalSshConnector | null>(null);
  const [createdJumpConnector, setCreatedJumpConnector] = useState<ExternalSshConnector | null>(
    null
  );
  const [reuseJumpKey, setReuseJumpKey] = useState(false);
  const operationController = useRef<AbortController | null>(null);

  const abortPendingOperation = () => {
    operationController.current?.abort();
    operationController.current = null;
    setSaving(null);
    setCheckingHostKey(null);
  };

  const beginOperation = () => {
    abortPendingOperation();
    const controller = new AbortController();
    operationController.current = controller;
    return controller;
  };

  const finishOperation = (controller: AbortController) => {
    if (operationController.current === controller) operationController.current = null;
  };

  useEffect(() => {
    if (!open) {
      operationController.current?.abort();
      operationController.current = null;
      setSaving(null);
      setCheckingHostKey(null);
      setConnectorsLoaded(false);
      return;
    }
    setForm(initialForm(initialHost));
    setJumpForm(initialForm());
    setJumpSelection("direct");
    setStep("target_connection");
    setGeneratedPublicKey(null);
    setGeneratedKeyPurpose(null);
    setCreatedConnector(null);
    setCreatedJumpConnector(null);
    setReuseJumpKey(false);
    const controller = new AbortController();
    void api
      .listExternalSshConnectors(controller.signal)
      .then((next) => {
        setConnectors(next);
        setConnectorsLoaded(true);
      })
      .catch((error) => {
        if (isCancelled(error)) return;
        toast.error(error instanceof Error ? error.message : "Failed to load SSH connectors");
        setConnectorsLoaded(true);
      });
    return () => controller.abort();
  }, [initialHost, open]);

  const targetBasicsReady = Boolean(
    form.name.trim() &&
      form.host.trim() &&
      form.username.trim() &&
      form.port &&
      form.port >= 1 &&
      form.port <= 65535
  );
  const targetConnectionReady = targetBasicsReady;
  const jumpConnectionReady = Boolean(
    jumpForm.name.trim() &&
      jumpForm.host.trim() &&
      jumpForm.username.trim() &&
      jumpForm.port &&
      jumpForm.port >= 1 &&
      jumpForm.port <= 65535
  );
  const authenticationReady = (purpose: ConnectorPurpose) => {
    const activeForm = purpose === "target" ? form : jumpForm;
    if (purpose === "target" && reuseJumpKey) return true;
    return Boolean(activeForm.generatePrivateKey || activeForm.secret?.trim());
  };
  const authChoice = (
    activeForm: ExternalSshConnectorRequest,
    purpose: ConnectorPurpose
  ): SshAuthChoice =>
    purpose === "target" && reuseJumpKey
      ? "reuse_jump_key"
      : activeForm.generatePrivateKey
        ? "generate_key"
        : "password";

  const patchConnection = (
    purpose: ConnectorPurpose,
    patch: Partial<ExternalSshConnectorRequest>
  ) => {
    if (purpose === "target") {
      setForm((current) => ({ ...current, ...patch, hostFingerprint: "" }));
    } else {
      setJumpForm((current) => ({ ...current, ...patch, hostFingerprint: "" }));
    }
  };

  const discoverHostKey = async (purpose: ConnectorPurpose, jumpConnectorId?: string | null) => {
    const activeForm = purpose === "target" ? form : jumpForm;
    if (!activeForm.host.trim() || !activeForm.port) return;
    const controller = beginOperation();
    setCheckingHostKey(purpose);
    try {
      const result = await api.discoverExternalSshHostKey(
        {
          host: activeForm.host.trim(),
          port: activeForm.port,
          jumpConnectorId:
            purpose === "target" ? (jumpConnectorId ?? form.jumpConnectorId ?? null) : null,
        },
        controller.signal
      );
      if (purpose === "target") {
        setForm((current) => ({ ...current, hostFingerprint: result.hostFingerprint }));
      } else {
        setJumpForm((current) => ({ ...current, hostFingerprint: result.hostFingerprint }));
      }
    } catch (error) {
      if (!isCancelled(error)) {
        toast.error(error instanceof Error ? error.message : "Failed to read SSH host key");
      }
    } finally {
      finishOperation(controller);
      setCheckingHostKey((current) => (current === purpose ? null : current));
    }
  };

  const selectAuthentication = (purpose: ConnectorPurpose, choice: SshAuthChoice) => {
    if (purpose === "target" && choice === "reuse_jump_key") {
      setReuseJumpKey(true);
      setForm((current) => ({
        ...current,
        authMethod: "private_key",
        generatePrivateKey: false,
        secret: "",
      }));
      return;
    }
    if (purpose === "target") setReuseJumpKey(false);
    const update = (current: ExternalSshConnectorRequest): ExternalSshConnectorRequest =>
      choice === "generate_key"
        ? {
            ...current,
            authMethod: "private_key",
            generatePrivateKey: true,
            secret: "",
          }
        : {
            ...current,
            authMethod: "password",
            generatePrivateKey: false,
            secret: "",
          };
    if (purpose === "target") setForm(update);
    else {
      setJumpForm(update);
      if (choice !== "generate_key") setReuseJumpKey(false);
    }
  };

  const registerCreatedJump = (connector: ExternalSshConnector) => {
    setConnectors((current) =>
      current.some((candidate) => candidate.id === connector.id) ? current : [...current, connector]
    );
    setCreatedJumpConnector(connector);
    setForm((current) => ({
      ...current,
      jumpConnectorId: connector.id,
      hostFingerprint: "",
    }));
  };

  const createJumpConnector = async () => {
    if (!authenticationReady("jump") || !jumpForm.hostFingerprint.trim()) return;
    const controller = beginOperation();
    setSaving("jump");
    try {
      const result = await api.createExternalSshConnector(
        {
          ...jumpForm,
          name: jumpForm.name.trim(),
          host: jumpForm.host.trim(),
          username: jumpForm.username.trim(),
          secret: jumpForm.secret?.trim() || undefined,
          hostFingerprint: jumpForm.hostFingerprint.trim(),
          jumpConnectorId: null,
        },
        controller.signal
      );
      registerCreatedJump(result.connector);
      if (result.generatedPublicKey) {
        setCreatedConnector(result.connector);
        setGeneratedPublicKey(result.generatedPublicKey);
        setGeneratedKeyPurpose("jump");
      } else {
        finishOperation(controller);
        setSaving(null);
        await discoverHostKey("target", result.connector.id);
      }
    } catch (error) {
      if (!isCancelled(error)) {
        toast.error(error instanceof Error ? error.message : "Failed to create jump connector");
      }
    } finally {
      finishOperation(controller);
      setSaving((current) => (current === "jump" ? null : current));
    }
  };

  const createTargetConnector = async () => {
    if (!authenticationReady("target") || !form.hostFingerprint.trim()) return;
    const controller = beginOperation();
    setSaving("target");
    try {
      const result = await api.createExternalSshConnector(
        {
          ...form,
          name: form.name.trim(),
          host: form.host.trim(),
          username: form.username.trim(),
          secret: reuseJumpKey ? undefined : form.secret?.trim() || undefined,
          hostFingerprint: form.hostFingerprint.trim(),
          jumpConnectorId: form.jumpConnectorId ?? null,
          generatePrivateKey: reuseJumpKey ? false : form.generatePrivateKey,
          reuseCredentialFromConnectorId: reuseJumpKey ? createdJumpConnector?.id : undefined,
        },
        controller.signal
      );
      if (result.generatedPublicKey) {
        setCreatedConnector(result.connector);
        setGeneratedPublicKey(result.generatedPublicKey);
        setGeneratedKeyPurpose("target");
      } else {
        onCreated(result.connector);
      }
    } catch (error) {
      if (!isCancelled(error)) {
        toast.error(error instanceof Error ? error.message : "Failed to create SSH connector");
      }
    } finally {
      finishOperation(controller);
      setSaving((current) => (current === "target" ? null : current));
    }
  };

  const finishGeneratedKey = async () => {
    if (!createdConnector || !generatedKeyPurpose) return;
    if (generatedKeyPurpose === "target") {
      onCreated(createdConnector);
      return;
    }
    const jumpConnector = createdConnector;
    setGeneratedPublicKey(null);
    setGeneratedKeyPurpose(null);
    setCreatedConnector(null);
    setStep("review");
    await discoverHostKey("target", jumpConnector.id);
  };

  const closeDialog = () => {
    abortPendingOperation();
    if (createdConnector && generatedKeyPurpose === "target") {
      onCreated(createdConnector);
      return;
    }
    onOpenChange(false);
  };

  const renderConnectionPanel = (purpose: ConnectorPurpose) => {
    const activeForm = purpose === "target" ? form : jumpForm;
    const isTarget = purpose === "target";
    return (
      <PanelShell
        title={isTarget ? "Connection" : "Jump server connection"}
        icon={<Server className="h-4 w-4" />}
        description={
          isTarget
            ? "External target, account, and optional jump server."
            : "Add the intermediate server Opfield should use to reach the target."
        }
      >
        <SettingsControlRow title="Connector name">
          <Input
            value={activeForm.name}
            onChange={(event) => {
              const value = event.target.value;
              if (isTarget) setForm((current) => ({ ...current, name: value }));
              else setJumpForm((current) => ({ ...current, name: value }));
            }}
            placeholder={isTarget ? "Production server" : "Bastion server"}
            autoFocus
          />
        </SettingsControlRow>
        <SettingsControlRow title={isTarget ? "External host and port" : "Jump host and port"}>
          <div className="grid w-full grid-cols-[minmax(0,1fr)_6rem] gap-2">
            <Input
              value={activeForm.host}
              onChange={(event) => patchConnection(purpose, { host: event.target.value })}
              placeholder={isTarget ? "server.example.com" : "bastion.example.com"}
            />
            <Input
              type="number"
              min={1}
              max={65535}
              value={activeForm.port ?? 22}
              onChange={(event) => patchConnection(purpose, { port: Number(event.target.value) })}
              aria-label={isTarget ? "SSH port" : "Jump SSH port"}
            />
          </div>
        </SettingsControlRow>
        <SettingsControlRow title="SSH username">
          <Input
            value={activeForm.username}
            onChange={(event) => {
              const value = event.target.value;
              if (isTarget) setForm((current) => ({ ...current, username: value }));
              else setJumpForm((current) => ({ ...current, username: value }));
            }}
            autoComplete="username"
          />
        </SettingsControlRow>
        {isTarget ? (
          <SettingsControlRow
            title="Jump server"
            description="Route through an existing connector or add one in this wizard."
          >
            <Select
              value={jumpSelection}
              onValueChange={(value) => {
                setJumpSelection(value);
                patchConnection("target", {
                  jumpConnectorId: value === "direct" || value === "new" ? null : value,
                });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">Direct connection</SelectItem>
                {connectors.map((connector) => (
                  <SelectItem key={connector.id} value={connector.id}>
                    {connector.name}
                  </SelectItem>
                ))}
                <SelectItem value="new">
                  <span className="flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    Add jump server…
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsControlRow>
        ) : null}
      </PanelShell>
    );
  };

  const renderAuthenticationPanel = (purpose: ConnectorPurpose) => {
    const activeForm = purpose === "target" ? form : jumpForm;
    const canReuseJumpKey =
      purpose === "target" && jumpSelection === "new" && jumpForm.generatePrivateKey;
    return (
      <PanelShell
        title={purpose === "target" ? "Authentication" : "Jump server authentication"}
        description="Opfield encrypts the credential and never displays it again."
        icon={<KeyRound className="h-4 w-4" />}
      >
        <SettingsControlRow title="Credential type">
          <Select
            value={authChoice(activeForm, purpose)}
            onValueChange={(value) => selectAuthentication(purpose, value as SshAuthChoice)}
          >
            <SelectTrigger
              aria-label={purpose === "target" ? "SSH credential type" : "Jump credential type"}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">Password</SelectItem>
              <SelectItem value="generate_key">Generate new key</SelectItem>
              {canReuseJumpKey ? (
                <SelectItem value="reuse_jump_key">Reuse jump server key</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </SettingsControlRow>
        {purpose === "target" && reuseJumpKey ? (
          <SettingsControlRow
            title="Shared generated key"
            description="The same private key will authenticate to the jump and target servers."
          >
            <span className="text-sm text-muted-foreground">Jump server key</span>
          </SettingsControlRow>
        ) : !activeForm.generatePrivateKey ? (
          <SettingsControlRow title="Password">
            <Input
              type="password"
              aria-label={purpose === "target" ? "SSH password" : "Jump SSH password"}
              value={activeForm.secret}
              onChange={(event) => {
                const value = event.target.value;
                if (purpose === "target") setForm((current) => ({ ...current, secret: value }));
                else setJumpForm((current) => ({ ...current, secret: value }));
              }}
              autoComplete="new-password"
            />
          </SettingsControlRow>
        ) : (
          <SettingsControlRow
            title="Generated key"
            description="Opfield generates an Ed25519 key pair on the final create action."
          >
            <span className="text-sm text-muted-foreground">Ed25519</span>
          </SettingsControlRow>
        )}
      </PanelShell>
    );
  };

  const renderFingerprintRow = (purpose: ConnectorPurpose) => {
    const activeForm = purpose === "target" ? form : jumpForm;
    const checking = checkingHostKey === purpose;
    const label = purpose === "target" ? "Target host identity" : "Jump host identity";
    const targetBlockedByNewJump =
      purpose === "target" && jumpSelection === "new" && !createdJumpConnector;

    return (
      <SettingsControlRow
        title={label}
        description={
          targetBlockedByNewJump
            ? "Checked through the jump server after the jump connector is explicitly created."
            : "Verify the fingerprint out of band before continuing."
        }
        controlsClassName="min-w-0"
      >
        {activeForm.hostFingerprint ? (
          <div className="w-full min-w-0 space-y-2">
            <CopyValueField
              label={`${label} fingerprint`}
              showLabel={false}
              value={activeForm.hostFingerprint}
              className="w-full min-w-0"
              valueClassName="font-mono text-xs"
            />
          </div>
        ) : targetBlockedByNewJump ? (
          <span className="text-sm text-muted-foreground">Pending jump creation</span>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void discoverHostKey(purpose, purpose === "target" ? createdJumpConnector?.id : null)
            }
            pending={checking}
          >
            <KeyRound />
            Check host key
          </Button>
        )}
      </SettingsControlRow>
    );
  };

  const renderReviewPanel = () => {
    const existingJump = connectors.find((connector) => connector.id === form.jumpConnectorId);
    const routeLabel =
      jumpSelection === "new"
        ? `Via new jump server ${jumpForm.name}`
        : jumpSelection === "direct"
          ? "Direct connection"
          : `Via ${existingJump?.name ?? "selected jump server"}`;
    const targetAuthLabel = reuseJumpKey
      ? "Reuse generated jump key"
      : form.generatePrivateKey
        ? "Generate new Ed25519 key"
        : "Password";
    const jumpAuthLabel = jumpForm.generatePrivateKey ? "Generate new Ed25519 key" : "Password";

    return (
      <PanelShell
        title="Review & host identity"
        description="No connector is created until you use the final action below."
        icon={<ShieldCheck className="h-4 w-4" />}
      >
        <SettingsControlRow title="Target">
          <span className="text-sm text-muted-foreground">
            {form.username}@{form.host}:{form.port}
          </span>
        </SettingsControlRow>
        <SettingsControlRow title="Route">
          <span className="text-sm text-muted-foreground">{routeLabel}</span>
        </SettingsControlRow>
        {jumpSelection === "new" ? (
          <>
            <SettingsControlRow title="Jump authentication">
              <span className="text-sm text-muted-foreground">{jumpAuthLabel}</span>
            </SettingsControlRow>
            {renderFingerprintRow("jump")}
          </>
        ) : null}
        <SettingsControlRow title="Target authentication">
          <span className="text-sm text-muted-foreground">{targetAuthLabel}</span>
        </SettingsControlRow>
        {renderFingerprintRow("target")}
      </PanelShell>
    );
  };

  const generatedKeyInstallTargets =
    generatedKeyPurpose === "jump"
      ? [
          `Jump: ${jumpForm.username}@${jumpForm.host}:${jumpForm.port}`,
          ...(reuseJumpKey ? [`Target: ${form.username}@${form.host}:${form.port}`] : []),
        ]
      : [`Target: ${form.username}@${form.host}:${form.port}`];

  const description = generatedPublicKey
    ? "Install the generated public key before Opfield verifies the remaining route."
    : step === "target_connection"
      ? "Define the target server and how Opfield should reach it."
      : step === "jump_connection"
        ? "Define the jump server without creating it yet."
        : step === "jump_authentication"
          ? "Choose the credential for the jump server."
          : step === "target_authentication"
            ? "Choose the credential for the target server."
            : "Review the route and verify every host identity before creation.";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeDialog();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {generatedPublicKey ? "Install the Generated SSH Key" : "Add External SSH Connector"}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <AnimatedHeight>
          <ContentLoading loading={connectorsLoading} />
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div key={generatedPublicKey ? "generated-key" : step} {...STEP_ANIMATION}>
              {generatedPublicKey ? (
                <PanelShell
                  title="Install public key"
                  description="Add this key to authorized_keys for every account listed below."
                  icon={<KeyRound className="h-4 w-4" />}
                >
                  <SettingsControlRow title="Install on">
                    <div className="space-y-1 text-right text-sm text-muted-foreground">
                      {generatedKeyInstallTargets.map((target) => (
                        <div key={target}>{target}</div>
                      ))}
                    </div>
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="Public key"
                    description="Append the complete line to ~/.ssh/authorized_keys."
                    controlsClassName="min-w-0"
                  >
                    <CopyValueField
                      label="Public key"
                      showLabel={false}
                      value={generatedPublicKey}
                      className="w-full min-w-0"
                      valueClassName="font-mono text-xs"
                    />
                  </SettingsControlRow>
                </PanelShell>
              ) : step === "target_connection" ? (
                renderConnectionPanel("target")
              ) : step === "jump_connection" ? (
                renderConnectionPanel("jump")
              ) : step === "jump_authentication" ? (
                renderAuthenticationPanel("jump")
              ) : step === "target_authentication" ? (
                renderAuthenticationPanel("target")
              ) : (
                renderReviewPanel()
              )}
            </motion.div>
          </AnimatePresence>
        </AnimatedHeight>

        <DialogFooter>
          {generatedPublicKey ? (
            <Button onClick={() => void finishGeneratedKey()}>I installed the key</Button>
          ) : step === "target_connection" ? (
            <>
              <Button variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  setStep(jumpSelection === "new" ? "jump_connection" : "target_authentication")
                }
                disabled={!targetConnectionReady}
              >
                Continue
              </Button>
            </>
          ) : step === "jump_connection" ? (
            <>
              <Button variant="outline" onClick={() => setStep("target_connection")}>
                <ArrowLeft />
                Back
              </Button>
              <Button
                onClick={() => setStep("jump_authentication")}
                disabled={!jumpConnectionReady}
              >
                Continue
              </Button>
            </>
          ) : step === "jump_authentication" ? (
            <>
              <Button variant="outline" onClick={() => setStep("jump_connection")}>
                <ArrowLeft />
                Back
              </Button>
              <Button
                onClick={() => setStep("target_authentication")}
                disabled={!authenticationReady("jump")}
              >
                Continue
              </Button>
            </>
          ) : step === "target_authentication" ? (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  setStep(jumpSelection === "new" ? "jump_authentication" : "target_connection")
                }
              >
                <ArrowLeft />
                Back
              </Button>
              <Button onClick={() => setStep("review")} disabled={!authenticationReady("target")}>
                Review
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("target_authentication")}>
                <ArrowLeft />
                Back
              </Button>
              {jumpSelection === "new" && !createdJumpConnector ? (
                <Button
                  onClick={() => void createJumpConnector()}
                  disabled={!jumpForm.hostFingerprint.trim()}
                  pending={saving === "jump"}
                >
                  <KeyRound />
                  Create jump and verify target
                </Button>
              ) : (
                <Button
                  onClick={() => void createTargetConnector()}
                  disabled={!form.hostFingerprint.trim()}
                  pending={saving === "target"}
                >
                  <KeyRound />
                  Create connector
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
