import {
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Gauge,
  Loader2,
  Plus,
  Server,
  Sigma,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatCard } from "@/components/ui/stat-card";
import {
  useInferenceSelfUsage,
  useInferenceSelfUsageOverview,
} from "@/hooks/use-inference-self-usage";
import {
  INFERENCE_USAGE_WARNING_REMAINING_PERCENT,
  type InferenceUsageWindowId,
  lowInferenceUsageWindows,
} from "@/lib/dashboard-attention";
import { cn, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import type {
  InferenceSelfUsage,
  InferenceSystemUsage,
  InferenceUsageOverview,
  InferenceUsageWindow,
} from "@/types/inference";
import {
  InferenceEndpointRow,
  InferenceHarnessDialog,
} from "../settings/inference/InferenceEndpointSettingsPanel";

const COMPACT_USAGE_OPEN_KEY = "opfield:account-menu:ai-usage-open";

function remainingPercentage(percentage: number) {
  return Math.round(Math.max(0, Math.min(100, 100 - percentage)));
}

function initialCompactUsageOpen() {
  try {
    const stored = window.localStorage.getItem(COMPACT_USAGE_OPEN_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function InferenceUsagePanel({ usage }: { usage: InferenceSelfUsage }) {
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const subscriptionWindows: Array<{
    label: string;
    value: InferenceUsageWindow;
    icon: typeof Gauge;
  }> = [
    ...(usage.subscription["5h"].configured
      ? [{ label: "5 hours", value: usage.subscription["5h"], icon: Clock3 }]
      : []),
    ...(usage.subscription["7d"].configured
      ? [{ label: "Weekly", value: usage.subscription["7d"], icon: Gauge }]
      : []),
    ...(usage.subscription["30d"].configured
      ? [{ label: "Monthly", value: usage.subscription["30d"], icon: Gauge }]
      : []),
  ];
  const cards = [
    ...(usage.api.configured
      ? [{ label: "API usage", value: usage.api, icon: CircleDollarSign }]
      : []),
    ...subscriptionWindows,
  ];
  const cardCount = cards.length;

  if (cardCount === 0) return null;

  return (
    <>
      <PanelShell
        icon={<Gauge className="h-4 w-4" />}
        title="Inference usage"
        description="Usage limits for the AI models available to you. Limits recover automatically."
        actions={
          <Button onClick={() => setInstructionsOpen(true)}>
            <Plus />
            Set up a harness
          </Button>
        }
      >
        <div
          className={cn(
            "grid grid-cols-1 gap-px bg-border",
            cardCount > 1 && "sm:grid-cols-2",
            cardCount === 4 && "xl:grid-cols-4",
            cardCount === 3 && "xl:grid-cols-3",
            cardCount === 2 && "xl:grid-cols-2"
          )}
        >
          {cards.map(({ label, value, icon }) => (
            <UsageStatCard key={label} label={label} value={value} icon={icon} />
          ))}
        </div>
        <div className="border-t border-border">
          <InferenceEndpointRow />
        </div>
      </PanelShell>
      <InferenceHarnessDialog open={instructionsOpen} onOpenChange={setInstructionsOpen} />
    </>
  );
}

function UsageStatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: InferenceUsageWindow;
  icon: typeof Gauge;
}) {
  const remaining = remainingPercentage(value.percentage);
  const isLow = 100 - value.percentage < INFERENCE_USAGE_WARNING_REMAINING_PERCENT;
  return (
    <StatCard
      className="border-0"
      label={label}
      value={`${remaining}%`}
      valueClassName={isLow ? "text-warning-text" : undefined}
      icon={icon}
      progress={{
        percent: remaining,
        color: isLow ? "var(--color-warning)" : undefined,
      }}
      subtitle={
        value.active === false
          ? "Starts on next use"
          : `Recovers ${formatDateTime(value.recoveryAt)}`
      }
      subtitleClassName="text-xs"
    />
  );
}

export function InferenceUsage({
  previewUsage,
  previewOverview,
}: {
  previewUsage?: InferenceSelfUsage;
  previewOverview?: InferenceUsageOverview;
} = {}) {
  const liveUsage = useInferenceSelfUsage(previewUsage === undefined);
  const liveOverview = useInferenceSelfUsageOverview(previewOverview === undefined);
  const usage = previewUsage ?? liveUsage.usage;
  const overview = previewOverview ?? liveOverview.usage;
  const loading = previewUsage === undefined && liveUsage.loading;
  const overviewLoading = previewOverview === undefined && liveOverview.loading;
  const error = previewUsage === undefined ? liveUsage.error : null;
  useContentLoading(loading || overviewLoading);

  if (loading) return null;
  if (error || !usage?.enabled) return null;

  const hasConfiguredLimit =
    usage.api.configured ||
    usage.subscription["5h"].configured ||
    usage.subscription["7d"].configured ||
    usage.subscription["30d"].configured;
  if (!overview && !overviewLoading && !hasConfiguredLimit) return null;

  return (
    <div className="space-y-4">
      {overview ? <InferenceUsageOverviewCards usage={overview} /> : null}
      {hasConfiguredLimit ? <InferenceUsagePanel usage={usage} /> : null}
    </div>
  );
}

export function DashboardInferenceUsage({
  enabled,
  usage: bootstrapUsage,
}: {
  enabled: boolean;
  usage?: InferenceSelfUsage | null;
}) {
  const {
    usage: fetchedUsage,
    loading,
    error,
  } = useInferenceSelfUsage(enabled && bootstrapUsage === undefined);
  const usage = bootstrapUsage === undefined ? fetchedUsage : bootstrapUsage;
  useContentLoading(loading);

  if (loading || error || !usage?.enabled) return null;

  const windows: Record<InferenceUsageWindowId, { label: string; value: InferenceUsageWindow }> = {
    api: { label: "API usage", value: usage.api },
    "5h": { label: "5 hours", value: usage.subscription["5h"] },
    "7d": { label: "Weekly", value: usage.subscription["7d"] },
    "30d": { label: "Monthly", value: usage.subscription["30d"] },
  };
  const lowWindows = lowInferenceUsageWindows(usage).map((id) => windows[id]);

  if (lowWindows.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4">
      {lowWindows.map(({ label, value }) => {
        const remaining = remainingPercentage(value.percentage);
        return (
          <Notice
            key={label}
            tone="warning"
            role="status"
            aria-label={`${label} inference quota warning`}
            title={`${label} inference quota is running low`}
            actions={
              <div className="w-full sm:w-48">
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">Remaining</span>
                  <span className="font-semibold text-warning-text">{remaining}%</span>
                </div>
                <ProgressBar value={remaining} className="h-2" indicatorClassName="bg-warning" />
              </div>
            }
          >
            Recovers {formatDateTime(value.recoveryAt)}.
          </Notice>
        );
      })}
    </div>
  );
}

export function CompactInferenceUsage({
  withMenuSeparator = false,
}: {
  withMenuSeparator?: boolean;
}) {
  const dashboardUsage = useDashboardBootstrapStore((state) => state.snapshot?.inferenceUsage);
  const dashboardBootstrapLoading = useDashboardBootstrapStore((state) => state.loading);
  const dashboardBootstrapStarted = useDashboardBootstrapStore(
    (state) => state.key !== null || state.request !== null || state.snapshot !== null
  );
  // Sidebar starts the shared dashboard bootstrap after the authenticated shell
  // mounts. Hold this small permission-gated menu section in place until that
  // request settles so it cannot race a second /inference/usage/self request.
  const waitForDashboardBootstrap = !dashboardBootstrapStarted || dashboardBootstrapLoading;
  const useUsageFallback =
    dashboardBootstrapStarted && !dashboardBootstrapLoading && dashboardUsage === undefined;
  const { usage: fetchedUsage, error } = useInferenceSelfUsage(useUsageFallback);
  const usage = dashboardUsage === undefined ? fetchedUsage : dashboardUsage;
  const [open, setOpen] = useState(initialCompactUsageOpen);

  if (waitForDashboardBootstrap) {
    // The account menu has no reveal gate: hold the section's row in place,
    // shaped like the disclosure trigger that replaces it.
    return (
      <>
        <div
          className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground md:py-1.5"
          aria-busy="true"
          aria-label="Loading AI usage"
        >
          <Gauge className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>AI usage remaining</span>
          <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        </div>
        {withMenuSeparator ? <DropdownMenuSeparator className="bg-border" /> : null}
      </>
    );
  }

  if (error || !usage?.enabled) return null;

  const windows = [
    ...(usage.subscription["5h"].configured
      ? [{ label: "5 hours", value: usage.subscription["5h"] }]
      : []),
    ...(usage.subscription["7d"].configured
      ? [{ label: "Weekly", value: usage.subscription["7d"] }]
      : []),
    ...(usage.subscription["30d"].configured
      ? [{ label: "Monthly", value: usage.subscription["30d"] }]
      : []),
    ...(usage.api.configured ? [{ label: "API", value: usage.api }] : []),
  ];

  if (windows.length === 0) return null;

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    try {
      window.localStorage.setItem(COMPACT_USAGE_OPEN_KEY, String(nextOpen));
    } catch {
      // Local storage can be unavailable in privacy-restricted browser contexts.
    }
  };

  return (
    <>
      <Collapsible open={open} onOpenChange={changeOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-2 py-3 text-sm font-normal md:py-1.5"
          >
            <Gauge />
            <span>AI usage remaining</span>
            <ChevronDown
              className={cn("ml-auto transition-transform", open && "rotate-180")}
              aria-hidden="true"
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 px-2 pb-2 pt-1">
            {windows.map(({ label, value }) => {
              const remaining = remainingPercentage(value.percentage);
              return (
                <div
                  key={label}
                  className="space-y-1"
                  aria-label={`${label} remaining ${remaining}%`}
                >
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{label}</span>
                    <span>{remaining}%</span>
                  </div>
                  <ProgressBar value={remaining} indicatorClassName="bg-foreground" />
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {withMenuSeparator ? <DropdownMenuSeparator className="bg-border" /> : null}
    </>
  );
}

export function InferenceOverview({ refreshToken = 0 }: { refreshToken?: number }) {
  const cachedUsage = api.getCached<InferenceSystemUsage>(
    "req:/api/inference/usage/system",
    Number.POSITIVE_INFINITY
  );
  const [usage, setUsage] = useState<InferenceSystemUsage | null>(cachedUsage ?? null);
  const [loading, setLoading] = useState(!cachedUsage);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(Boolean(cachedUsage));

  const load = useCallback(async () => {
    if (!initializedRef.current) setLoading(true);
    try {
      setUsage(await api.getInferenceSystemUsage());
      // A failed first load keeps its message on screen while Retry runs.
      setError(null);
      initializedRef.current = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load system usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshToken;
    void load();
  }, [load, refreshToken]);

  useContentLoading(loading && !usage);

  if (error && !usage) {
    return (
      <PanelShell
        icon={<Gauge className="h-4 w-4" />}
        title="Inference overview"
        actions={
          <Button variant="outline" onClick={() => void load()} pending={loading}>
            Retry
          </Button>
        }
      >
        <div className="px-4 py-6 text-sm text-destructive">{error}</div>
      </PanelShell>
    );
  }

  if (!usage) return null;

  return <InferenceUsageOverviewCards usage={usage} />;
}

export function InferenceUsageOverviewCards({ usage }: { usage: InferenceUsageOverview }) {
  const totals = useMemo(() => {
    const requests = usage.requestTotals.reduce((sum, row) => sum + Number(row.requests), 0);
    return {
      requests,
      tokens: usage.ledgerTotals.reduce((sum, row) => sum + Number(row.tokens), 0),
      credits: usage.ledgerTotals.reduce((sum, row) => sum + Number(row.credits), 0),
      apiMicrodollars: usage.ledgerTotals.reduce(
        (sum, row) => sum + Number(row.apiMicrodollars),
        0
      ),
    };
  }, [usage]);
  const subtitle = `Last ${usage.windowDays} days`;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Inference API usage"
        value={`$${(totals.apiMicrodollars / 1_000_000).toFixed(2)}`}
        icon={CircleDollarSign}
        history={usage.dailyUsage.map((row) => row.apiMicrodollars / 1_000_000)}
        color="var(--color-hue-green)"
        subtitle={subtitle}
        appearance="dashboard"
      />
      <StatCard
        label="Inference tokens"
        value={totals.tokens.toLocaleString()}
        icon={Sigma}
        history={usage.dailyUsage.map((row) => row.tokens)}
        color="var(--color-hue-blue)"
        subtitle={subtitle}
        appearance="dashboard"
      />
      <StatCard
        label="Inference credits"
        value={Math.round(totals.credits).toLocaleString()}
        icon={Gauge}
        history={usage.dailyUsage.map((row) => row.credits)}
        color="var(--color-hue-violet)"
        subtitle={subtitle}
        appearance="dashboard"
      />
      <StatCard
        label="Inference requests"
        value={totals.requests.toLocaleString()}
        icon={Server}
        history={usage.dailyUsage.map((row) => row.requests)}
        color="var(--color-hue-amber)"
        subtitle={subtitle}
        appearance="dashboard"
      />
    </div>
  );
}
