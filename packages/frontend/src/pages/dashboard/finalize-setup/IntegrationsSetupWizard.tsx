import { Check, Cloud, GitBranch, Github } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EditableStringList } from "@/components/common/EditableStringList";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CLOUDFLARE_API_TOKEN_URL } from "@/lib/cloudflare";
import { GitHubDeviceFlow } from "@/pages/settings/GitHubDeviceFlow";
import { api } from "@/services/api";
import type { FinalizeSetupState, FinalizeSetupStepStatus } from "@/types";
import type { GitConnectorProvider } from "@/types/integrations";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

export type ConnectorSetupKind = "cloudflare" | "gitlab" | "github" | "git";
type TrackedIntegration = Extract<ConnectorSetupKind, "cloudflare" | "gitlab">;
type OptionalIntegration = Exclude<ConnectorSetupKind, TrackedIntegration>;
type IntegrationScreen =
  | "overview"
  | ConnectorSetupKind
  | "cloudflare_complete"
  | "gitlab_complete"
  | "github_complete"
  | "git_complete";

export interface ConnectorSetupRequest {
  connector: ConnectorSetupKind;
  baseUrl?: string;
  repositoryUrl?: string;
}

const INTEGRATION_OPTIONS = [
  {
    id: "cloudflare",
    title: "Cloudflare",
    description: "Manage DNS zones and proxied host records.",
    icon: Cloud,
  },
  {
    id: "gitlab",
    title: "GitLab",
    description: "Connect repositories, CI, and container registries.",
    icon: GitBranch,
  },
  {
    id: "github",
    title: "GitHub",
    description: "Connect repositories, Actions, and packages.",
    icon: Github,
  },
  {
    id: "git",
    title: "Git",
    description: "Connect one repository or an explicit repository allowlist.",
    icon: GitBranch,
  },
] as const;

function isTrackedIntegration(connector: ConnectorSetupKind): connector is TrackedIntegration {
  return connector === "cloudflare" || connector === "gitlab";
}

function activeConnector(screen: IntegrationScreen): ConnectorSetupKind | null {
  switch (screen) {
    case "cloudflare":
    case "cloudflare_complete":
      return "cloudflare";
    case "gitlab":
    case "gitlab_complete":
      return "gitlab";
    case "github":
    case "github_complete":
      return "github";
    case "git":
    case "git_complete":
      return "git";
    default:
      return null;
  }
}

function completionScreen(connector: ConnectorSetupKind): IntegrationScreen {
  switch (connector) {
    case "cloudflare":
      return "cloudflare_complete";
    case "gitlab":
      return "gitlab_complete";
    case "github":
      return "github_complete";
    case "git":
      return "git_complete";
  }
}

function connectorLabel(connector: ConnectorSetupKind): string {
  switch (connector) {
    case "cloudflare":
      return "Cloudflare";
    case "gitlab":
      return "GitLab";
    case "github":
      return "GitHub";
    case "git":
      return "Git";
  }
}

function statusLabel(status: FinalizeSetupStepStatus | undefined) {
  if (status === "configured") return "Configured";
  if (status === "skipped") return "Skipped";
  if (status === "pending") return "Not started";
  return "Optional";
}

function repositoryEntries(values: string[]) {
  return values.map((item) => item.trim()).filter(Boolean);
}

export function IntegrationsSetupWizard({
  open,
  state,
  onBack,
  onStep,
  directSetup = null,
  onFinished,
}: {
  open: boolean;
  state?: FinalizeSetupState;
  onBack?: () => void;
  onStep?: (step: TrackedIntegration, status: "configured" | "skipped") => Promise<void>;
  /**
   * Opens one concrete connector form without mounting the Finalize Setup
   * checklist. Used by the assistant after the user has selected a path.
   */
  directSetup?: ConnectorSetupRequest | null;
  onFinished?: (status: "configured" | "cancelled") => void;
}) {
  const isDirectSetup = directSetup !== null;
  const [screen, setScreen] = useState<IntegrationScreen>("overview");
  const [cloudflareName, setCloudflareName] = useState("Cloudflare");
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [gitlabName, setGitlabName] = useState("GitLab");
  const [gitlabUrl, setGitlabUrl] = useState("https://gitlab.com");
  const [gitlabToken, setGitlabToken] = useState("");
  const [githubName, setGithubName] = useState("GitHub");
  const [githubUrl, setGithubUrl] = useState("https://github.com");
  const [githubToken, setGithubToken] = useState("");
  const [githubOAuthAvailable, setGithubOAuthAvailable] = useState(false);
  const [githubAuthMode, setGithubAuthMode] = useState<"oauth" | "token">("token");
  // Whether GitHub OAuth is available decides the GitHub form, so the form
  // shows only once that is known (checked once per opening).
  const [githubOAuthChecked, setGithubOAuthChecked] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setGithubOAuthChecked(false);
  }
  const [gitName, setGitName] = useState("Git");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRepositoryUrls, setGitRepositoryUrls] = useState<string[]>([""]);
  const [gitUsername, setGitUsername] = useState("");
  const [gitToken, setGitToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [configuredOptionalConnectors, setConfiguredOptionalConnectors] = useState<
    Set<OptionalIntegration>
  >(new Set());

  useEffect(() => {
    if (!open) return;

    const connector = directSetup?.connector;
    setScreen(connector ?? "overview");
    setCloudflareName("Cloudflare");
    setCloudflareToken("");
    setGitlabName("GitLab");
    setGitlabUrl(directSetup?.baseUrl ?? "https://gitlab.com");
    setGitlabToken("");
    setGithubName("GitHub");
    setGithubUrl(directSetup?.baseUrl ?? "https://github.com");
    setGithubToken("");
    setGitName("Git");
    setGitUrl(directSetup?.baseUrl ?? "");
    setGitRepositoryUrls([directSetup?.repositoryUrl ?? ""]);
    setGitUsername("");
    setGitToken("");
    setSaving(false);
    setConfiguredOptionalConnectors(new Set());
  }, [directSetup?.baseUrl, directSetup?.connector, directSetup?.repositoryUrl, open]);

  const needsGithubForm = directSetup?.connector === "github" || screen === "github";
  useEffect(() => {
    if (!open || !needsGithubForm || githubOAuthChecked) return;
    let cancelled = false;
    void api
      .getGitHubOAuthAvailability()
      .then(({ available }) => {
        if (cancelled) return;
        setGithubOAuthAvailable(available);
        setGithubAuthMode(available ? "oauth" : "token");
      })
      .catch(() => {
        if (!cancelled) {
          setGithubOAuthAvailable(false);
          setGithubAuthMode("token");
        }
      })
      .finally(() => {
        if (!cancelled) setGithubOAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [githubOAuthChecked, needsGithubForm, open]);

  const updateTrackedStep = async (step: TrackedIntegration, status: "configured" | "skipped") => {
    if (isDirectSetup || !onStep) return;
    await onStep(step, status);
  };

  const saveCloudflare = async () => {
    if (!cloudflareName.trim() || !cloudflareToken.trim()) return;
    setSaving(true);
    try {
      await api.createCloudflareConnector({
        name: cloudflareName.trim(),
        token: cloudflareToken.trim(),
        enabled: true,
      });
      await updateTrackedStep("cloudflare", "configured");
      setScreen(completionScreen("cloudflare"));
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Failed to create Cloudflare integration"
      );
    } finally {
      setSaving(false);
    }
  };

  const saveGitLab = async () => {
    if (!gitlabName.trim() || !gitlabUrl.trim() || !gitlabToken.trim()) return;
    setSaving(true);
    try {
      await api.createGitLabConnector({
        name: gitlabName.trim(),
        baseUrl: gitlabUrl.trim().replace(/\/$/, ""),
        token: gitlabToken.trim(),
        enabled: true,
        allowlistMode: "all_visible",
      });
      await updateTrackedStep("gitlab", "configured");
      setScreen(completionScreen("gitlab"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to create GitLab integration");
    } finally {
      setSaving(false);
    }
  };

  const saveGitConnector = async (provider: GitConnectorProvider) => {
    const isGithub = provider === "github";
    const name = isGithub ? githubName : gitName;
    const baseUrl = isGithub ? githubUrl : gitUrl;
    const token = isGithub ? githubToken : gitToken;
    const urls = repositoryEntries(gitRepositoryUrls);
    if (!name.trim() || !baseUrl.trim() || !token.trim()) return;
    if (!isGithub && (!gitUsername.trim() || urls.length === 0)) return;

    setSaving(true);
    try {
      if (isGithub) {
        await api.createGitConnector("github", {
          name: name.trim(),
          baseUrl: baseUrl.trim().replace(/\/$/, ""),
          enabled: true,
          token: token.trim(),
        });
      } else {
        await api.createGitConnector("git", {
          name: name.trim(),
          baseUrl: baseUrl.trim().replace(/\/$/, ""),
          enabled: true,
          username: gitUsername.trim(),
          token: token.trim(),
          allowlistEntries: urls.map((url) => ({
            entryType: "project",
            remoteId: url,
            fullPath: url,
            name: url,
            webUrl: url,
          })),
        });
      }
      setConfiguredOptionalConnectors((current) => new Set(current).add(provider));
      setScreen(completionScreen(provider));
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : `Failed to create ${connectorLabel(provider)} integration`
      );
    } finally {
      setSaving(false);
    }
  };

  const skipCurrent = async () => {
    if (isDirectSetup) {
      onFinished?.("cancelled");
      return;
    }

    const connector = activeConnector(screen);
    if (connector) {
      if (isTrackedIntegration(connector)) {
        setSaving(true);
        try {
          await updateTrackedStep(connector, "skipped");
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : "Failed to skip integrations setup");
          return;
        } finally {
          setSaving(false);
        }
      }
      setScreen("overview");
      return;
    }

    const pending = (["cloudflare", "gitlab"] as const).filter(
      (step) => state?.steps[step] === "pending"
    );
    setSaving(true);
    try {
      for (const step of pending) await updateTrackedStep(step, "skipped");
      onBack?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to skip integrations setup");
    } finally {
      setSaving(false);
    }
  };

  const connector = activeConnector(screen);
  const completedIntegration = screen.endsWith("_complete");
  const currentStatus =
    connector && isTrackedIntegration(connector) ? state?.steps[connector] : undefined;
  const directTitle =
    directSetup === null ? null : `Add ${connectorLabel(directSetup.connector)} Connector`;
  const directDescription =
    directSetup === null
      ? null
      : "Only this connector is being configured. Credentials are sent to Opfield and stored encrypted; they are never added to the AI conversation.";

  const footer =
    completedIntegration && connector ? (
      <Button
        onClick={() => {
          if (isDirectSetup) onFinished?.("configured");
          else setScreen("overview");
        }}
      >
        <Check /> {isDirectSetup ? "Continue scenario" : "Back to integrations"}
      </Button>
    ) : screen === "cloudflare" ? (
      <Button
        onClick={() => void saveCloudflare()}
        pending={saving}
        disabled={!cloudflareName.trim() || !cloudflareToken.trim()}
      >
        <Cloud />
        Save Cloudflare
      </Button>
    ) : screen === "gitlab" ? (
      <Button
        onClick={() => void saveGitLab()}
        pending={saving}
        disabled={!gitlabName.trim() || !gitlabUrl.trim() || !gitlabToken.trim()}
      >
        <GitBranch />
        Save GitLab
      </Button>
    ) : screen === "github" && githubAuthMode === "token" ? (
      <Button
        onClick={() => void saveGitConnector("github")}
        pending={saving}
        disabled={!githubName.trim() || !githubUrl.trim() || !githubToken.trim()}
      >
        <Github />
        Save GitHub
      </Button>
    ) : screen === "git" ? (
      <Button
        onClick={() => void saveGitConnector("git")}
        pending={saving}
        disabled={
          !gitName.trim() ||
          !gitUrl.trim() ||
          !gitRepositoryUrls.some((url) => url.trim()) ||
          !gitUsername.trim() ||
          !gitToken.trim()
        }
      >
        <GitBranch />
        Save Git connector
      </Button>
    ) : null;

  return (
    <FinalizeSetupWizardDialog
      open={open}
      title={directTitle ?? "Connect Integrations"}
      description={
        directDescription ?? (
          <>
            <p>
              Integrations let Opfield work with the systems that already surround your
              infrastructure, without requiring you to leave the control plane for routine setup and
              deployment tasks.
            </p>
            <p>
              Cloudflare lets Opfield manage authorized DNS records. GitLab, GitHub, and generic Git
              connectors provide repository access for source, CI, and deployment workflows.
            </p>
            <p>
              Each connection is independent and optional. Grant only the access you need, then
              refine connectors and permissions later in Settings.
            </p>
          </>
        )
      }
      stepKey={screen}
      onClose={isDirectSetup && !completedIntegration ? () => onFinished?.("cancelled") : undefined}
      onBack={
        isDirectSetup
          ? undefined
          : screen === "overview"
            ? onBack
            : completedIntegration
              ? undefined
              : () => setScreen("overview")
      }
      backDisabled={saving}
      onSkip={isDirectSetup || completedIntegration ? undefined : skipCurrent}
      skipDisabled={saving || currentStatus === "configured"}
      onCancel={
        isDirectSetup && !completedIntegration ? () => onFinished?.("cancelled") : undefined
      }
      cancelDisabled={saving}
      footer={footer}
    >
      <ContentLoading loading={directSetup?.connector === "github" && !githubOAuthChecked} />
      {screen === "cloudflare_complete" ? (
        <FinalizeSetupCompletion
          title="Cloudflare connected"
          continueIn={
            isDirectSetup
              ? "Opfield can now use this Cloudflare connection in the current scenario."
              : "Continue from Settings → Integrations → Cloudflare to limit zones, rotate the token, and manage connector access."
          }
        >
          Opfield can now use the authorized Cloudflare account when you configure eligible DNS
          zones and proxied hosts.
        </FinalizeSetupCompletion>
      ) : screen === "gitlab_complete" ? (
        <FinalizeSetupCompletion
          title="GitLab connected"
          continueIn={
            isDirectSetup
              ? "Opfield can now re-check this scenario's GitLab prerequisite."
              : "Continue from Settings → Integrations → GitLab to choose projects, registries, and synchronization settings."
          }
        >
          Opfield can now discover the repositories, CI projects, and container registries visible
          to this token.
        </FinalizeSetupCompletion>
      ) : screen === "github_complete" ? (
        <FinalizeSetupCompletion
          title="GitHub connected"
          continueIn={
            isDirectSetup
              ? "Opfield can now re-check this scenario's GitHub prerequisite."
              : "Continue from Settings → Integrations → GitHub to manage this connector."
          }
        >
          Opfield can now use repositories visible to the authorized GitHub account for source and
          deployment workflows.
        </FinalizeSetupCompletion>
      ) : screen === "git_complete" ? (
        <FinalizeSetupCompletion
          title="Git connector connected"
          continueIn={
            isDirectSetup
              ? "Opfield can now re-check this scenario's repository prerequisite."
              : "Continue from Settings → Integrations → Git to manage this connector."
          }
        >
          Opfield can now use the configured repository or allowlist for source workflows.
        </FinalizeSetupCompletion>
      ) : screen === "overview" ? (
        <div className="space-y-3">
          {INTEGRATION_OPTIONS.map(({ id, title, description, icon: Icon }) => {
            const status = isTrackedIntegration(id) ? state?.steps[id] : undefined;
            const configured =
              status === "configured" ||
              (!isTrackedIntegration(id) && configuredOptionalConnectors.has(id));
            return (
              <ChoiceCard
                key={id}
                icon={Icon}
                title={title}
                description={description}
                disabled={saving || configured}
                onClick={() => setScreen(id)}
                trailing={
                  <Badge
                    variant={
                      configured
                        ? "success"
                        : status === "skipped"
                          ? "outline"
                          : status === "pending"
                            ? "secondary"
                            : "outline"
                    }
                  >
                    {configured && <Check className="mr-1 h-3 w-3" />}
                    {configured ? "Configured" : statusLabel(status)}
                  </Badge>
                }
              />
            );
          })}
        </div>
      ) : screen === "cloudflare" ? (
        <PanelShell
          title="Cloudflare connector"
          description="Create a connection Opfield can use for authorized DNS zones and proxy-host records."
        >
          <SettingsControlRow
            title="Connector name"
            description="A label for this Cloudflare connection in Opfield."
          >
            <Input
              value={cloudflareName}
              onChange={(event) => setCloudflareName(event.target.value)}
              autoFocus
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="API token"
            description="Requires Zone and DNS permissions for the zones Opfield should manage."
          >
            <div className="space-y-2">
              <Input
                type="password"
                value={cloudflareToken}
                onChange={(event) => setCloudflareToken(event.target.value)}
                autoComplete="off"
              />
              <a
                href={CLOUDFLARE_API_TOKEN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex text-sm font-medium text-[color:var(--color-link)] hover:underline focus-visible:outline-none focus-visible:underline"
              >
                Create API token →
              </a>
            </div>
          </SettingsControlRow>
        </PanelShell>
      ) : screen === "gitlab" ? (
        <PanelShell
          title="GitLab connector"
          description="Connect the GitLab instance Opfield should use for projects, CI, and container registries."
        >
          <SettingsControlRow
            title="Connector name"
            description="A label for this GitLab connection in Opfield."
          >
            <Input
              value={gitlabName}
              onChange={(event) => setGitlabName(event.target.value)}
              autoFocus
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="GitLab URL"
            description="The base URL of GitLab Cloud or your self-managed instance."
          >
            <Input
              value={gitlabUrl}
              onChange={(event) => setGitlabUrl(event.target.value)}
              placeholder="https://gitlab.com"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Personal access token"
            description="Opfield initially imports projects visible to this token; refine access later in Settings."
          >
            <Input
              type="password"
              value={gitlabToken}
              onChange={(event) => setGitlabToken(event.target.value)}
              autoComplete="off"
            />
          </SettingsControlRow>
        </PanelShell>
      ) : screen === "github" && !githubOAuthChecked ? (
        <LoadingSpinner label="Checking GitHub sign-in options" />
      ) : (
        <div className="space-y-4">
          <PanelShell
            title={screen === "github" ? "GitHub connector" : "Git connector"}
            description={
              screen === "github"
                ? githubAuthMode === "oauth"
                  ? "Connect your GitHub account. Opfield can use repositories available to the authorized account."
                  : "Connect a GitHub account with a personal access token."
                : "Connect one or more repositories on a generic Git host."
            }
          >
            {screen === "github" ? (
              <SettingsControlRow
                title="Authentication"
                description={
                  githubOAuthAvailable
                    ? "OAuth is recommended; a personal access token remains available."
                    : "OAuth is not configured on this Opfield installation; use a personal access token."
                }
              >
                <Tabs
                  value={githubAuthMode}
                  onValueChange={(value) => setGithubAuthMode(value as "oauth" | "token")}
                  className="w-full"
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="oauth" disabled={!githubOAuthAvailable} className="flex-1">
                      {githubOAuthAvailable ? "OAuth" : "OAuth unavailable"}
                    </TabsTrigger>
                    <TabsTrigger value="token" className="flex-1">
                      Token
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </SettingsControlRow>
            ) : null}
            <SettingsControlRow
              title="Connector name"
              description="A label for this source-control connection in Opfield."
            >
              <Input
                value={screen === "github" ? githubName : gitName}
                onChange={(event) => {
                  if (screen === "github") setGithubName(event.target.value);
                  else setGitName(event.target.value);
                }}
                autoFocus
              />
            </SettingsControlRow>
            {screen === "git" || githubAuthMode === "token" ? (
              <SettingsControlRow
                title={screen === "github" ? "GitHub URL" : "Git host URL"}
                description={
                  screen === "github"
                    ? "Use github.com or the base URL of your GitHub Enterprise instance."
                    : "The base URL of the Git host that serves this repository."
                }
              >
                <Input
                  value={screen === "github" ? githubUrl : gitUrl}
                  onChange={(event) => {
                    if (screen === "github") setGithubUrl(event.target.value);
                    else setGitUrl(event.target.value);
                  }}
                  placeholder={
                    screen === "github" ? "https://github.com" : "https://git.example.com"
                  }
                />
              </SettingsControlRow>
            ) : null}
            {screen === "git" ? (
              <SettingsControlRow
                title="Repositories"
                description="Add every repository this credential should make available to Opfield."
              >
                <EditableStringList
                  values={gitRepositoryUrls}
                  onChange={setGitRepositoryUrls}
                  placeholder="https://git.example.com/team/repository"
                  itemLabel="Repository URL"
                />
              </SettingsControlRow>
            ) : null}
            {screen === "git" ? (
              <>
                <SettingsControlRow title="Username">
                  <Input
                    value={gitUsername}
                    onChange={(event) => setGitUsername(event.target.value)}
                    autoComplete="username"
                  />
                </SettingsControlRow>
                <SettingsControlRow
                  title="Access token"
                  description="Opfield encrypts this token and never displays it again."
                >
                  <Input
                    type="password"
                    value={gitToken}
                    onChange={(event) => setGitToken(event.target.value)}
                    autoComplete="off"
                  />
                </SettingsControlRow>
              </>
            ) : null}
            {screen === "github" && githubAuthMode === "token" ? (
              <SettingsControlRow
                title="Personal access token"
                description="Opfield encrypts this token and uses repositories visible to its GitHub account."
              >
                <Input
                  type="password"
                  value={githubToken}
                  onChange={(event) => setGithubToken(event.target.value)}
                  autoComplete="off"
                />
              </SettingsControlRow>
            ) : null}
          </PanelShell>
          {screen === "github" && githubAuthMode === "oauth" ? (
            <GitHubDeviceFlow
              request={{
                name: githubName.trim(),
                enabled: true,
              }}
              disabled={!githubName.trim()}
              onCompleted={() => {
                setConfiguredOptionalConnectors((current) => new Set(current).add("github"));
                setScreen(completionScreen("github"));
              }}
            />
          ) : null}
        </div>
      )}
    </FinalizeSetupWizardDialog>
  );
}
