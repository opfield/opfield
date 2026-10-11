import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { ContentLoading } from "@/components/common/ContentLoading";
import { ScopeList } from "@/components/common/ScopeList";
import {
  ScopeSearchFilter,
  type ScopeSelectionFilter,
} from "@/components/common/ScopeSearchFilter";
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
import {
  type AlertCategoryDef,
  type AlertRule,
  gpuDeviceLabel,
  type NotificationWebhook,
} from "@/types";
import {
  AnimatedHeight,
  STEP_ANIMATION,
  TemplateCheatsheetLink,
  TemplateEditor,
  type TemplateEditorHandle,
  UNIVERSAL_VARIABLES,
} from "./template-editor";

const ROOT_DISK_TARGET = "/";
const CERTIFICATE_EXPIRY_METRIC = "days_until_expiry";
const GPU_NODE_METRICS = new Set([
  "gpu_utilization_percent",
  "gpu_memory_used_percent",
  "gpu_temperature_celsius",
  "gpu_power_percent_of_limit",
  "gpu_throttled",
  "gpu_health_degraded",
  "gpu_ecc_corrected_errors",
  "gpu_ecc_uncorrected_errors",
]);

type AlertResourceOption = {
  id: string;
  label: string;
  diskOptions?: Array<{ id: string; label: string }>;
  gpuOptions?: Array<{ id: string; label: string; availableMetrics: string[] }>;
};

function supportsGpuAlertMetric(availableMetrics: readonly string[], metric: string): boolean {
  const available = new Set(availableMetrics);
  switch (metric) {
    case "gpu_utilization_percent":
      return available.has("utilization_percent");
    case "gpu_memory_used_percent":
      return available.has("memory_total_bytes") && available.has("memory_used_bytes");
    case "gpu_temperature_celsius":
      return available.has("temperature_celsius");
    case "gpu_power_percent_of_limit":
      return available.has("power_watts") && available.has("power_limit_watts");
    case "gpu_throttled":
      return available.has("throttled");
    case "gpu_health_degraded":
      return available.has("health");
    case "gpu_ecc_corrected_errors":
      return available.has("ecc_corrected_errors");
    case "gpu_ecc_uncorrected_errors":
      return available.has("ecc_uncorrected_errors");
    default:
      return false;
  }
}

const STEP_LABELS = ["Configuration", "Scope & Webhooks", "Message"];

export function AlertDialog({
  open,
  onOpenChange,
  rule,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rule: AlertRule | null;
  onSaved: () => void;
}) {
  const isEdit = !!rule;
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<AlertCategoryDef[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [webhooks, setWebhooks] = useState<NotificationWebhook[]>([]);
  const [webhooksLoading, setWebhooksLoading] = useState(false);
  const [availableResources, setAvailableResources] = useState<AlertResourceOption[]>([]);
  /** The category whose resources are listed; another value means they are loading. */
  const [resourcesCategory, setResourcesCategory] = useState<string | null>(null);
  const [resourceSearch, setResourceSearch] = useState("");
  const [webhookSearch, setWebhookSearch] = useState("");
  const [resourceFilter, setResourceFilter] = useState<ScopeSelectionFilter>("all");
  const [webhookFilter, setWebhookFilter] = useState<ScopeSelectionFilter>("all");
  const editorRef = useRef<TemplateEditorHandle>(null); // retained for cheatsheet click-to-insert (future)
  const catInitRef = useRef(false);
  const resourceLoadTokenRef = useRef(0);

  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("node");
  const [type, setType] = useState<string>("threshold");
  const [severity, setSeverity] = useState<string>("warning");
  const [metric, setMetric] = useState("");
  const [metricTarget, setMetricTarget] = useState(ROOT_DISK_TARGET);
  const [operator, setOperator] = useState(">");
  const [thresholdValue, setThresholdValue] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("0");
  const [fireThresholdPercent, setFireThresholdPercent] = useState("100");
  const [resolveAfterMinutes, setResolveAfterMinutes] = useState("1");
  const [resolveThresholdPercent, setResolveThresholdPercent] = useState("100");
  const [eventPattern, setEventPattern] = useState("");
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [scopeEnabled, setScopeEnabled] = useState(false);
  const [messageTemplate, setMessageTemplate] = useState("");
  const [resolveMessageTemplate, setResolveMessageTemplate] = useState("");
  const [selectedWebhookIds, setSelectedWebhookIds] = useState<string[]>([]);
  const [cooldownSeconds, setCooldownSeconds] = useState("900");

  // Categories, webhooks and resources load as the dialog opens. Mark them
  // loading in that very render, so the dialog waits for them and opens with
  // its final fields instead of filling them in afterwards.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCategories([]);
      setCategoriesLoading(true);
      setWebhooksLoading(true);
      setResourcesCategory(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    catInitRef.current = false;
    setStep(1);
    setName(rule?.name ?? "");
    setCategory(rule?.category ?? "node");
    setType(rule?.type ?? "threshold");
    setSeverity(rule?.severity ?? "warning");
    setMetric(rule?.metric ?? "");
    setMetricTarget(rule?.metricTarget ?? ROOT_DISK_TARGET);
    setOperator(rule?.operator ?? ">");
    setThresholdValue(String(rule?.thresholdValue ?? ""));
    setDurationMinutes(String(rule?.durationSeconds ? Math.round(rule.durationSeconds / 60) : 0));
    setFireThresholdPercent(String(rule?.fireThresholdPercent ?? 100));
    setResolveAfterMinutes(
      String(rule?.resolveAfterSeconds != null ? Math.round(rule.resolveAfterSeconds / 60) : 1)
    );
    setResolveThresholdPercent(String(rule?.resolveThresholdPercent ?? 100));
    setEventPattern(rule?.eventPattern ?? "");
    setResourceIds(rule?.resourceIds ?? []);
    setScopeEnabled(!!rule && rule.resourceIds.length > 0);
    setMessageTemplate(rule?.messageTemplate ?? "");
    setResolveMessageTemplate(rule?.resolveMessageTemplate ?? "");
    setSelectedWebhookIds(rule?.webhookIds ?? []);
    setCooldownSeconds(String(rule?.cooldownSeconds ?? 900));
    setResourceSearch("");
    setWebhookSearch("");
    setResourceFilter("all");
    setWebhookFilter("all");
    api
      .getAlertCategories()
      .then(setCategories)
      .catch(() => {})
      .finally(() => setCategoriesLoading(false));
    api
      .listWebhooks({ limit: 100 })
      .then((r) => setWebhooks(r.data))
      .catch(() => {})
      .finally(() => setWebhooksLoading(false));
  }, [open, rule]);

  const loadAvailableResources = useCallback(async () => {
    const loadToken = ++resourceLoadTokenRef.current;
    setAvailableResources([]);

    try {
      if (category === "hosting_account" || category === "hosting_vm") {
        const accounts = (await api.listHostingConnectors()).filter((account) => account.enabled);
        const resources =
          category === "hosting_account"
            ? accounts.map((account) => ({
                id: account.id,
                label: `${account.name} · ${account.provider}`,
              }))
            : (
                await Promise.all(
                  accounts.map(async (account) => {
                    try {
                      return (await api.listHostingResources(account.id)).map((resource) => ({
                        id: resource.id,
                        label: `${resource.name} · ${account.name}`,
                      }));
                    } catch {
                      return [];
                    }
                  })
                )
              ).flat();
        if (resourceLoadTokenRef.current === loadToken) setAvailableResources(resources);
        return;
      }
      if (category === "node") {
        const response = await api.listNodes({ limit: 100 });
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(
          response.data.map((node) => ({
            id: node.id,
            label: node.displayName || node.hostname,
            diskOptions: [
              { id: ROOT_DISK_TARGET, label: "Root Disk" },
              ...(((node.lastHealthReport?.diskMounts ?? []) as Array<{ mountPoint: string }>)
                .map((mount) => mount.mountPoint)
                .filter((mountPoint) => mountPoint && mountPoint !== ROOT_DISK_TARGET)
                .map((mountPoint) => ({ id: mountPoint, label: mountPoint })) ?? []),
            ],
            gpuOptions: (node.lastHealthReport?.gpuDevices ?? []).map((gpu) => ({
              id: gpu.id,
              label: gpuDeviceLabel(gpu),
              availableMetrics: gpu.availableMetrics,
            })),
          }))
        );
        return;
      }

      if (category === "proxy") {
        const response = await api.listProxyHosts({ limit: 100 });
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(
          (response.data ?? []).map((proxyHost) => ({
            id: proxyHost.id,
            label: Array.isArray(proxyHost.domainNames) ? proxyHost.domainNames[0] : proxyHost.id,
          }))
        );
        return;
      }

      if (category === "pages") {
        const response = await api.listPageProjects({ page: 1, limit: 100 });
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(
          response.data.map((project) => ({
            id: project.id,
            label: project.name,
          }))
        );
        return;
      }

      if (category === "certificate") {
        const response = await api.listSSLCertificates({ limit: 100 });
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(
          (response.data ?? []).map((certificate) => ({
            id: certificate.id,
            label: certificate.name || certificate.id,
          }))
        );
        return;
      }

      if (category === "container") {
        const response = await api.listNodes({ limit: 100, type: "docker" });
        const all: Array<{ id: string; label: string }> = [];
        for (const node of response.data) {
          try {
            const containers = await api.listDockerContainers(node.id);
            for (const container of containers) {
              all.push({
                id: container.name || container.id,
                label: `${container.name} (${node.displayName || node.hostname})`,
              });
            }
          } catch {
            /* skip */
          }
        }
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(all);
        return;
      }

      if (category === "build") {
        const response = await api.listDockerBuildPage({ limit: 100 });
        if (resourceLoadTokenRef.current !== loadToken) return;
        const sources = new Map<string, string>();
        for (const build of response.data) {
          if (!sources.has(build.sourceBindingId)) {
            sources.set(
              build.sourceBindingId,
              `${build.target.name} · ${build.repositoryFullPath}`
            );
          }
        }
        setAvailableResources([...sources].map(([id, label]) => ({ id, label })));
        return;
      }

      if (category === "compose") {
        const projects = await api.listDockerComposeProjects();
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(projects.map((project) => ({ id: project.id, label: project.name })));
        return;
      }

      if (category === "logging") {
        const environments = await api.listLoggingEnvironments();
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(
          environments.map((environment) => ({ id: environment.id, label: environment.name }))
        );
        return;
      }

      if (category === "integration") {
        const [gitlab, cloudflare] = await Promise.all([
          api.listGitLabConnectors().catch(() => []),
          api.listCloudflareConnectors().catch(() => []),
        ]);
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(
          [...gitlab, ...cloudflare].map((connector) => ({
            id: connector.id,
            label: connector.name,
          }))
        );
        return;
      }

      if (category === "managed_storage") {
        // Availability alerts of managed storage are keyed by its storage connection.
        const clusters = await api.listManagedObjectStorages();
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(
          clusters.flatMap((cluster) =>
            cluster.objectStorageConnectionId
              ? [{ id: cluster.objectStorageConnectionId, label: cluster.name }]
              : []
          )
        );
        return;
      }

      if (
        category === "database_postgres" ||
        category === "database_clickhouse" ||
        category === "database_redis"
      ) {
        const databaseType =
          category === "database_postgres"
            ? "postgres"
            : category === "database_clickhouse"
              ? "clickhouse"
              : "redis";
        const response = await api.listDatabases({
          limit: 200,
          type: databaseType,
        });
        if (resourceLoadTokenRef.current !== loadToken) return;
        setAvailableResources(
          response.data.map((database) => ({
            id: database.id,
            label: `${database.name} (${database.host}:${database.port})`,
          }))
        );
      }
    } catch {
      /* ignore */
    } finally {
      if (resourceLoadTokenRef.current === loadToken) setResourcesCategory(category);
    }
  }, [category]);

  useEffect(() => {
    if (!open) return;
    void loadAvailableResources();
  }, [loadAvailableResources, open]);
  const resourcesLoading = open && resourcesCategory !== category;

  const cat = categories.find((c) => c.id === category);
  const firstMetric = cat?.metrics[0];
  const firstEvent = cat?.events[0];
  const selectedEventDef = cat?.events.find((event) => event.id === eventPattern);
  /**
   * Threshold rules and stateful events resolve. One-off events never do, and a recovery state (Node Online) closes
   * quietly, so neither has a resolve message.
   */
  const resolvable =
    type === "threshold" || (!!selectedEventDef?.supportsThreshold && !selectedEventDef.recovery);
  // Examples in the empty template fields, for the metric or event this rule watches.
  const selectedMetricDef = cat?.metrics.find((item) => item.id === metric);
  const templateSubject =
    type === "threshold"
      ? (selectedMetricDef?.label.replace(/\s*\([^)]*\)\s*$/, "") ?? "{{metric.name}}")
      : (selectedEventDef?.label ?? "{{alert.name}}");
  const metricUnit = selectedMetricDef?.unit === "%" ? "%" : "";
  const messagePlaceholder =
    type === "threshold"
      ? `${templateSubject} at {{metric.value}}${metricUnit} on {{resource.name}} (threshold: {{metric.operator}} {{metric.threshold}}${metricUnit})`
      : `${templateSubject} on {{resource.name}}`;
  const resolvePlaceholder =
    type === "threshold"
      ? `${templateSubject} on {{resource.name}} is back to normal at {{metric.value}}${metricUnit} after {{fired.duration}}`
      : "{{resource.name}} is back to normal after {{fired.duration}}";
  const isCertificateExpiryThreshold =
    type === "threshold" && category === "certificate" && metric === CERTIFICATE_EXPIRY_METRIC;
  const applyMetricDefaults = useCallback((metricDef: NonNullable<typeof firstMetric>) => {
    setMetric(metricDef.id);
    setOperator(metricDef.defaultOperator);
    setThresholdValue(String(metricDef.defaultValue));
    setDurationMinutes(String(Math.round((metricDef.defaultDurationSeconds ?? 0) / 60)));
    setFireThresholdPercent("100");
    setResolveAfterMinutes(String(Math.round((metricDef.defaultResolveAfterSeconds ?? 60) / 60)));
    setResolveThresholdPercent("100");
  }, []);

  // Auto-fix type and set defaults when category changes (skip in edit mode on first load)
  useEffect(() => {
    if (!cat) return;
    // Skip the first run in edit mode (categories just loaded, don't overwrite saved values)
    if (isEdit && !catInitRef.current) {
      catInitRef.current = true;
      return;
    }
    // If current type isn't available in new category, switch to available one
    const hasMetrics = cat.metrics.length > 0;
    const hasEvents = cat.events.length > 0;
    let effectiveType = type;
    if (type === "threshold" && !hasMetrics && hasEvents) {
      effectiveType = "event";
      setType("event");
    } else if (type === "event" && !hasEvents && hasMetrics) {
      effectiveType = "threshold";
      setType("threshold");
    }
    // Set defaults for the effective type
    if (effectiveType === "threshold" && firstMetric) {
      applyMetricDefaults(firstMetric);
    }
    if (effectiveType === "event" && firstEvent) {
      setEventPattern(firstEvent.id);
    }
  }, [applyMetricDefaults, cat, firstEvent, firstMetric, isEdit, type]);

  // Reset metric/event defaults when type changes within same category
  useEffect(() => {
    if (isEdit || !cat) return;
    if (type === "threshold" && firstMetric && !cat.metrics.some((m) => m.id === metric)) {
      applyMetricDefaults(firstMetric);
    }
    if (type === "event" && firstEvent && !cat.events.some((event) => event.id === eventPattern)) {
      setEventPattern(firstEvent.id);
    }
  }, [applyMetricDefaults, cat, eventPattern, firstEvent, firstMetric, isEdit, metric, type]);

  const toggleResource = (id: string) =>
    setResourceIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
  const toggleWebhook = (id: string) =>
    setSelectedWebhookIds((prev) =>
      prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]
    );

  const filteredWebhooks = useMemo(
    () =>
      webhookSearch
        ? webhooks.filter((webhook) =>
            webhook.name.toLowerCase().includes(webhookSearch.toLowerCase())
          )
        : webhooks,
    [webhookSearch, webhooks]
  );
  const resourceScopeItems = useMemo(
    () =>
      availableResources.map((resource) => ({
        value: resource.id,
        label: resource.label,
        desc: resource.label,
        group: "",
        hideValue: true,
      })),
    [availableResources]
  );
  const webhookScopeItems = useMemo(
    () =>
      filteredWebhooks.map((webhook) => ({
        value: webhook.id,
        label: webhook.name,
        desc: webhook.name,
        group: "",
        hideValue: true,
        meta: webhook.templatePreset ?? "custom",
      })),
    [filteredWebhooks]
  );

  const canSelectNodeDiskTarget =
    type === "threshold" &&
    category === "node" &&
    metric === "disk" &&
    scopeEnabled &&
    resourceIds.length === 1;
  const isNodeGpuThreshold =
    type === "threshold" && category === "node" && GPU_NODE_METRICS.has(metric);
  const isHostingAccountThreshold = type === "threshold" && category === "hosting_account";
  const [currency, setCurrency] = useState("USD");
  useEffect(() => {
    if (open)
      setCurrency(rule?.category === "hosting_account" ? (rule.metricTarget ?? "USD") : "USD");
  }, [open, rule]);

  const selectedScopedNode = useMemo(
    () => availableResources.find((resource) => resource.id === resourceIds[0]),
    [availableResources, resourceIds]
  );

  const diskTargetOptions = useMemo(
    () => selectedScopedNode?.diskOptions ?? [{ id: ROOT_DISK_TARGET, label: "Root Disk" }],
    [selectedScopedNode]
  );

  const gpuTargetOptions = useMemo(
    () =>
      (selectedScopedNode?.gpuOptions ?? []).filter((option) =>
        supportsGpuAlertMetric(option.availableMetrics, metric)
      ),
    [metric, selectedScopedNode]
  );
  const canSelectNodeGpuTarget =
    isNodeGpuThreshold && scopeEnabled && resourceIds.length === 1 && gpuTargetOptions.length > 0;

  useEffect(() => {
    if (
      canSelectNodeDiskTarget &&
      !diskTargetOptions.some((option) => option.id === metricTarget)
    ) {
      setMetricTarget(ROOT_DISK_TARGET);
    }
  }, [canSelectNodeDiskTarget, diskTargetOptions, metricTarget]);

  useEffect(() => {
    if (canSelectNodeGpuTarget && !gpuTargetOptions.some((option) => option.id === metricTarget)) {
      setMetricTarget(gpuTargetOptions[0].id);
    }
  }, [canSelectNodeGpuTarget, gpuTargetOptions, metricTarget]);

  const canProceedFromStep1 = () => {
    if (!name.trim()) return false;
    if (type === "threshold" && (!metric || !thresholdValue)) return false;
    if (type === "event" && !eventPattern) return false;
    return true;
  };

  const handleSave = async () => {
    if (selectedWebhookIds.length === 0) {
      toast.error("Select at least one webhook");
      return;
    }
    if (scopeEnabled && resourceIds.length === 0) {
      toast.error("Select at least one resource, or disable scope restriction");
      return;
    }
    const cooldownNum = isCertificateExpiryThreshold ? 0 : Number(cooldownSeconds);
    if (Number.isNaN(cooldownNum) || cooldownNum < 0) {
      toast.error("Invalid cooldown value");
      return;
    }
    if (type === "threshold" || (type === "event" && selectedEventDef?.supportsThreshold)) {
      const tv = Number(thresholdValue);
      if (type === "threshold" && Number.isNaN(tv)) {
        toast.error("Invalid threshold value");
        return;
      }
      const dur = isCertificateExpiryThreshold ? 0 : Number(durationMinutes);
      if (Number.isNaN(dur) || dur < 0) {
        toast.error("Invalid duration value");
        return;
      }
      const firePct = isCertificateExpiryThreshold ? 100 : Number(fireThresholdPercent);
      if (Number.isNaN(firePct) || firePct < 0 || firePct > 100) {
        toast.error("Invalid fire threshold value");
        return;
      }
      const res = isCertificateExpiryThreshold ? 0 : Number(resolveAfterMinutes);
      if (Number.isNaN(res) || res < 0) {
        toast.error("Invalid resolve-after value");
        return;
      }
      const resolvePct = isCertificateExpiryThreshold ? 100 : Number(resolveThresholdPercent);
      if (Number.isNaN(resolvePct) || resolvePct < 0 || resolvePct > 100) {
        toast.error("Invalid resolve threshold value");
        return;
      }
    }
    setSaving(true);
    try {
      if (isHostingAccountThreshold && !/^[A-Z]{3}$/.test(currency)) {
        toast.error("Enter a three-letter currency code, such as USD or EUR");
        return;
      }
      const data: any = {
        name: name.trim(),
        category,
        type,
        severity,
        cooldownSeconds: cooldownNum,
        messageTemplate: messageTemplate || undefined,
        // Only alerts that resolve send it; empty stores null, so Gateway's resolve text is used.
        resolveMessageTemplate:
          resolvable && resolveMessageTemplate.trim() ? resolveMessageTemplate : null,
        webhookIds: selectedWebhookIds,
        resourceIds: scopeEnabled ? resourceIds : [],
        enabled: rule?.enabled ?? true,
      };
      if (type === "threshold") {
        data.metric = metric;
        data.metricTarget = isHostingAccountThreshold
          ? currency
          : canSelectNodeDiskTarget || canSelectNodeGpuTarget
            ? metricTarget
            : null;
        data.operator = operator;
        data.thresholdValue = Number(thresholdValue);
        data.durationSeconds = isCertificateExpiryThreshold ? 0 : Number(durationMinutes) * 60;
        data.fireThresholdPercent = isCertificateExpiryThreshold
          ? 100
          : Number(fireThresholdPercent);
        data.resolveAfterSeconds = isCertificateExpiryThreshold
          ? 0
          : Number(resolveAfterMinutes) * 60;
        data.resolveThresholdPercent = isCertificateExpiryThreshold
          ? 100
          : Number(resolveThresholdPercent);
      } else {
        data.eventPattern = eventPattern;
        data.durationSeconds = selectedEventDef?.supportsThreshold
          ? Number(durationMinutes) * 60
          : 0;
        data.fireThresholdPercent = selectedEventDef?.supportsThreshold
          ? Number(fireThresholdPercent)
          : 100;
        data.resolveAfterSeconds = selectedEventDef?.supportsThreshold
          ? Number(resolveAfterMinutes) * 60
          : 0;
        data.resolveThresholdPercent = selectedEventDef?.supportsThreshold
          ? Number(resolveThresholdPercent)
          : 100;
      }
      if (isEdit) {
        await api.updateAlertRule(rule!.id, data);
        toast.success("Alert updated");
      } else {
        await api.createAlertRule(data);
        toast.success("Alert created");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Alert" : "New Alert"}</DialogTitle>
          <DialogDescription>
            Step {step} of 3 — {STEP_LABELS[step - 1]}
          </DialogDescription>
        </DialogHeader>

        <AnimatedHeight>
          <ContentLoading loading={categoriesLoading || webhooksLoading || resourcesLoading} />
          <AnimatePresence initial={false} mode="wait">
            {/* ── Step 1: Configuration ── */}
            {step === 1 && (
              <motion.div key="step-1" {...STEP_ANIMATION} className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Name</label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="CPU High Alert"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Severity</label>
                    <Select value={severity} onValueChange={setSeverity}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="info">Info</SelectItem>
                        <SelectItem value="warning">Warning</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Category</label>
                    <Select
                      value={category}
                      onValueChange={(v) => {
                        setCategory(v);
                        setMetric("");
                        setEventPattern("");
                      }}
                      disabled={categories.length === 0}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent
                        className="max-h-[min(24rem,var(--radix-select-content-available-height))]"
                        overlayScrollControls
                      >
                        {categories.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Alert Type</label>
                    <Select value={type} onValueChange={setType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {cat && cat.metrics.length > 0 && (
                          <SelectItem value="threshold">Threshold</SelectItem>
                        )}
                        {cat && cat.events.length > 0 && (
                          <SelectItem value="event">Event</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {type === "threshold" && cat && cat.metrics.length > 1 && (
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Metric</label>
                      <Select
                        value={metric}
                        onValueChange={(value) => {
                          const nextMetric = cat.metrics.find((m) => m.id === value);
                          if (nextMetric) applyMetricDefaults(nextMetric);
                          else setMetric(value);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {cat.metrics.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Operator</label>
                      <Select value={operator} onValueChange={setOperator}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value=">">&gt;</SelectItem>
                          <SelectItem value=">=">&gt;=</SelectItem>
                          <SelectItem value="<">&lt;</SelectItem>
                          <SelectItem value="<=">&lt;=</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Value</label>
                      <Input
                        type="number"
                        value={thresholdValue}
                        onChange={(e) => setThresholdValue(e.target.value)}
                      />
                    </div>
                  </div>
                )}
                {type === "threshold" && cat && cat.metrics.length === 1 && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Operator</label>
                      <Select value={operator} onValueChange={setOperator}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value=">">&gt;</SelectItem>
                          <SelectItem value=">=">&gt;=</SelectItem>
                          <SelectItem value="<">&lt;</SelectItem>
                          <SelectItem value="<=">&lt;=</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{cat.metrics[0].label}</label>
                      <Input
                        type="number"
                        value={thresholdValue}
                        onChange={(e) => setThresholdValue(e.target.value)}
                      />
                    </div>
                  </div>
                )}
                {isHostingAccountThreshold && (
                  <div className="space-y-1.5">
                    <label htmlFor="hosting-alert-currency" className="text-sm font-medium">
                      Currency
                    </label>
                    <Input
                      id="hosting-alert-currency"
                      value={currency}
                      maxLength={3}
                      placeholder="USD"
                      onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                    />
                    <p className="text-sm text-muted-foreground">
                      Only accounts reporting this currency are evaluated. Unavailable or stale
                      balances are ignored; currencies are not converted.
                    </p>
                  </div>
                )}
                {type === "threshold" && !isCertificateExpiryThreshold && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Fire window (minutes)</label>
                      <Input
                        type="number"
                        min="0"
                        value={durationMinutes}
                        onChange={(e) => setDurationMinutes(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Observation window used for firing. 0 = immediate.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Fire threshold (%)</label>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        value={fireThresholdPercent}
                        onChange={(e) => setFireThresholdPercent(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Alert fires when breached probes reach this share of the fire window.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Resolve window (minutes)</label>
                      <Input
                        type="number"
                        min="0"
                        value={resolveAfterMinutes}
                        onChange={(e) => setResolveAfterMinutes(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Observation window used for resolving.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Resolve threshold (%)</label>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        value={resolveThresholdPercent}
                        onChange={(e) => setResolveThresholdPercent(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Alert resolves when clear probes reach this share of the resolve window.
                      </p>
                    </div>
                    <div className="space-y-1.5 col-span-2">
                      <label className="text-sm font-medium">Cooldown (seconds)</label>
                      <Input
                        type="number"
                        value={cooldownSeconds}
                        onChange={(e) => setCooldownSeconds(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Won't re-fire within this period.
                      </p>
                    </div>
                  </div>
                )}

                {type === "event" &&
                  cat &&
                  (selectedEventDef?.supportsThreshold ? (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5 col-span-2">
                        <label className="text-sm font-medium">Event</label>
                        <Select value={eventPattern} onValueChange={setEventPattern}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {cat.events.map((e) => (
                              <SelectItem key={e.id} value={e.id}>
                                {e.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Fire window (minutes)</label>
                        <Input
                          type="number"
                          min="0"
                          value={durationMinutes}
                          onChange={(e) => setDurationMinutes(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Observation window used to confirm this stateful event.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Fire threshold (%)</label>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          value={fireThresholdPercent}
                          onChange={(e) => setFireThresholdPercent(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Alert fires when the event state is observed this often in the fire
                          window.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Resolve window (minutes)</label>
                        <Input
                          type="number"
                          min="0"
                          value={resolveAfterMinutes}
                          onChange={(e) => setResolveAfterMinutes(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Observation window used to confirm the state has cleared.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Resolve threshold (%)</label>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          value={resolveThresholdPercent}
                          onChange={(e) => setResolveThresholdPercent(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Alert resolves when clear observations reach this share of the resolve
                          window.
                        </p>
                      </div>
                      <div className="space-y-1.5 col-span-2">
                        <label className="text-sm font-medium">Cooldown (seconds)</label>
                        <Input
                          type="number"
                          value={cooldownSeconds}
                          onChange={(e) => setCooldownSeconds(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Won't re-fire within this period.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Event</label>
                        <Select value={eventPattern} onValueChange={setEventPattern}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {cat.events.map((e) => (
                              <SelectItem key={e.id} value={e.id}>
                                {e.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Cooldown (seconds)</label>
                        <Input
                          type="number"
                          value={cooldownSeconds}
                          onChange={(e) => setCooldownSeconds(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Won't re-fire within this period.
                        </p>
                      </div>
                    </div>
                  ))}
              </motion.div>
            )}

            {/* ── Step 2: Scope & Webhooks ── */}
            {step === 2 && (
              <motion.div key="step-2" {...STEP_ANIMATION} className="space-y-5">
                {/* Scope */}
                <div className="space-y-3">
                  <CheckboxCard
                    label={`Limit to specific ${cat?.label?.toLowerCase() ?? category}s`}
                    description={
                      scopeEnabled
                        ? "Only selected resources will trigger this alert."
                        : `Alert applies to all ${cat?.label?.toLowerCase() ?? category}s.`
                    }
                    checked={scopeEnabled}
                    onCheckedChange={(v) => {
                      setScopeEnabled(v);
                      if (!v) setResourceIds([]);
                    }}
                  />
                  <div
                    className={`border border-border transition-opacity ${scopeEnabled ? "" : "opacity-40 pointer-events-none"}`}
                  >
                    <ScopeSearchFilter
                      search={resourceSearch}
                      onSearchChange={setResourceSearch}
                      filter={resourceFilter}
                      onFilterChange={setResourceFilter}
                      placeholder="Search resources..."
                      disabled={!scopeEnabled}
                    />
                    <div>
                      {availableResources.length === 0 ? (
                        <p className="p-3 text-sm text-muted-foreground">
                          {resourcesLoading ? "Loading resources…" : "No resources found."}
                        </p>
                      ) : (
                        <ScopeList
                          scopes={resourceScopeItems}
                          search={resourceSearch}
                          selectionFilter={resourceFilter}
                          selected={resourceIds}
                          onToggle={toggleResource}
                          readOnly={!scopeEnabled}
                          viewportClassName="max-sm:max-h-[30vh] max-sm:overflow-y-auto"
                        />
                      )}
                    </div>
                    <div className="border-t border-border px-3 py-1.5">
                      <p className="text-xs text-muted-foreground">
                        {scopeEnabled ? `${resourceIds.length} selected` : "All resources"}
                      </p>
                    </div>
                  </div>
                </div>

                {type === "threshold" && category === "node" && metric === "disk" && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Disk To Watch</label>
                    <Select
                      value={metricTarget}
                      onValueChange={setMetricTarget}
                      disabled={!canSelectNodeDiskTarget}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {diskTargetOptions.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {canSelectNodeDiskTarget
                        ? "Choose which disk mount on the selected node should trigger this alert."
                        : "Select exactly one node above to watch a specific disk. Otherwise the alert evaluates all disks."}
                    </p>
                  </div>
                )}

                {isNodeGpuThreshold && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">GPU To Watch</label>
                    <Select
                      value={canSelectNodeGpuTarget ? metricTarget : undefined}
                      onValueChange={setMetricTarget}
                      disabled={!canSelectNodeGpuTarget}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a GPU" />
                      </SelectTrigger>
                      <SelectContent>
                        {gpuTargetOptions.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {canSelectNodeGpuTarget
                        ? "Choose a physical GPU on the selected node. The alert uses only metrics reported by that GPU."
                        : scopeEnabled && resourceIds.length === 1
                          ? "This node has no GPU that reports the selected metric."
                          : "Select exactly one node above to watch a specific GPU. Otherwise the alert evaluates every GPU that reports this metric."}
                    </p>
                  </div>
                )}

                {/* Webhooks */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Send to Webhooks</label>
                  {webhooks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No webhooks configured. Create a webhook first.
                    </p>
                  ) : (
                    <div className="border border-border">
                      <ScopeSearchFilter
                        search={webhookSearch}
                        onSearchChange={setWebhookSearch}
                        filter={webhookFilter}
                        onFilterChange={setWebhookFilter}
                        placeholder="Search webhooks..."
                      />
                      <div>
                        <ScopeList
                          scopes={webhookScopeItems}
                          search={webhookSearch}
                          selectionFilter={webhookFilter}
                          selected={selectedWebhookIds}
                          onToggle={toggleWebhook}
                          viewportClassName="max-sm:max-h-[25vh] max-sm:overflow-y-auto"
                        />
                      </div>
                      <div className="border-t border-border px-3 py-1.5">
                        <p className="text-xs text-muted-foreground">
                          {selectedWebhookIds.length} selected
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {/* ── Step 3: Message ── */}
            {step === 3 && (
              <motion.div key="step-3" {...STEP_ANIMATION} className="space-y-5">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Message Template</label>
                  <TemplateEditor
                    ref={editorRef}
                    value={messageTemplate}
                    onChange={setMessageTemplate}
                    minHeight={300}
                    placeholder={messagePlaceholder}
                  />
                  <TemplateCheatsheetLink
                    variables={[
                      ...(cat?.variables ?? []),
                      ...UNIVERSAL_VARIABLES.filter(
                        (u) => !(cat?.variables ?? []).some((v) => v.name === u.name)
                      ),
                    ]}
                  />
                </div>
                {resolvable && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Resolve Message Template</label>
                    <TemplateEditor
                      value={resolveMessageTemplate}
                      onChange={setResolveMessageTemplate}
                      minHeight={120}
                      placeholder={resolvePlaceholder}
                    />
                    <p className="text-xs text-muted-foreground">
                      Sent when the alert resolves. Leave empty to use Opfield's text for this
                      alert, such as "Proxy host example.com is back online after 13m 2s."
                    </p>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </AnimatedHeight>

        <DialogFooter className="shrink-0">
          {step === 1 && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => setStep(2)} disabled={!canProceedFromStep1()}>
                Next <ArrowRight />
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft /> Back
              </Button>
              <Button onClick={() => setStep(3)} disabled={selectedWebhookIds.length === 0}>
                Next <ArrowRight />
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              <Button variant="outline" onClick={() => setStep(2)}>
                <ArrowLeft /> Back
              </Button>
              <Button onClick={handleSave} pending={saving}>
                {isEdit ? "Update" : "Create"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
