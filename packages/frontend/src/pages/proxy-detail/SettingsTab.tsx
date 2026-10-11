import {
  FileCode,
  HeartPulse,
  ListPlus,
  Lock,
  Minus,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Replace,
  Save,
  ShieldCheck,
} from "lucide-react";
import { Combobox } from "@/components/common/Combobox";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { ProxyUpstreamPanel } from "@/components/proxy/ProxyUpstreamEditor";
import { REDIRECT_STATUS_OPTIONS } from "@/components/proxy/redirect-status-options";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { supportsPagesRouteTemplate } from "@/lib/proxy-template-capabilities";
import { cn } from "@/lib/utils";
import type {
  AccessList,
  CustomHeader,
  NginxTemplate,
  ProxyHost,
  RewriteRule,
  SSLCertificate,
} from "@/types";
import { AdditionalRoutesPanel } from "./AdditionalRoutes";
import { AdditionalSecureLinkBindings } from "./AdditionalSecureLinkBindings";

const tableInputClass =
  "h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

export interface SettingsTabProps {
  host: ProxyHost;
  onHostUpdated: (host: ProxyHost) => void;
  onToggle: (field: string, value: boolean) => void;
  customHeaders: CustomHeader[];
  setCustomHeaders: (v: CustomHeader[]) => void;
  customRewrites: RewriteRule[];
  setCustomRewrites: (v: RewriteRule[]) => void;
  onSaveHeaders: () => void;
  onSaveRewrites: () => void;
  isSavingCustom: boolean;
  accessListId: string;
  accessLists: AccessList[];
  onAccessListChange: (v: string) => void;
  sslCerts: SSLCertificate[];
  sslEnabled: boolean;
  setSslEnabled: (v: boolean) => void;
  sslForced: boolean;
  setSslForced: (v: boolean) => void;
  http2Support: boolean;
  setHttp2Support: (v: boolean) => void;
  sslCertificateId: string;
  setSslCertificateId: (v: string) => void;
  onSaveSsl: () => void;
  isSavingSsl: boolean;
  hasSslSettingsChanged: boolean;
  nginxTemplates: NginxTemplate[];
  nginxTemplateId: string;
  onNginxTemplateChange: (v: string) => void;
  selectedTemplate: NginxTemplate | null;
  templateVariables: Record<string, string | number | boolean>;
  onTemplateVariableChange: (name: string, value: string | number | boolean) => void;
  templateRedirectUrl: string;
  setTemplateRedirectUrl: (value: string) => void;
  templateRedirectStatusCode: number;
  setTemplateRedirectStatusCode: (value: number) => void;
  onSaveTemplateSettings: () => void;
  isSavingTemplate: boolean;
  hasTemplateSettingsChanged: boolean;
  canManage: boolean;
  /** Why removing Secure Link bindings is disabled (the route's app environment is isolated or shut down). */
  secureLinkRemovalDisabledReason?: string | null;
  hasHeadersChanged: boolean;
  hasRewritesChanged: boolean;
  healthCheckEnabled: boolean;
  setHealthCheckEnabled: (v: boolean) => void;
  healthCheckUrl: string;
  setHealthCheckUrl: (v: string) => void;
  healthCheckExpectedStatus: number | null;
  setHealthCheckExpectedStatus: (v: number | null) => void;
  healthCheckExpectedBody: string;
  setHealthCheckExpectedBody: (v: string) => void;
  healthCheckBodyMatchMode: "includes" | "exact" | "starts_with" | "ends_with";
  setHealthCheckBodyMatchMode: (v: "includes" | "exact" | "starts_with" | "ends_with") => void;
  healthCheckSlowThreshold: number;
  setHealthCheckSlowThreshold: (v: number) => void;
  onSaveHealthCheck: () => void;
  isSavingHealthCheck: boolean;
  hasHealthCheckSettingsChanged: boolean;
  canResyncTls: boolean;
  isTlsResyncing: boolean;
  onTlsResync: () => void;
  /** Access lists, certificates or templates for the selects are still loading. */
  optionsLoading?: boolean;
}

export function SettingsTab({
  host,
  onHostUpdated,
  onToggle,
  customHeaders,
  setCustomHeaders,
  customRewrites,
  setCustomRewrites,
  onSaveHeaders,
  onSaveRewrites,
  isSavingCustom,
  accessListId,
  accessLists,
  onAccessListChange,
  sslCerts,
  sslEnabled,
  setSslEnabled,
  sslForced,
  setSslForced,
  http2Support,
  setHttp2Support,
  sslCertificateId,
  setSslCertificateId,
  onSaveSsl,
  isSavingSsl,
  hasSslSettingsChanged,
  nginxTemplates,
  nginxTemplateId,
  onNginxTemplateChange,
  selectedTemplate,
  templateVariables,
  onTemplateVariableChange,
  templateRedirectUrl,
  setTemplateRedirectUrl,
  templateRedirectStatusCode,
  setTemplateRedirectStatusCode,
  onSaveTemplateSettings,
  isSavingTemplate,
  hasTemplateSettingsChanged,
  canManage,
  secureLinkRemovalDisabledReason = null,
  hasHeadersChanged,
  hasRewritesChanged,
  healthCheckEnabled,
  setHealthCheckEnabled,
  healthCheckUrl,
  setHealthCheckUrl,
  healthCheckExpectedStatus,
  setHealthCheckExpectedStatus,
  healthCheckExpectedBody,
  setHealthCheckExpectedBody,
  healthCheckBodyMatchMode,
  setHealthCheckBodyMatchMode,
  healthCheckSlowThreshold,
  setHealthCheckSlowThreshold,
  onSaveHealthCheck,
  isSavingHealthCheck,
  hasHealthCheckSettingsChanged,
  canResyncTls,
  isTlsResyncing,
  onTlsResync,
  optionsLoading = false,
}: SettingsTabProps) {
  useContentLoading(optionsLoading);
  const accessListOptions = [
    { value: "", label: "None" },
    ...accessLists.map((accessList) => ({ value: accessList.id, label: accessList.name })),
  ];
  const templateVariableDefinitions = selectedTemplate?.variables ?? [];
  const cacheEnabled = templateVariables.cacheEnabled === true;
  const rateLimitMode =
    templateVariables.rateLimitMode === "custom" || templateVariables.rateLimitMode === "disabled"
      ? templateVariables.rateLimitMode
      : "inherit";
  const showCustomHeaders = canManage || customHeaders.length > 0;
  const showCustomRewrites = canManage || customRewrites.length > 0;
  const compatibleTemplates =
    host.upstreamKind === "pages"
      ? nginxTemplates.filter((template) => supportsPagesRouteTemplate(template.content))
      : nginxTemplates;
  const tlsDistributionProblem =
    host.sslEnabled &&
    host.tlsDistribution &&
    (host.tlsDistribution.status !== "ready" ||
      host.tlsDistribution.readyReplicaCount < host.tlsDistribution.replicaCount ||
      Boolean(host.tlsDistribution.error))
      ? host.tlsDistribution
      : null;

  const renderTemplateValue = (variable: NonNullable<NginxTemplate["variables"]>[number]) => {
    const disabledByDependency =
      (variable.name === "cacheMaxAge" && !cacheEnabled) ||
      (["rateLimitRPS", "rateLimitBurst", "connectionsPerIp"].includes(variable.name) &&
        rateLimitMode !== "custom");

    if (variable.name === "rateLimitMode") {
      return (
        <Select
          value={rateLimitMode}
          onValueChange={(value) => onTemplateVariableChange(variable.name, value)}
          disabled={!canManage}
        >
          <SelectTrigger className={cn(tableInputClass, "font-sans")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="font-sans">
            <SelectItem value="inherit">Opfield default (1000 / 3000 / 1000)</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (variable.name === "cacheEnabled") {
      return (
        <Select
          value={templateVariables[variable.name] === true ? "enabled" : "disabled"}
          onValueChange={(value) => onTemplateVariableChange(variable.name, value === "enabled")}
          disabled={!canManage}
        >
          <SelectTrigger className={cn(tableInputClass, "font-sans")} aria-label="Cache enabled">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="font-sans">
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (variable.type === "boolean") {
      return (
        <div className="flex h-9 items-center justify-end px-3">
          <Switch
            checked={templateVariables[variable.name] === true}
            onChange={(value) => onTemplateVariableChange(variable.name, value)}
            disabled={!canManage}
          />
        </div>
      );
    }
    if (variable.type === "number") {
      return (
        <NumericInput
          value={Number(templateVariables[variable.name] ?? variable.default ?? 0)}
          onChange={(value) => onTemplateVariableChange(variable.name, value)}
          min={1}
          className={tableInputClass}
          disabled={!canManage || disabledByDependency}
        />
      );
    }
    return (
      <Input
        value={String(templateVariables[variable.name] ?? variable.default ?? "")}
        onChange={(event) => onTemplateVariableChange(variable.name, event.target.value)}
        placeholder={variable.default === undefined ? "" : String(variable.default)}
        className={tableInputClass}
        disabled={!canManage || disabledByDependency}
      />
    );
  };

  return (
    <div className="space-y-4">
      {tlsDistributionProblem && (
        <PanelShell
          icon={<Network className="h-4 w-4" />}
          title={
            <div className="flex flex-wrap items-center gap-2">
              <span>TLS distribution</span>
              <Badge
                size="inline"
                variant={
                  tlsDistributionProblem.status === "ready"
                    ? "success"
                    : tlsDistributionProblem.status === "failed"
                      ? "destructive"
                      : "warning"
                }
              >
                {tlsDistributionProblem.status.replaceAll("_", " ")}
              </Badge>
            </div>
          }
          description={
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <span>
                {tlsDistributionProblem.readyReplicaCount}/{tlsDistributionProblem.replicaCount}{" "}
                replicas ready
              </span>
              {tlsDistributionProblem.lastVerifiedAt && (
                <span>
                  Last verified <RelativeTime value={tlsDistributionProblem.lastVerifiedAt} />
                </span>
              )}
              {tlsDistributionProblem.error && (
                <span className="break-words">{tlsDistributionProblem.error}</span>
              )}
            </span>
          }
          actions={
            canResyncTls ? (
              <Button
                variant="outline"
                onClick={onTlsResync}
                pending={isTlsResyncing}
                aria-label={`Retry TLS sync for ${host.domainNames[0] || "proxy host"}`}
              >
                <RefreshCw />
                Retry TLS Sync
              </Button>
            ) : null
          }
          wrapHeader
        />
      )}

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 32rem), 1fr))" }}
      >
        {host.type === "proxy" && host.upstreamKind !== "pages" && (
          <PanelShell
            icon={<Radio className="h-4 w-4" />}
            title="WebSocket Support"
            description="Enable WebSocket proxying"
          >
            <SettingsControlRow
              title="Enabled"
              description="Allow WebSocket protocol upgrades"
              help="Forwards Upgrade and Connection headers so long-lived WebSocket connections can pass through this Route. Leave disabled for ordinary HTTP-only upstreams."
            >
              <Switch
                checked={host.websocketSupport}
                onChange={(value) => onToggle("websocketSupport", value)}
                disabled={!canManage}
              />
            </SettingsControlRow>
          </PanelShell>
        )}
        <PanelShell
          icon={<ShieldCheck className="h-4 w-4" />}
          title="Access List"
          description="Restrict access via IP rules or basic authentication"
          className="overflow-visible"
        >
          <SettingsControlRow
            title="Policy"
            description="Access policy applied to this proxy host"
            help="Applies the selected reusable Access List before traffic reaches the upstream. A policy may restrict client IP addresses, require Basic Authentication, or require both."
          >
            <Combobox
              value={accessListId}
              options={accessListOptions}
              onValueChange={onAccessListChange}
              placeholder="None"
              searchPlaceholder="Search access lists..."
              emptyMessage="No access lists found."
              disabled={!canManage}
              ariaLabel="Access List policy"
              className="w-full"
            />
          </SettingsControlRow>
        </PanelShell>
      </div>

      {host.type === "proxy" && (
        <ProxyUpstreamPanel host={host} canManage={canManage} onUpdated={onHostUpdated} />
      )}

      {host.type === "proxy" && (
        <AdditionalRoutesPanel
          host={host}
          canManage={canManage}
          selectedTemplate={selectedTemplate}
        />
      )}

      {host.type === "proxy" && !host.rawConfigEnabled ? (
        <AdditionalSecureLinkBindings
          hostId={host.id}
          canManage={canManage}
          removeDisabledReason={secureLinkRemovalDisabledReason}
        />
      ) : null}

      <PanelShell
        icon={<FileCode className="h-4 w-4" />}
        title="Config Template"
        description="Select a template and configure its variables"
        dirty={hasTemplateSettingsChanged}
        actions={
          canManage ? (
            <Button
              onClick={onSaveTemplateSettings}
              disabled={!hasTemplateSettingsChanged}
              pending={isSavingTemplate}
            >
              <Save />
              Save
            </Button>
          ) : null
        }
        wrapHeader
      >
        <SettingsControlRow
          title="Template"
          description="Nginx configuration used for this host"
          help="Selects the Nginx template rendered for this Route. Template variables below alter supported behavior without replacing the complete generated configuration."
        >
          <Select
            value={nginxTemplateId || "__none__"}
            onValueChange={(value) => onNginxTemplateChange(value === "__none__" ? "" : value)}
            disabled={!canManage}
          >
            <SelectTrigger className="w-full font-sans sm:w-72">
              <SelectValue placeholder="Default template" />
            </SelectTrigger>
            <SelectContent className="font-sans">
              <SelectItem value="__none__">Default template</SelectItem>
              {compatibleTemplates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsControlRow>

        {host.type === "redirect" ? (
          <>
            <SettingsControlRow
              title="Redirect URL"
              description="Target URL for incoming requests"
              help="The absolute destination sent to clients in the HTTP Location header. Preserve any required path or query parameters explicitly in this value."
            >
              <Input
                value={templateRedirectUrl}
                onChange={(event) => setTemplateRedirectUrl(event.target.value)}
                placeholder="https://example.com"
                className="w-full sm:w-72"
                disabled={!canManage}
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Status Code"
              description="HTTP redirect response status"
              help="301 and 308 are cacheable permanent redirects. 307 and 308 preserve the original request method and body instead of converting it to GET."
            >
              <Select
                value={String(templateRedirectStatusCode)}
                onValueChange={(value) => setTemplateRedirectStatusCode(Number(value))}
                disabled={!canManage}
              >
                <SelectTrigger
                  className="w-full font-sans sm:w-72"
                  aria-label="Redirect status code"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="font-sans">
                  {REDIRECT_STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsControlRow>
          </>
        ) : null}

        {templateVariableDefinitions.length > 0 ? (
          <div className="overflow-x-auto">
            <div className="min-w-[680px]">
              <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,16rem)] border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <div className="px-3 py-2">Variable</div>
                <div className="border-l border-border px-3 py-2">Description</div>
                <div className="border-l border-border px-3 py-2">Value</div>
              </div>
              {templateVariableDefinitions.map((variable) => (
                <div
                  key={variable.name}
                  className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,16rem)] border-b border-border last:border-b-0"
                >
                  <div className="flex min-w-0 items-center px-3 py-2">
                    <p className="truncate text-sm font-medium">{variable.name}</p>
                  </div>
                  <div className="flex min-w-0 items-center border-l border-border px-3 py-2">
                    <p className="text-xs text-muted-foreground">
                      {variable.description || "No description"}
                    </p>
                  </div>
                  <div className="border-l border-border">{renderTemplateValue(variable)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </PanelShell>

      <PanelShell
        icon={<Lock className="h-4 w-4" />}
        title="SSL"
        description="HTTPS termination and transport settings"
        dirty={hasSslSettingsChanged}
        actions={
          canManage ? (
            <Button onClick={onSaveSsl} disabled={!hasSslSettingsChanged} pending={isSavingSsl}>
              <Save />
              Save
            </Button>
          ) : null
        }
        wrapHeader
      >
        <SettingsControlRow
          title="Enabled"
          description="Serve this host over HTTPS"
          help="Enables TLS termination for this Route. A valid certificate must cover every configured domain name before clients can connect without certificate warnings."
        >
          <Switch checked={sslEnabled} onChange={setSslEnabled} disabled={!canManage} />
        </SettingsControlRow>
        <SettingsControlRow
          title="Force HTTPS"
          description="Redirect HTTP requests to HTTPS"
          help="Redirects plaintext HTTP traffic to the equivalent HTTPS URL. Enable only after certificate distribution is ready on every proxy replica."
        >
          <Switch
            checked={sslForced}
            onChange={setSslForced}
            disabled={!canManage || !sslEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="HTTP/2"
          description="Enable HTTP/2 protocol support"
          help="Allows compatible HTTPS clients to multiplex requests over one connection. The upstream protocol is configured separately and does not have to use HTTP/2."
        >
          <Switch
            checked={http2Support}
            onChange={setHttp2Support}
            disabled={!canManage || !sslEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="SSL Certificate"
          description="Certificate used for HTTPS"
          help="Selects the certificate distributed to proxy replicas for TLS termination. Its Subject Alternative Names must cover the Route domains."
        >
          <Combobox
            value={sslCertificateId}
            options={[
              { value: "", label: "None" },
              ...sslCerts.map((certificate) => ({
                value: certificate.id,
                label: `${certificate.name} (${certificate.type})`,
                keywords: certificate.domainNames?.join(" ") ?? "",
              })),
            ]}
            onValueChange={setSslCertificateId}
            placeholder="Select certificate..."
            searchPlaceholder="Search certificates..."
            emptyMessage="No matching certificates."
            ariaLabel="SSL Certificate"
            inputClassName="font-sans"
            contentClassName="font-sans sm:w-72"
            className="sm:w-72"
            disabled={!canManage}
          />
        </SettingsControlRow>
      </PanelShell>

      {host.type !== "404" && (
        <PanelShell
          icon={<HeartPulse className="h-4 w-4" />}
          title="Health Check"
          description="Periodic upstream availability monitoring"
          dirty={hasHealthCheckSettingsChanged}
          actions={
            canManage ? (
              <Button
                onClick={onSaveHealthCheck}
                disabled={!hasHealthCheckSettingsChanged}
                pending={isSavingHealthCheck}
              >
                <Save />
                Save
              </Button>
            ) : null
          }
          wrapHeader
        >
          <SettingsControlRow
            title="Enabled"
            description="Run periodic health probes"
            help="Opfield periodically requests the upstream through this Route and records availability and latency independently from client traffic."
          >
            <Switch
              checked={healthCheckEnabled}
              onChange={setHealthCheckEnabled}
              disabled={!canManage}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="URL Path"
            description="Path requested from the upstream"
            help="Path appended to the Route host for each health probe. Prefer a lightweight endpoint that verifies essential application dependencies."
          >
            <Input
              value={healthCheckUrl}
              onChange={(event) => setHealthCheckUrl(event.target.value)}
              placeholder="/"
              className="w-full sm:w-72"
              disabled={!canManage || !healthCheckEnabled}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Expected Status"
            description="Leave empty to accept any successful 2xx response"
            help="When set, only this exact HTTP status counts as healthy. Leave empty when any response in the 200–299 range is acceptable."
          >
            <Input
              type="number"
              value={healthCheckExpectedStatus ?? ""}
              onChange={(event) =>
                setHealthCheckExpectedStatus(event.target.value ? Number(event.target.value) : null)
              }
              placeholder="Any 2xx"
              className="w-full sm:w-72"
              disabled={!canManage || !healthCheckEnabled}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Slow Threshold"
            description="Mark degraded above this multiple of the 3-hour average; 0 disables it"
            help="Compares the latest response time with the rolling three-hour baseline. For example, 3 marks the Route degraded when it becomes three times slower than normal."
          >
            <NumericInput
              value={healthCheckSlowThreshold}
              onChange={setHealthCheckSlowThreshold}
              min={0}
              max={100}
              className="w-full sm:w-72"
              disabled={!canManage || !healthCheckEnabled}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Expected Body"
            description="Optional response body assertion"
            help="Optionally verifies response content after the status check succeeds. This can detect a healthy proxy returning the wrong application or maintenance page."
            controlsClassName="sm:min-w-[24rem] sm:max-w-[32rem]"
          >
            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Select
                value={healthCheckBodyMatchMode}
                onValueChange={(value) =>
                  setHealthCheckBodyMatchMode(
                    value as "includes" | "exact" | "starts_with" | "ends_with"
                  )
                }
                disabled={!canManage || !healthCheckEnabled}
              >
                <SelectTrigger className="font-sans" aria-label="Expected body match mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="font-sans">
                  <SelectItem value="includes">Includes</SelectItem>
                  <SelectItem value="exact">Exact Match</SelectItem>
                  <SelectItem value="starts_with">Starts With</SelectItem>
                  <SelectItem value="ends_with">Ends With</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={healthCheckExpectedBody}
                onChange={(event) => setHealthCheckExpectedBody(event.target.value)}
                placeholder="Optional"
                aria-label="Expected body value"
                disabled={!canManage || !healthCheckEnabled}
              />
            </div>
          </SettingsControlRow>
        </PanelShell>
      )}

      {showCustomHeaders && (
        <PanelShell
          icon={<ListPlus className="h-4 w-4" />}
          title="Custom Headers"
          description="Headers added to proxied requests"
          dirty={hasHeadersChanged}
          actions={
            canManage ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add custom header"
                  title="Add custom header"
                  onClick={() => setCustomHeaders([...customHeaders, { name: "", value: "" }])}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
                <Button
                  onClick={onSaveHeaders}
                  disabled={!hasHeadersChanged}
                  pending={isSavingCustom}
                >
                  <Save />
                  Save
                </Button>
              </div>
            ) : null
          }
          wrapHeader
        >
          {customHeaders.length > 0 ? (
            <div className="overflow-x-auto">
              <div className="min-w-[560px]">
                <div className="grid grid-cols-[1fr_1fr_2.25rem] border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <div className="px-3 py-2">Header</div>
                  <div className="border-l border-border px-3 py-2">Value</div>
                  <div className="border-l border-border" />
                </div>
                {customHeaders.map((header, index) => (
                  <div
                    key={`header-${index}`}
                    className="grid grid-cols-[1fr_1fr_2.25rem] border-b border-border last:border-b-0"
                  >
                    <Input
                      placeholder="Header name"
                      value={header.name}
                      disabled={!canManage}
                      className={tableInputClass}
                      onChange={(event) => {
                        const next = [...customHeaders];
                        next[index] = { ...next[index], name: event.target.value };
                        setCustomHeaders(next);
                      }}
                    />
                    <Input
                      placeholder="Value"
                      value={header.value}
                      disabled={!canManage}
                      className={cn(tableInputClass, "border-l border-border")}
                      onChange={(event) => {
                        const next = [...customHeaders];
                        next[index] = { ...next[index], value: event.target.value };
                        setCustomHeaders(next);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-none border-l border-border"
                      aria-label={`Remove custom header ${index + 1}`}
                      onClick={() => setCustomHeaders(customHeaders.filter((_, i) => i !== index))}
                      disabled={!canManage}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState message="No custom headers" embedded />
          )}
        </PanelShell>
      )}

      {showCustomRewrites && (
        <PanelShell
          icon={<Replace className="h-4 w-4" />}
          title="URL Rewrites"
          description="Rewrite request paths before proxying"
          dirty={hasRewritesChanged}
          actions={
            canManage ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add URL rewrite"
                  title="Add URL rewrite"
                  onClick={() =>
                    setCustomRewrites([
                      ...customRewrites,
                      { source: "", destination: "", type: "permanent" },
                    ])
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
                <Button
                  onClick={onSaveRewrites}
                  disabled={!hasRewritesChanged}
                  pending={isSavingCustom}
                >
                  <Save />
                  Save
                </Button>
              </div>
            ) : null
          }
          wrapHeader
        >
          {customRewrites.length > 0 ? (
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className="grid grid-cols-[1fr_1fr_11rem_2.25rem] border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <div className="px-3 py-2">Source</div>
                  <div className="border-l border-border px-3 py-2">Destination</div>
                  <div className="border-l border-border px-3 py-2">Type</div>
                  <div className="border-l border-border" />
                </div>
                {customRewrites.map((rule, index) => (
                  <div
                    key={`rewrite-${index}`}
                    className="grid grid-cols-[1fr_1fr_11rem_2.25rem] border-b border-border last:border-b-0"
                  >
                    <Input
                      placeholder="Source path"
                      value={rule.source}
                      disabled={!canManage}
                      className={tableInputClass}
                      onChange={(event) => {
                        const next = [...customRewrites];
                        next[index] = { ...next[index], source: event.target.value };
                        setCustomRewrites(next);
                      }}
                    />
                    <Input
                      placeholder="Destination"
                      value={rule.destination}
                      disabled={!canManage}
                      className={cn(tableInputClass, "border-l border-border")}
                      onChange={(event) => {
                        const next = [...customRewrites];
                        next[index] = { ...next[index], destination: event.target.value };
                        setCustomRewrites(next);
                      }}
                    />
                    <Select
                      value={rule.type}
                      onValueChange={(value) => {
                        const next = [...customRewrites];
                        next[index] = {
                          ...next[index],
                          type: value as "permanent" | "temporary",
                        };
                        setCustomRewrites(next);
                      }}
                      disabled={!canManage}
                    >
                      <SelectTrigger
                        className={cn(
                          tableInputClass,
                          "border-l border-border font-sans focus:ring-1 focus:ring-inset focus:ring-ring"
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="font-sans">
                        <SelectItem value="permanent">Permanent</SelectItem>
                        <SelectItem value="temporary">Temporary</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-none border-l border-border"
                      aria-label={`Remove URL rewrite ${index + 1}`}
                      onClick={() =>
                        setCustomRewrites(customRewrites.filter((_, i) => i !== index))
                      }
                      disabled={!canManage}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState message="No URL rewrites" embedded />
          )}
        </PanelShell>
      )}
    </div>
  );
}
