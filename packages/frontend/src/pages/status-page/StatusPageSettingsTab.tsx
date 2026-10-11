import { Save, Settings2, Siren } from "lucide-react";
import { type Dispatch, type SetStateAction, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { SectionHeader } from "@/components/common/SectionHeader";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { Textarea } from "@/components/ui/textarea";
import type { StatusPageConfig, StatusPageIncidentSeverity } from "@/types";

interface StatusPageSettingsTabProps {
  config: StatusPageConfig;
  savedConfig: StatusPageConfig;
  canManage: boolean;
  saving: boolean;
  onConfigChange: Dispatch<SetStateAction<StatusPageConfig>>;
  onSave: (patch: Partial<StatusPageConfig>) => Promise<void>;
}

export function StatusPageSettingsTab({
  config,
  savedConfig,
  canManage,
  saving,
  onConfigChange,
  onSave,
}: StatusPageSettingsTabProps) {
  const [savingSection, setSavingSection] = useState<"general" | "auto" | null>(null);
  const disabled = !canManage || saving;
  const generalDirty =
    config.title !== savedConfig.title ||
    config.description !== savedConfig.description ||
    config.recentIncidentDays !== savedConfig.recentIncidentDays ||
    config.publicIncidentLimit !== savedConfig.publicIncidentLimit;
  const autoIncidentDirty =
    config.autoDegradedEnabled !== savedConfig.autoDegradedEnabled ||
    config.autoOutageEnabled !== savedConfig.autoOutageEnabled ||
    config.autoDegradedSeverity !== savedConfig.autoDegradedSeverity ||
    config.autoOutageSeverity !== savedConfig.autoOutageSeverity ||
    config.autoCreateThresholdSeconds !== savedConfig.autoCreateThresholdSeconds ||
    config.autoResolveThresholdSeconds !== savedConfig.autoResolveThresholdSeconds;
  const setSeverity = (key: "autoDegradedSeverity" | "autoOutageSeverity") => (value: string) => {
    const severity = value as StatusPageIncidentSeverity;
    onConfigChange((prev) => ({ ...prev, [key]: severity }));
  };

  const saveGeneralSettings = async () => {
    setSavingSection("general");
    try {
      await onSave({
        title: config.title,
        description: config.description,
        recentIncidentDays: config.recentIncidentDays,
        publicIncidentLimit: config.publicIncidentLimit,
      });
    } finally {
      setSavingSection(null);
    }
  };

  const saveAutoIncidentSettings = async () => {
    setSavingSection("auto");
    try {
      await onSave({
        autoDegradedEnabled: config.autoDegradedEnabled,
        autoOutageEnabled: config.autoOutageEnabled,
        autoDegradedSeverity: config.autoDegradedSeverity,
        autoOutageSeverity: config.autoOutageSeverity,
        autoCreateThresholdSeconds: config.autoCreateThresholdSeconds,
        autoResolveThresholdSeconds: config.autoResolveThresholdSeconds,
      });
    } finally {
      setSavingSection(null);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <PanelShell
        title="General Settings"
        icon={<Settings2 className="h-4 w-4" />}
        description="Configure public copy and recent incident visibility."
        dirty={generalDirty}
        className="flex h-full flex-col"
        bodyClassName="flex flex-1 flex-col"
        actions={
          canManage ? (
            <Button
              onClick={() => void saveGeneralSettings()}
              pending={savingSection === "general"}
              disabled={disabled || !generalDirty}
            >
              <Save />
              Save
            </Button>
          ) : null
        }
      >
        <SettingsControlRow
          title="Public title"
          description="Heading shown at the top of the public status page."
          controlsClassName="sm:min-w-0"
        >
          <Input
            aria-label="Public title"
            value={config.title}
            placeholder="e.g. Acme Status"
            disabled={disabled}
            className="w-full sm:w-72"
            onChange={(event) => onConfigChange((prev) => ({ ...prev, title: event.target.value }))}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Recent resolved incidents"
          description="Number of days resolved incidents remain visible on the public page."
          help="Controls public visibility only. Older resolved incidents remain stored in Opfield but are omitted from the public status page."
          controlsClassName="sm:min-w-0"
        >
          <Input
            aria-label="Recent resolved incident days"
            className="w-32"
            type="number"
            min={1}
            max={365}
            value={config.recentIncidentDays}
            disabled={disabled}
            onChange={(event) =>
              onConfigChange((prev) => ({
                ...prev,
                recentIncidentDays: Number(event.target.value),
              }))
            }
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Public incident limit"
          description="Maximum number of recent incidents included on the public page."
          help="Caps how many incidents the public page returns at once after applying the visibility period above. It does not delete incidents or limit incident creation."
          controlsClassName="sm:min-w-0"
        >
          <Input
            aria-label="Public incident limit"
            className="w-32"
            type="number"
            min={1}
            max={100}
            value={config.publicIncidentLimit}
            disabled={disabled}
            onChange={(event) =>
              onConfigChange((prev) => ({
                ...prev,
                publicIncidentLimit: Number(event.target.value),
              }))
            }
          />
        </SettingsControlRow>
        <div className="flex min-h-0 flex-1 flex-col">
          <SectionHeader
            title="Public description"
            description="Short context displayed beneath the public title."
            className="px-4 py-3"
          />
          <div className="flex min-h-0 flex-1">
            <Textarea
              aria-label="Public description"
              value={config.description}
              placeholder="Short description shown beneath the public status page title"
              disabled={disabled}
              className="min-h-0 flex-1 resize-none rounded-none border-0 p-4 shadow-none focus-visible:ring-1 focus-visible:ring-inset"
              onChange={(event) =>
                onConfigChange((prev) => ({ ...prev, description: event.target.value }))
              }
            />
          </div>
        </div>
      </PanelShell>

      <PanelShell
        title="Auto-Incident Settings"
        icon={<Siren className="h-4 w-4" />}
        description="Configure automatic incident creation and severity defaults."
        dirty={autoIncidentDirty}
        actions={
          canManage ? (
            <Button
              onClick={() => void saveAutoIncidentSettings()}
              pending={savingSection === "auto"}
              disabled={disabled || !autoIncidentDirty}
            >
              <Save />
              Save
            </Button>
          ) : null
        }
      >
        <SettingsControlRow
          title="Auto incidents for degraded services"
          description="Create an automatic incident when an exposed service is degraded."
          help="Applies only to services exposed on this Status Page. Opfield opens and later resolves the incident automatically from observed service health."
          controlsClassName="sm:min-w-0"
        >
          <Switch
            checked={config.autoDegradedEnabled}
            disabled={disabled}
            ariaLabel="Auto incidents for degraded services"
            onChange={(autoDegradedEnabled) =>
              onConfigChange((prev) => ({ ...prev, autoDegradedEnabled }))
            }
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Degraded incident severity"
          description="Severity used for automatic degraded-service incidents."
          help="Sets the public severity and notification priority of incidents created for degraded services. It does not change how Opfield determines that a service is degraded."
          controlsClassName="sm:min-w-0"
        >
          <Select
            value={config.autoDegradedSeverity}
            disabled={disabled || !config.autoDegradedEnabled}
            onValueChange={setSeverity("autoDegradedSeverity")}
          >
            <SelectTrigger className="w-40" aria-label="Degraded incident severity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
        </SettingsControlRow>
        <SettingsControlRow
          title="Auto incidents for outages"
          description="Create an automatic incident when an exposed service is offline."
          help="Applies only to services exposed on this Status Page. An outage incident is created after the configured delay when Opfield observes the service as offline."
          controlsClassName="sm:min-w-0"
        >
          <Switch
            checked={config.autoOutageEnabled}
            disabled={disabled}
            ariaLabel="Auto incidents for outages"
            onChange={(autoOutageEnabled) =>
              onConfigChange((prev) => ({ ...prev, autoOutageEnabled }))
            }
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Outage incident severity"
          description="Severity used for automatic outage incidents."
          help="Sets the public severity and notification priority of incidents created for offline services. It does not change the service health check itself."
          controlsClassName="sm:min-w-0"
        >
          <Select
            value={config.autoOutageSeverity}
            disabled={disabled || !config.autoOutageEnabled}
            onValueChange={setSeverity("autoOutageSeverity")}
          >
            <SelectTrigger className="w-40" aria-label="Outage incident severity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
        </SettingsControlRow>
        <SettingsControlRow
          title="Create incident delay"
          description="Seconds a degraded or offline state must persist before creating an incident."
          help="Prevents brief health-check failures from immediately becoming public incidents. The timer resets if the service recovers before this delay expires."
          controlsClassName="sm:min-w-0"
        >
          <Input
            aria-label="Create incident after seconds"
            className="w-32"
            type="number"
            min={30}
            max={86400}
            value={config.autoCreateThresholdSeconds}
            disabled={disabled}
            onChange={(event) =>
              onConfigChange((prev) => ({
                ...prev,
                autoCreateThresholdSeconds: Number(event.target.value),
              }))
            }
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Resolve incident delay"
          description="Seconds a service must remain healthy before resolving its automatic incident."
          help="Prevents a briefly recovered service from closing an incident too early. The service must remain healthy continuously for this entire delay."
          controlsClassName="sm:min-w-0"
        >
          <Input
            aria-label="Resolve incident after seconds"
            className="w-32"
            type="number"
            min={30}
            max={86400}
            value={config.autoResolveThresholdSeconds}
            disabled={disabled}
            onChange={(event) =>
              onConfigChange((prev) => ({
                ...prev,
                autoResolveThresholdSeconds: Number(event.target.value),
              }))
            }
          />
        </SettingsControlRow>
      </PanelShell>
    </div>
  );
}
