import { Play, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow, SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DockerHealthCheck } from "@/types";

type HealthTarget =
  | { target: "container"; containerName: string; deploymentId?: never }
  | { target: "deployment"; deploymentId: string; containerName?: never };

interface DockerHealthCheckSectionProps {
  nodeId: string;
  disabled?: boolean;
  initialHealthCheck?: DockerHealthCheck | null;
  onSaved?: (healthCheck: DockerHealthCheck) => void;
}

const DEFAULT_CHECK: DockerHealthCheck = {
  id: null,
  target: "container",
  nodeId: "",
  containerName: null,
  deploymentId: null,
  enabled: false,
  scheme: "http",
  hostPort: null,
  containerPort: null,
  path: "/",
  statusMin: 200,
  statusMax: 399,
  expectedBody: null,
  bodyMatchMode: "includes",
  intervalSeconds: 30,
  timeoutSeconds: 5,
  slowThreshold: 1000,
  healthStatus: "disabled",
  lastHealthCheckAt: null,
  healthHistory: [],
  routeOptions: [],
};

function routeValue(check: Pick<DockerHealthCheck, "hostPort" | "containerPort">) {
  return check.hostPort && check.containerPort
    ? `${check.hostPort}:${check.containerPort}`
    : "__none__";
}

function applyHealth(check: DockerHealthCheck) {
  return {
    enabled: check.enabled,
    scheme: check.scheme,
    hostPort: check.hostPort,
    containerPort: check.containerPort,
    path: check.path || "/",
    statusMin: Number(check.statusMin),
    statusMax: Number(check.statusMax),
    expectedBody: check.expectedBody?.trim() ? check.expectedBody : null,
    bodyMatchMode: check.bodyMatchMode,
    intervalSeconds: Number(check.intervalSeconds),
    timeoutSeconds: Number(check.timeoutSeconds),
    slowThreshold: Number(check.slowThreshold),
  };
}

export function DockerHealthCheckSection({
  nodeId,
  disabled,
  initialHealthCheck,
  onSaved,
  ...targetProps
}: DockerHealthCheckSectionProps & HealthTarget) {
  const target = targetProps.target;
  const containerName = targetProps.target === "container" ? targetProps.containerName : undefined;
  const deploymentId = targetProps.target === "deployment" ? targetProps.deploymentId : undefined;
  const [base, setBase] = useState<DockerHealthCheck | null>(initialHealthCheck ?? null);
  const [draft, setDraft] = useState<DockerHealthCheck>(initialHealthCheck ?? DEFAULT_CHECK);
  const [loading, setLoading] = useState(!initialHealthCheck);
  useContentLoading(loading);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data =
        target === "deployment"
          ? await api.getDeploymentHealthCheck(nodeId, deploymentId!)
          : await api.getContainerHealthCheck(nodeId, containerName!);
      setBase(data);
      setDraft(data);
    } catch (err) {
      toastApiError(err, "Failed to load health check");
    } finally {
      setLoading(false);
    }
  }, [containerName, deploymentId, nodeId, target]);

  useEffect(() => {
    if (initialHealthCheck) {
      setBase(initialHealthCheck);
      setDraft(initialHealthCheck);
      setLoading(false);
      return;
    }
    void load();
  }, [initialHealthCheck, load]);

  const changed = useMemo(() => {
    if (!base) return true;
    return JSON.stringify(applyHealth(draft)) !== JSON.stringify(applyHealth(base));
  }, [base, draft]);

  const selectedRoute = routeValue(draft);
  const routeRequired = draft.enabled && selectedRoute === "__none__";

  const setField = <K extends keyof DockerHealthCheck>(key: K, value: DockerHealthCheck[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = applyHealth(draft);
      const data =
        target === "deployment"
          ? await api.updateDeploymentHealthCheck(nodeId, deploymentId!, payload)
          : await api.updateContainerHealthCheck(nodeId, containerName!, payload);
      setBase(data);
      setDraft(data);
      onSaved?.(data);
      toast.success("Health check saved");
    } catch (err) {
      toastApiError(err, "Failed to save health check");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const payload = applyHealth(draft);
      const result =
        target === "deployment"
          ? await api.testDeploymentHealthCheck(nodeId, deploymentId!, payload)
          : await api.testContainerHealthCheck(nodeId, containerName!, payload);
      toast[result.ok ? "success" : "error"](
        `Health check ${result.status}${result.responseMs ? ` in ${result.responseMs}ms` : ""}`
      );
    } catch (err) {
      toastApiError(err, "Health check failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <PanelShell
      title={
        <SettingsHelpTitle
          label="Health Check"
          help="Opfield periodically requests a published HTTP route and records availability, response time, status code, and optional body validation."
        />
      }
      description="Opfield HTTP health from a published route"
      dirty={changed}
      wrapHeader
      actions={
        <>
          <Button
            variant="outline"
            onClick={test}
            pending={testing}
            disabled={disabled || loading || !draft.enabled || routeRequired}
          >
            <Play className="h-3.5 w-3.5" />
            Test
          </Button>
          <Button
            onClick={save}
            pending={saving}
            disabled={disabled || loading || !changed || routeRequired}
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
        </>
      }
      bodyClassName="divide-y divide-border"
    >
      <SettingsControlRow
        title="Enabled"
        description="Run Opfield HTTP checks for this target"
        help="Starts scheduled checks from Opfield. This is separate from a Dockerfile HEALTHCHECK executed inside the Docker runtime."
        controlsClassName="flex justify-end justify-self-end !w-auto !min-w-0 !max-w-none"
      >
        <Switch
          checked={draft.enabled}
          disabled={disabled || loading}
          onChange={(enabled) => setField("enabled", enabled)}
        />
      </SettingsControlRow>

      <SettingsControlRow
        title="Route and Scheme"
        description="Published route used for checks"
        help="Selects the published host/container port pair Opfield should call and whether the request uses HTTP or HTTPS."
      >
        <div className="grid w-full gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Select
              value={selectedRoute}
              onValueChange={(value) => {
                if (value === "__none__") {
                  setDraft((prev) => ({ ...prev, hostPort: null, containerPort: null }));
                  return;
                }
                const option = draft.routeOptions.find((item) => item.id === value);
                if (!option) return;
                setDraft((prev) => ({
                  ...prev,
                  scheme: option.scheme,
                  hostPort: option.hostPort,
                  containerPort: option.containerPort,
                }));
              }}
              disabled={disabled || loading || draft.routeOptions.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select route" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No route</SelectItem>
                {draft.routeOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                    {option.isPrimary ? " primary" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {routeRequired && <p className="text-xs text-destructive">Select a route.</p>}
          </div>
          <Select
            value={draft.scheme}
            onValueChange={(scheme) => setField("scheme", scheme as "http" | "https")}
            disabled={disabled || loading}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">HTTP</SelectItem>
              <SelectItem value="https">HTTPS</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </SettingsControlRow>

      <SettingsControlRow
        title="Request"
        description="Path and slow response threshold"
        help="Path is appended to the selected route. Responses slower than the threshold remain reachable but are reported as degraded."
      >
        <div className="grid w-full gap-2 sm:grid-cols-2">
          <Input
            value={draft.path}
            onChange={(event) => setField("path", event.target.value)}
            disabled={disabled || loading}
          />
          <Input
            inputMode="numeric"
            value={draft.slowThreshold}
            onChange={(event) => setField("slowThreshold", Number(event.target.value))}
            disabled={disabled || loading}
          />
        </div>
      </SettingsControlRow>

      <SettingsControlRow
        title="Status Range"
        description="Accepted HTTP status codes"
        help="Only responses within this inclusive minimum and maximum range count as healthy. A typical range is 200 through 399."
      >
        <div className="grid w-full gap-2 sm:grid-cols-2">
          <Input
            inputMode="numeric"
            value={draft.statusMin}
            onChange={(event) => setField("statusMin", Number(event.target.value))}
            disabled={disabled || loading}
          />
          <Input
            inputMode="numeric"
            value={draft.statusMax}
            onChange={(event) => setField("statusMax", Number(event.target.value))}
            disabled={disabled || loading}
          />
        </div>
      </SettingsControlRow>

      <SettingsControlRow
        title="Timing"
        description="Check interval and request timeout"
        help="Interval controls how often Opfield checks the route. Timeout is the maximum wait for one response and should remain shorter than the interval."
      >
        <div className="grid w-full gap-2 sm:grid-cols-2">
          <Input
            inputMode="numeric"
            value={draft.intervalSeconds}
            onChange={(event) => setField("intervalSeconds", Number(event.target.value))}
            disabled={disabled || loading}
          />
          <Input
            inputMode="numeric"
            value={draft.timeoutSeconds}
            onChange={(event) => setField("timeoutSeconds", Number(event.target.value))}
            disabled={disabled || loading}
          />
        </div>
      </SettingsControlRow>

      <SettingsControlRow
        title="Body Match"
        description="Optional response body assertion"
        help="Optionally verifies response content after the status check passes. Useful for detecting a healthy proxy that is serving the wrong application response."
      >
        <div className="grid w-full gap-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <Select
            value={draft.bodyMatchMode}
            onValueChange={(mode) =>
              setField("bodyMatchMode", mode as DockerHealthCheck["bodyMatchMode"])
            }
            disabled={disabled || loading}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="includes">Includes</SelectItem>
              <SelectItem value="exact">Exact</SelectItem>
              <SelectItem value="starts_with">Starts With</SelectItem>
              <SelectItem value="ends_with">Ends With</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={draft.expectedBody ?? ""}
            onChange={(event) => setField("expectedBody", event.target.value)}
            disabled={disabled || loading}
          />
        </div>
      </SettingsControlRow>
    </PanelShell>
  );
}
