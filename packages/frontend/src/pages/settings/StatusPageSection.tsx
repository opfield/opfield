import { Activity, Save } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Combobox } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { SwitchCard } from "@/components/common/SwitchCard";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type {
  Node,
  SSLCertificate,
  StatusPageConfig,
  StatusPageIncident,
  StatusPageIncidentSeverity,
  StatusPageProxyTemplateOption,
  StatusPageServiceItem,
  StatusPageSourceOption,
  StatusPageSourceType,
} from "@/types";

import { StatusPageIngressSelect } from "./StatusPageIngressSelect";

interface StatusPageSectionProps {
  nodesList: Node[];
}

type ServiceSourceType = StatusPageSourceType | "docker";

const DEFAULT_CONFIG: StatusPageConfig = {
  enabled: false,
  title: "System Status",
  description: "",
  domain: "",
  nodeId: null,
  sslCertificateId: null,
  proxyTemplateId: null,
  upstreamUrl: null,
  proxyHostId: null,
  publicIncidentLimit: 25,
  recentIncidentDays: 14,
  autoDegradedEnabled: true,
  autoOutageEnabled: true,
  autoDegradedSeverity: "warning",
  autoOutageSeverity: "critical",
  autoCreateThresholdSeconds: 600,
  autoResolveThresholdSeconds: 60,
};

export function statusBadge(status: string) {
  if (status === "operational" || status === "online") return "success";
  if (status === "info") return "info";
  if (status === "degraded" || status === "maintenance" || status === "warning") return "warning";
  if (status === "outage" || status === "offline" || status === "critical") return "destructive";
  return "secondary";
}

export function getStatusPreviewUrl() {
  if (!import.meta.env.DEV) return "/_status-preview/";
  const url = new URL(window.location.href);
  url.port = "5174";
  url.pathname = "/_status-preview/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function StatusPageSection({ nodesList }: StatusPageSectionProps) {
  const { hasScope } = useAuthStore();
  const canManage = hasScope("status-page:manage");
  const canManageUpstream = hasScope("proxy:raw:write");
  const [config, setConfig] = useState<StatusPageConfig>(
    () => api.getCached<StatusPageConfig>("settings:status-page-config") ?? DEFAULT_CONFIG
  );
  const [savedConfig, setSavedConfig] = useState<StatusPageConfig>(
    () => api.getCached<StatusPageConfig>("settings:status-page-config") ?? DEFAULT_CONFIG
  );
  const [sslCerts, setSslCerts] = useState<SSLCertificate[]>(
    () => api.getCached<SSLCertificate[]>("settings:status-page-ssl-certs") ?? []
  );
  const [proxyTemplates, setProxyTemplates] = useState<StatusPageProxyTemplateOption[]>(
    () =>
      api.getCached<StatusPageProxyTemplateOption[]>("settings:status-page-proxy-templates") ?? []
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    () =>
      api.getCached<StatusPageConfig>("settings:status-page-config") !== undefined &&
      api.getCached<SSLCertificate[]>("settings:status-page-ssl-certs") !== undefined &&
      api.getCached<StatusPageProxyTemplateOption[]>("settings:status-page-proxy-templates") !==
        undefined
  );
  const [savingSettings, setSavingSettings] = useState(false);

  const onlineNginxNodes = useMemo(
    () => nodesList.filter((node) => node.type === "nginx" && node.status === "online"),
    [nodesList]
  );

  const loadStatusPage = useCallback(async () => {
    try {
      const settings = await api.getStatusPageSettings();
      api.setCache("settings:status-page-config", settings);
      setConfig(settings);
      setSavedConfig(settings);
    } catch {
      /* optional feature; ignore until user opens it */
    }
  }, []);

  const loadProxyTemplates = useCallback(async () => {
    try {
      const templates = await api.listStatusPageProxyTemplates();
      api.setCache("settings:status-page-proxy-templates", templates);
      setProxyTemplates(templates);
    } catch {
      setProxyTemplates([]);
    }
  }, []);

  useEffect(() => {
    void Promise.allSettled([
      loadStatusPage(),
      loadProxyTemplates(),
      api.listSSLCertificates({ limit: 100 }).then((res) => {
        api.setCache("settings:status-page-ssl-certs", res.data ?? []);
        setSslCerts(res.data ?? []);
      }),
    ]).finally(() => setInitialLoadComplete(true));
  }, [loadProxyTemplates, loadStatusPage]);

  useRealtime("status-page.changed", () => {
    loadStatusPage();
  });
  useRealtime("nginx.template.changed", () => {
    loadProxyTemplates();
  });

  const statusPageSettingsPayload = useMemo(
    () => ({
      enabled: config.enabled,
      domain: config.domain,
      upstreamUrl: config.upstreamUrl?.trim() ? config.upstreamUrl.trim() : null,
      nodeId: config.nodeId || null,
      ingressGroupId: config.ingressGroupId || null,
      sslCertificateId: config.sslCertificateId,
      proxyTemplateId: config.proxyTemplateId,
    }),
    [
      config.domain,
      config.enabled,
      config.ingressGroupId,
      config.nodeId,
      config.proxyTemplateId,
      config.sslCertificateId,
      config.upstreamUrl,
    ]
  );

  const savedStatusPageSettingsPayload = useMemo(
    () => ({
      enabled: savedConfig.enabled,
      domain: savedConfig.domain,
      upstreamUrl: savedConfig.upstreamUrl?.trim() ? savedConfig.upstreamUrl.trim() : null,
      nodeId: savedConfig.nodeId || null,
      ingressGroupId: savedConfig.ingressGroupId || null,
      sslCertificateId: savedConfig.sslCertificateId,
      proxyTemplateId: savedConfig.proxyTemplateId,
    }),
    [
      savedConfig.domain,
      savedConfig.enabled,
      savedConfig.ingressGroupId,
      savedConfig.nodeId,
      savedConfig.proxyTemplateId,
      savedConfig.sslCertificateId,
      savedConfig.upstreamUrl,
    ]
  );

  const hasSettingsChanges =
    JSON.stringify(statusPageSettingsPayload) !== JSON.stringify(savedStatusPageSettingsPayload);

  const saveConfig = async () => {
    if (!canManage) return;
    setSavingSettings(true);
    try {
      const updated = await api.updateStatusPageSettings(statusPageSettingsPayload);
      api.setCache("settings:status-page-config", updated);
      setConfig(updated);
      setSavedConfig(updated);
      toast.success("Status page settings updated");
    } catch (err) {
      if (!handleLicenseApiError(err, "Status Page")) {
        toast.error(err instanceof Error ? err.message : "Failed to update status page");
      }
      loadStatusPage();
    } finally {
      setSavingSettings(false);
    }
  };

  useContentLoading(!initialLoadComplete);
  if (!initialLoadComplete) return null;

  return (
    <PanelShell
      icon={<Activity className="h-4 w-4" />}
      title={
        <span className="inline-flex items-center gap-2">
          <span>Status Page</span>
          <LicensePlanBadge feature="status-pages" label="Personal+" />
        </span>
      }
      description="Enable the public status page and configure its custom domain"
      actions={
        <Button
          onClick={saveConfig}
          pending={savingSettings}
          disabled={!canManage || !hasSettingsChanges}
        >
          <Save className="h-4 w-4" />
          Save
        </Button>
      }
      dirty={hasSettingsChanges}
    >
      <div className="divide-y divide-border">
        <SettingsRow
          label="Enabled"
          description="Expose the public status page through the configured domain"
          controlClassName="w-auto"
          preserveRow
        >
          <Switch
            checked={config.enabled}
            disabled={!canManage || savingSettings}
            onChange={(enabled) => {
              if (enabled && !requireLicenseFeature("status-pages", "Status Page")) return;
              setConfig((prev) => ({ ...prev, enabled }));
            }}
          />
        </SettingsRow>
        <SettingsRow label="Domain" description="Public hostname for the status page">
          <Input
            value={config.domain}
            disabled={!canManage || savingSettings}
            placeholder="status.example.com"
            onChange={(event) => setConfig((prev) => ({ ...prev, domain: event.target.value }))}
          />
        </SettingsRow>
        <SettingsRow
          label="Gateway upstream URL"
          description="Internal Gateway URL used by the generated proxy host"
          help="Address the selected ingress node uses to reach Gateway. Use an internal address that is reachable from that node, not necessarily the public browser URL. Leave empty to use loopback on the Gateway host, or the Gateway address nodes enroll with (local first) from any other node."
        >
          <Input
            value={config.upstreamUrl ?? ""}
            disabled={!canManage || !canManageUpstream || savingSettings}
            placeholder="http://172.16.20.60:3000"
            onChange={(event) =>
              setConfig((prev) => ({ ...prev, upstreamUrl: event.target.value }))
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Ingress node"
          description="Online Ingress node, or ingress group, that serves the public status page"
          help="The selected Nginx node owns the public virtual host, terminates TLS, and proxies status-page requests back to Gateway. An ingress group serves it from every member, so the page stays reachable while one site is down."
        >
          <StatusPageIngressSelect
            nodeId={config.nodeId}
            ingressGroupId={config.ingressGroupId ?? null}
            enabled={savedConfig.enabled && config.enabled}
            disabled={!canManage || savingSettings}
            onlineNginxNodes={onlineNginxNodes}
            onChange={(target) => setConfig((prev) => ({ ...prev, ...target }))}
          />
        </SettingsRow>
        <SettingsRow
          label="SSL certificate"
          description="Certificate presented by the public status page endpoint"
          help="Certificate browsers receive for the status-page domain. It must be active and cover the configured hostname."
        >
          <Select
            value={config.sslCertificateId ?? "__none__"}
            disabled={!canManage || savingSettings}
            onValueChange={(sslCertificateId) =>
              setConfig((prev) => ({
                ...prev,
                sslCertificateId: sslCertificateId === "__none__" ? null : sslCertificateId,
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No certificate</SelectItem>
              {sslCerts
                .filter((cert) => cert.status === "active")
                .map((cert) => (
                  <SelectItem key={cert.id} value={cert.id}>
                    {cert.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Proxy template"
          description="Optional nginx template override for the generated proxy host"
          help="Uses a custom Nginx configuration template instead of Gateway's default status-page proxy. Leave it on Default unless the route requires specialized proxy behavior."
        >
          <Select
            value={config.proxyTemplateId ?? "__default__"}
            disabled={!canManage || savingSettings}
            onValueChange={(proxyTemplateId) =>
              setConfig((prev) => ({
                ...prev,
                proxyTemplateId: proxyTemplateId === "__default__" ? null : proxyTemplateId,
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Default template</SelectItem>
              {proxyTemplates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </div>
    </PanelShell>
  );
}

function SettingsRow({
  label,
  description,
  help,
  children,
  controlClassName = "w-full md:w-[28rem]",
  preserveRow = false,
}: {
  label: string;
  description: string;
  help?: string;
  children: React.ReactNode;
  controlClassName?: string;
  /** Keep compact controls, such as a switch, aligned with their description at every width. */
  preserveRow?: boolean;
}) {
  return (
    <label
      className={
        preserveRow
          ? "flex flex-row items-center justify-between gap-4 px-4 py-3"
          : "flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-4"
      }
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">
          <SettingsHelpTitle label={label} help={help} />
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <span className={`min-w-0 shrink-0 ${controlClassName}`}>{children}</span>
    </label>
  );
}

export function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

/** Reports a load to the enclosing dialog while rendered inside its content. */
function ReportLoading({ loading }: { loading: boolean }) {
  useContentLoading(loading);
  return null;
}

export function ServiceDialog({
  open,
  onOpenChange,
  service,
  services,
  sources,
  sourceOptionsLoading = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: StatusPageServiceItem | null;
  services: StatusPageServiceItem[];
  /** Exposable resources the caller can view (GET /status-page/sources). */
  sources: StatusPageSourceOption[];
  sourceOptionsLoading?: boolean;
  onSaved: () => void;
}) {
  const [sourceType, setSourceType] = useState<ServiceSourceType>("proxy_host");
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [group, setGroup] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  // Only the first load of the picker holds the dialog; later refreshes keep
  // the known sources usable.
  const sourcesPending = sourceOptionsLoading && sources.length === 0;

  useEffect(() => {
    if (!open) return;
    setSourceType(
      service?.sourceType?.startsWith("docker_") && service.sourceType !== "docker_compose_project"
        ? "docker"
        : (service?.sourceType ?? "proxy_host")
    );
    setSourceId(service?.sourceId ?? "");
    setName(service?.publicName ?? "");
    setDescription(service?.publicDescription ?? "");
    setGroup(service?.publicGroup ?? "");
    setEnabled(service?.enabled ?? true);
  }, [open, service]);

  const sourceOptions = useMemo(() => {
    const exposed = new Set(
      services.filter((item) => item.id !== service?.id).map((item) => item.sourceId)
    );
    const withNode = (source: StatusPageSourceOption, label: string) =>
      source.nodeName && source.sourceType !== "node" ? `${label} (${source.nodeName})` : label;
    return sources.flatMap((source) => {
      if (exposed.has(source.sourceId)) return [];
      if (sourceType === "docker") {
        if (source.sourceType === "docker_container")
          return [
            {
              id: `docker_container:${source.sourceId}`,
              label: withNode(source, `Container: ${source.name}`),
            },
          ];
        if (source.sourceType === "docker_deployment")
          return [
            {
              id: `docker_deployment:${source.sourceId}`,
              label: withNode(source, `Deployment: ${source.name}`),
            },
          ];
        return [];
      }
      if (source.sourceType !== sourceType) return [];
      return [{ id: source.sourceId, label: withNode(source, source.name) }];
    });
  }, [service?.id, services, sourceType, sources]);
  const groupOptions = useMemo(
    () =>
      Array.from(
        new Set(
          services
            .map((item) => item.publicGroup?.trim())
            .filter((value): value is string => Boolean(value))
        )
      )
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value })),
    [services]
  );

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        publicName: name.trim(),
        publicDescription: description.trim() || null,
        publicGroup: group.trim() || null,
        enabled,
      };
      if (service) {
        await api.updateStatusPageService(service.id, payload);
        toast.success("Exposed service updated");
      } else {
        const [resolvedSourceType, ...resolvedSourceIdParts] =
          sourceType === "docker" ? sourceId.split(":") : [sourceType, sourceId];
        await api.createStatusPageService({
          ...payload,
          sourceType: resolvedSourceType as StatusPageSourceType,
          sourceId: resolvedSourceIdParts.join(":"),
        });
        toast.success("Service exposed");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save service");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{service ? "Edit Exposed Service" : "Expose Service"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <ReportLoading loading={!service && sourcesPending} />
          {!service && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Source type">
                <Select
                  value={sourceType}
                  onValueChange={(value) => {
                    setSourceType(value as ServiceSourceType);
                    setSourceId("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="node">Node</SelectItem>
                    <SelectItem value="proxy_host">Proxy Host</SelectItem>
                    <SelectItem value="database">Database</SelectItem>
                    <SelectItem value="docker">Docker Container or Deployment</SelectItem>
                    <SelectItem value="docker_compose_project">Docker Compose Project</SelectItem>
                    <SelectItem value="pages_project">Pages Project</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Source">
                <Combobox
                  value={sourceId}
                  onValueChange={setSourceId}
                  options={sourceOptions.map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                  disabled={sourcesPending}
                  showAllOptionsOnFocus
                  ariaLabel="Source"
                  placeholder="Select source"
                  searchPlaceholder="Search sources..."
                  emptyMessage="No available sources found."
                />
              </Field>
            </div>
          )}
          <Field label="Public name">
            <Input
              value={name}
              placeholder="Customer-facing service name"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Public description">
            <Input
              value={description}
              placeholder="Optional description shown on the public page"
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label="Group">
            <Combobox
              freeText
              showAllOptionsOnFocus
              value={group}
              options={groupOptions}
              onValueChange={setGroup}
              ariaLabel="Group"
              placeholder="e.g. Core Infrastructure"
              searchPlaceholder="Search or enter a group..."
              emptyMessage="Enter a new group name."
            />
          </Field>
          <SwitchCard
            label="Visible on public page"
            description="Hidden services remain configured but are not shown to visitors."
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={save}
            pending={saving}
            disabled={!name.trim() || (!service && !sourceId)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function IncidentDialog({
  open,
  onOpenChange,
  incident,
  services,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  incident: StatusPageIncident | null;
  services: StatusPageServiceItem[];
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState<StatusPageIncidentSeverity>("warning");
  const [affectedServiceIds, setAffectedServiceIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(incident?.title ?? "");
    setMessage(incident?.message ?? "");
    setSeverity(incident?.severity ?? "warning");
    setAffectedServiceIds(incident?.affectedServiceIds ?? []);
  }, [incident, open]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        message: message.trim(),
        severity,
        affectedServiceIds,
      };
      if (incident) {
        await api.updateStatusPageIncident(incident.id, payload);
        toast.success("Incident updated");
      } else {
        await api.createStatusPageIncident(payload);
        toast.success("Incident created");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save incident");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{incident ? "Edit Incident Details" : "Create Incident"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Message">
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              className="min-h-28"
            />
          </Field>
          <Field label="Severity">
            <Select value={severity} onValueChange={(value) => setSeverity(value as never)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="space-y-2 border border-border p-3">
            {services.map((service) => (
              <label key={service.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={affectedServiceIds.includes(service.id)}
                  onChange={(event) =>
                    setAffectedServiceIds((prev) =>
                      event.target.checked
                        ? [...prev, service.id]
                        : prev.filter((id) => id !== service.id)
                    )
                  }
                />
                {service.publicName}
              </label>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} pending={saving} disabled={!title.trim() || !message.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
