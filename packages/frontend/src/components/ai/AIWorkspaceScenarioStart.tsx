import { Activity, Database, RefreshCw, Rocket, Server, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { FinalizeSetupFlow } from "@/pages/dashboard/FinalizeSetupFlow";
import {
  type ConnectorSetupRequest,
  IntegrationsSetupWizard,
} from "@/pages/dashboard/finalize-setup/IntegrationsSetupWizard";
import { ExternalSshConnectorDialog } from "@/pages/settings/ExternalSshConnectorDialog";
import { api } from "@/services/api";
import type { FinalizeSetupState } from "@/types";
import type { AIScenario, AIScenarioCategory, PageContext } from "@/types/ai";

const CATEGORY_LABELS: Record<AIScenarioCategory, string> = {
  deploy_release: "Deploy & Release",
  migrate_recover: "Migrate & Recover",
  infrastructure_access: "Infrastructure & Access",
  data_storage: "Data & Storage",
  security_pki: "Security & PKI",
  observe_operate: "Observe & Operate",
};

export type AssistantConnectorSetup = ConnectorSetupRequest | { connector: "ssh"; host?: string };

export function parseAssistantConnectorSetup(value: unknown): AssistantConnectorSetup | null {
  if (!value || typeof value !== "object") return null;
  const detail = value as Record<string, unknown>;
  if (
    detail.connector !== "cloudflare" &&
    detail.connector !== "gitlab" &&
    detail.connector !== "github" &&
    detail.connector !== "git" &&
    detail.connector !== "ssh"
  ) {
    return null;
  }
  if (detail.connector === "ssh") {
    return {
      connector: "ssh",
      host: typeof detail.host === "string" ? detail.host : undefined,
    };
  }
  return {
    connector: detail.connector,
    baseUrl: typeof detail.baseUrl === "string" ? detail.baseUrl : undefined,
    repositoryUrl: typeof detail.repositoryUrl === "string" ? detail.repositoryUrl : undefined,
  };
}

export function AIWorkspaceAssistantConnectorSetup({
  setup,
  onFinished,
}: {
  setup: AssistantConnectorSetup | null;
  onFinished: (setup: AssistantConnectorSetup, status: "configured" | "cancelled") => void;
}) {
  // The last setup stays while its dialog closes: a finished setup turns `setup` null, which
  // closes the dialog instead of unmounting it.
  const shown = useRetainedDialogValue(setup, setup !== null);
  // close-reset-ok: no setup was started yet, so there is no dialog to close
  if (!shown) return null;
  const open = setup !== null;
  if (shown.connector === "ssh") {
    return (
      <ExternalSshConnectorDialog
        open={open}
        initialHost={shown.host}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && setup) onFinished(setup, "cancelled");
        }}
        onCreated={() => {
          if (setup) onFinished(setup, "configured");
        }}
      />
    );
  }
  return (
    <IntegrationsSetupWizard
      open={open}
      directSetup={shown}
      onFinished={(status) => {
        if (setup) onFinished(setup, status);
      }}
    />
  );
}

function ScenarioIcon({ scenario, className }: { scenario: AIScenario; className?: string }) {
  const Icon =
    scenario.icon === "rocket"
      ? Rocket
      : scenario.icon === "refresh"
        ? RefreshCw
        : scenario.icon === "server"
          ? Server
          : scenario.icon === "database"
            ? Database
            : scenario.icon === "shield"
              ? ShieldCheck
              : Activity;
  return <Icon className={className} />;
}

function ScenarioButton({
  scenario,
  onStart,
  disabled,
}: {
  scenario: AIScenario;
  onStart: (scenario: AIScenario) => void;
  disabled: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={() => onStart(scenario)}
      className="h-auto items-start justify-start whitespace-normal px-4 py-4 text-left"
    >
      <span className="grid w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-3">
        <ScenarioIcon scenario={scenario} className="h-5 w-5 self-center text-muted-foreground" />
        <span className="min-w-0 text-sm font-medium text-foreground">{scenario.title}</span>
        <span className="col-span-2 text-sm font-normal leading-5 text-muted-foreground">
          {scenario.description}
        </span>
      </span>
    </Button>
  );
}

export function AIWorkspaceScenarioStart({
  context,
  onStart,
  onInvestigateOperationalIssue,
  disabled,
}: {
  context: PageContext;
  onStart: (scenario: AIScenario) => void;
  onInvestigateOperationalIssue: () => void;
  disabled: boolean;
}) {
  const scenarioContext = useMemo<PageContext>(
    () => ({
      route: context.route,
      ...(context.resourceType ? { resourceType: context.resourceType } : {}),
      ...(context.resourceId ? { resourceId: context.resourceId } : {}),
      ...(context.label ? { label: context.label } : {}),
      ...(context.nodeId ? { nodeId: context.nodeId } : {}),
    }),
    [context.label, context.nodeId, context.resourceId, context.resourceType, context.route]
  );
  const [scenarios, setScenarios] = useState<AIScenario[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [setupPending, setSetupPending] = useState(false);
  const [finalizeSetup, setFinalizeSetup] = useState<FinalizeSetupState | null>(null);
  const [inviteUserMethods, setInviteUserMethods] = useState<{
    password: boolean;
    emailOtp: boolean;
  } | null>(null);
  const [finalizeSetupOpen, setFinalizeSetupOpen] = useState(false);
  const [relayNeedsAttention, setRelayNeedsAttention] = useState(false);
  // The start screen appears once its data is in: the page gate waits for it
  // on first load, and a later remount (a new Work Session) fades it in.
  // A context change refetches in place without hiding what is shown.
  const [startDataReady, setStartDataReady] = useState(false);
  useContentLoading(!startDataReady);

  useEffect(() => {
    let disposed = false;
    void Promise.allSettled([
      api.getAIScenarios(scenarioContext),
      api.getFinalizeSetupState(),
      api.getDashboardBootstrap({
        pins: {
          dashboard: { nodeIds: [], proxyHostIds: [], databaseIds: [], dockerResources: [] },
          sidebar: { nodeIds: [], proxyHostIds: [], databaseIds: [], dockerResources: [] },
        },
      }),
    ]).then(([availableResult, finalizeSetupResult, dashboardResult]) => {
      if (disposed) return;
      if (availableResult.status === "fulfilled") {
        setScenarios(availableResult.value);
      }

      if (finalizeSetupResult.status === "fulfilled") {
        const nextFinalizeSetup = finalizeSetupResult.value;
        setSetupPending(
          Boolean(
            nextFinalizeSetup &&
              Object.values(nextFinalizeSetup.steps).some((step) => step === "pending")
          )
        );
        setFinalizeSetup(nextFinalizeSetup);
      } else {
        setSetupPending(false);
        setFinalizeSetup(null);
      }

      if (dashboardResult.status === "fulfilled") {
        const dashboard = dashboardResult.value;
        setInviteUserMethods(dashboard.inviteUserMethods);
        setRelayNeedsAttention(
          Boolean(
            dashboard.relay &&
              ["migration_pending", "maintenance", "recovering", "degraded", "critical"].includes(
                dashboard.relay.state
              )
          )
        );
      } else {
        setInviteUserMethods(null);
        setRelayNeedsAttention(false);
      }

      setStartDataReady(true);
    });
    return () => {
      disposed = true;
    };
  }, [scenarioContext]);

  const featured = scenarios.slice(0, 3);
  const categorized = useMemo(
    () =>
      (Object.keys(CATEGORY_LABELS) as AIScenarioCategory[])
        .map((category) => ({
          category,
          scenarios: scenarios.filter((scenario) => scenario.category === category),
        }))
        .filter((group) => group.scenarios.length > 0),
    [scenarios]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto dashboard-scrollbar">
      {startDataReady && (
        <div className="ai-chat-content-fade-in mx-auto flex min-h-full w-full max-w-3xl items-center px-4 py-8">
          <div className="mx-auto grid w-full gap-4">
            <div className="justify-self-center text-center">
              <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" />
              <h1 className="mt-3 text-lg font-semibold">Operate your infrastructure by intent</h1>
              <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                Start an end-to-end journey. I will collect the missing requirements one at a time,
                then prepare the plan and guide the work through verification.
              </p>
            </div>

            {relayNeedsAttention ? (
              <Notice
                tone="destructive"
                title="Opfield needs attention"
                actions={
                  <NoticeAction tone="destructive" onClick={onInvestigateOperationalIssue}>
                    Investigate
                  </NoticeAction>
                }
              >
                An Opfield relay issue may affect managed nodes or secure database connections.
              </Notice>
            ) : setupPending ? (
              <Notice
                tone="info"
                title="Finalize setup"
                actions={
                  <NoticeAction tone="info" onClick={() => setFinalizeSetupOpen(true)}>
                    Open checklist
                  </NoticeAction>
                }
              >
                Connect infrastructure, secure your account, and enable optional Opfield features.
              </Notice>
            ) : null}

            {featured.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-3">
                {featured.map((scenario) => (
                  <ScenarioButton
                    key={scenario.id}
                    scenario={scenario}
                    onStart={onStart}
                    disabled={disabled}
                  />
                ))}
              </div>
            )}

            <Button
              type="button"
              variant="link"
              size="inline"
              className="justify-self-center text-sm"
              disabled={scenarios.length === 0}
              onClick={() => setCatalogOpen(true)}
            >
              Show all scenarios <span aria-hidden="true">→</span>
            </Button>
          </div>
        </div>
      )}

      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Scenarios</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Choose an outcome. The assistant will gather requirements before it plans any changes.
          </DialogDescription>
          <div className="space-y-5">
            {categorized.map((group) => (
              <section key={group.category} className="space-y-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  {CATEGORY_LABELS[group.category]}
                </h2>
                <div className="grid gap-2">
                  {group.scenarios.map((scenario) => (
                    <ScenarioButton
                      key={scenario.id}
                      scenario={scenario}
                      disabled={disabled}
                      onStart={(selected) => {
                        setCatalogOpen(false);
                        onStart(selected);
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      {finalizeSetup && (
        <FinalizeSetupFlow
          open={finalizeSetupOpen}
          state={finalizeSetup}
          inviteUserMethods={inviteUserMethods}
          onClose={() => setFinalizeSetupOpen(false)}
          onUpdateStep={async (step, status) => {
            const next = await api.updateFinalizeSetupStep(step, status);
            setFinalizeSetup(next);
            setSetupPending(Object.values(next.steps).some((value) => value === "pending"));
          }}
        />
      )}
    </div>
  );
}
