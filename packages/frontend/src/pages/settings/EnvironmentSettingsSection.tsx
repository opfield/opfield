import { Clock3, FileInput, Gauge, KeyRound, RotateCcw, Save } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { NumericInput } from "@/components/ui/numeric-input";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type {
  EnvironmentSettings,
  EnvironmentSettingsGroup,
  EnvironmentSettingsUpdate,
} from "@/types";

const KIB = 1024;
const MIB = 1024 * KIB;
const RATE_CORE_KEYS = [
  "windowMs",
  "maxRequests",
  "sessionMaxRequests",
  "authMaxRequests",
  "authLoginMaxRequests",
  "authCallbackMaxRequests",
] as const;
const RATE_PUBLIC_KEYS = [
  "publicStatusMaxRequests",
  "publicWebhookMaxRequests",
  "pkiMaxRequests",
  "streamMaxRequests",
  "aiWebSocketMaxRequests",
  "inferenceMaxRequests",
] as const;
const LOGGING_PAYLOAD_KEYS = [
  "maxBodyBytes",
  "maxBatchSize",
  "maxMessageBytes",
  "maxLabels",
  "maxFields",
  "maxKeyLength",
  "maxValueBytes",
] as const;
const LOGGING_ADMISSION_KEYS = [
  "maxJsonDepth",
  "rateLimitWindowSeconds",
  "globalRequestsPerWindow",
  "globalEventsPerWindow",
  "tokenRequestsPerWindow",
  "tokenEventsPerWindow",
] as const;

interface NumberSettingProps {
  title: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
  unit?: string;
  divisor?: number;
  min?: number;
  max?: number;
  help?: string;
}

function NumberSetting({
  title,
  description,
  value,
  onChange,
  disabled,
  unit = "",
  divisor = 1,
  min = 1,
  max,
  help,
}: NumberSettingProps) {
  const displayedValue = Math.max(min, Math.round(value / divisor));
  return (
    <SettingsControlRow title={title} description={description} help={help}>
      <InlineNumberControl
        ariaLabel={`${title}${unit ? ` (${unit})` : ""}`}
        value={displayedValue}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(next) => onChange(Math.round(next * divisor))}
      />
    </SettingsControlRow>
  );
}

function InlineNumberControl({
  ariaLabel,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: number;
  min?: number;
  max?: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="w-full">
      <NumericInput
        aria-label={ariaLabel}
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(next) => onChange(next)}
      />
    </div>
  );
}

function CombinedNumberSetting({
  title,
  description,
  help,
  controls,
}: {
  title: string;
  description: string;
  help?: string;
  controls: Array<{
    label: string;
    value: number;
    disabled: boolean;
    onChange: (value: number) => void;
  }>;
}) {
  return (
    <SettingsControlRow
      title={title}
      description={description}
      help={help}
      controlsClassName="grid grid-cols-[7rem_7rem] justify-end gap-2 sm:min-w-0 sm:max-w-none"
    >
      {controls.map((control) => (
        <InlineNumberControl
          key={control.label}
          ariaLabel={control.label}
          value={control.value}
          disabled={control.disabled}
          onChange={control.onChange}
        />
      ))}
    </SettingsControlRow>
  );
}

function EnvironmentPanel({
  title,
  description,
  icon,
  dirty,
  isDefault,
  saving,
  canEdit,
  onSave,
  onRestore,
  children,
  bodyClassName,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  dirty: boolean;
  isDefault: boolean;
  saving: boolean;
  canEdit: boolean;
  onSave: () => void;
  onRestore: () => void;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <PanelShell
      role="region"
      aria-label={`${title} settings`}
      title={title}
      description={description}
      icon={icon}
      dirty={dirty}
      bodyClassName={bodyClassName}
      actions={
        canEdit ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onRestore} disabled={saving || isDefault}>
              <RotateCcw className="h-4 w-4" />
              Restore defaults
            </Button>
            <Button onClick={onSave} pending={saving} disabled={!dirty}>
              <Save className="h-4 w-4" />
              Save
            </Button>
          </div>
        ) : null
      }
    >
      {children}
    </PanelShell>
  );
}

export function EnvironmentSettingsSection({ canEdit }: { canEdit: boolean }) {
  const [draft, setDraft] = useState<EnvironmentSettings | null>(null);
  const [saved, setSaved] = useState<EnvironmentSettings | null>(null);
  const [defaults, setDefaults] = useState<EnvironmentSettings | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await api.getEnvironmentSettings();
      setDraft(response.data);
      setSaved(response.data);
      setDefaults(response.defaults);
    } catch (error) {
      toastApiError(error, "Failed to load environment settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setValue = <G extends EnvironmentSettingsGroup, K extends keyof EnvironmentSettings[G]>(
    group: G,
    key: K,
    value: EnvironmentSettings[G][K]
  ) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            [group]: { ...current[group], [key]: value },
          }
        : current
    );
  };

  const isDirty = (group: EnvironmentSettingsGroup) =>
    draft !== null &&
    saved !== null &&
    JSON.stringify(draft[group]) !== JSON.stringify(saved[group]);

  const isDefault = (group: EnvironmentSettingsGroup) =>
    draft !== null &&
    defaults !== null &&
    JSON.stringify(draft[group]) === JSON.stringify(defaults[group]);

  const isSubsetDirty = (group: EnvironmentSettingsGroup, keys: readonly string[]) => {
    const current = draft?.[group] as unknown as Record<string, number> | undefined;
    const persisted = saved?.[group] as unknown as Record<string, number> | undefined;
    return (
      current !== undefined &&
      persisted !== undefined &&
      keys.some((key) => current[key] !== persisted[key])
    );
  };

  const isSubsetDefault = (group: EnvironmentSettingsGroup, keys: readonly string[]) => {
    const current = draft?.[group] as unknown as Record<string, number> | undefined;
    const fallback = defaults?.[group] as unknown as Record<string, number> | undefined;
    return (
      current !== undefined &&
      fallback !== undefined &&
      keys.every((key) => current[key] === fallback[key])
    );
  };

  const restore = (group: EnvironmentSettingsGroup) => {
    if (!defaults) return;
    setDraft((current) => (current ? { ...current, [group]: { ...defaults[group] } } : current));
  };

  const restoreSubset = (group: EnvironmentSettingsGroup, keys: readonly string[]) => {
    if (!defaults) return;
    const fallback = defaults[group] as unknown as Record<string, number>;
    setDraft((current) => {
      if (!current) return current;
      const nextGroup = { ...(current[group] as unknown as Record<string, number>) };
      for (const key of keys) nextGroup[key] = fallback[key]!;
      return { ...current, [group]: nextGroup } as EnvironmentSettings;
    });
  };

  const save = async (
    group: EnvironmentSettingsGroup,
    section: string = group,
    keys?: readonly string[]
  ) => {
    if (!draft || !canEdit) return;
    setSavingSection(section);
    try {
      const groupDraft = draft[group] as unknown as Record<string, number>;
      const values = keys
        ? Object.fromEntries(keys.map((key) => [key, groupDraft[key]]))
        : groupDraft;
      const updated = await api.updateEnvironmentSettings({
        [group]: values,
      } as EnvironmentSettingsUpdate);
      setDraft(updated);
      setSaved(updated);
      toast.success(`${panelLabel(group)} settings updated`);
    } catch (error) {
      toastApiError(error, "Failed to update environment settings");
    } finally {
      setSavingSection(null);
    }
  };

  useContentLoading(loading);
  if (!draft || !saved || !defaults) return null;

  const disabled = !canEdit || savingSection !== null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <EnvironmentPanel
          title="Rate limits: core and authentication"
          description="Opfield, setup, and sign-in admission limits."
          icon={<Gauge className="h-4 w-4" />}
          dirty={isSubsetDirty("rateLimits", RATE_CORE_KEYS)}
          isDefault={isSubsetDefault("rateLimits", RATE_CORE_KEYS)}
          saving={savingSection === "rateLimits:core"}
          canEdit={canEdit}
          onRestore={() => restoreSubset("rateLimits", RATE_CORE_KEYS)}
          onSave={() => void save("rateLimits", "rateLimits:core", RATE_CORE_KEYS)}
        >
          <NumberSetting
            title="Window"
            description="Shared sliding-window duration in seconds."
            value={draft.rateLimits.windowMs}
            divisor={1000}
            unit="seconds"
            min={1}
            max={3600}
            help="The window is the period in which Opfield counts requests. Because it slides with traffic, capacity returns gradually instead of resetting at a fixed clock time."
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "windowMs", value)}
          />
          <NumberSetting
            title="API requests"
            description="Authenticated API requests per client in each window."
            value={draft.rateLimits.maxRequests}
            unit="requests"
            help="Applies to ordinary Opfield API calls from one client IP: API tokens, scripts, and requests without a session. Signed-in browser sessions, login, public, streaming, and inference routes have their own limits."
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "maxRequests", value)}
          />
          <NumberSetting
            title="Signed-in sessions"
            description="API requests per signed-in browser session in each window."
            value={draft.rateLimits.sessionMaxRequests}
            unit="requests"
            help="Each signed-in browser session has a budget of its own, so the pages people open do not share the per-client limit with scripts and other browsers behind the same IP."
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "sessionMaxRequests", value)}
          />
          <NumberSetting
            title="Authentication"
            description="Authentication requests per client in each window."
            value={draft.rateLimits.authMaxRequests}
            unit="requests"
            help="This is the broad authentication and OAuth limit. Login attempts and OIDC callbacks also have stricter limits below."
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "authMaxRequests", value)}
          />
          <NumberSetting
            title="Login attempts"
            description="Password, OTP, MFA, and passkey attempts per window."
            value={draft.rateLimits.authLoginMaxRequests}
            unit="requests"
            help="Counts password, email code, MFA, passkey, and password-reset attempts. It is intentionally stricter than the general authentication limit."
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "authLoginMaxRequests", value)}
          />
          <NumberSetting
            title="OIDC callbacks"
            description="OIDC callback requests per client in each window."
            value={draft.rateLimits.authCallbackMaxRequests}
            unit="requests"
            help="An OIDC callback is the request sent back to Opfield after a user signs in with an external identity provider. This limit protects that return endpoint."
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "authCallbackMaxRequests", value)}
          />
        </EnvironmentPanel>
        <EnvironmentPanel
          title="Rate limits: public and workloads"
          description="Public, streaming, AI, and inference limits."
          icon={<Gauge className="h-4 w-4" />}
          dirty={isSubsetDirty("rateLimits", RATE_PUBLIC_KEYS)}
          isDefault={isSubsetDefault("rateLimits", RATE_PUBLIC_KEYS)}
          saving={savingSection === "rateLimits:public"}
          canEdit={canEdit}
          onRestore={() => restoreSubset("rateLimits", RATE_PUBLIC_KEYS)}
          onSave={() => void save("rateLimits", "rateLimits:public", RATE_PUBLIC_KEYS)}
        >
          <NumberSetting
            title="Public status"
            description="Status page requests per client in each window."
            help="Applies to the unauthenticated public status page. It limits aggressive polling and refresh loops without requiring an API token."
            value={draft.rateLimits.publicStatusMaxRequests}
            unit="requests"
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "publicStatusMaxRequests", value)}
          />
          <NumberSetting
            title="Public webhooks"
            description="Inbound webhook requests per client in each window."
            help="Webhooks are requests sent to Opfield automatically by external services. This limit prevents one sender or retry loop from overwhelming the receiver."
            value={draft.rateLimits.publicWebhookMaxRequests}
            unit="requests"
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "publicWebhookMaxRequests", value)}
          />
          <NumberSetting
            title="PKI"
            description="Public PKI requests per client in each window."
            help="Applies to public certificate and revocation endpoints; it does not limit certificate issuance."
            value={draft.rateLimits.pkiMaxRequests}
            unit="requests"
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "pkiMaxRequests", value)}
          />
          <NumberSetting
            title="Streams"
            description="Streaming connection attempts per client in each window."
            help="Counts WebSocket and streaming connection attempts, including reconnects—not streams that are already open."
            value={draft.rateLimits.streamMaxRequests}
            unit="requests"
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "streamMaxRequests", value)}
          />
          <NumberSetting
            title="AI Workspace WebSocket"
            description="AI Workspace handshakes per client in each window."
            help="Counts AI Workspace handshakes and reconnects. An active conversation is counted again only when it opens a new connection."
            value={draft.rateLimits.aiWebSocketMaxRequests}
            unit="requests"
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "aiWebSocketMaxRequests", value)}
          />
          <NumberSetting
            title="Inference"
            description="Inference requests per API token in each window."
            help="Caps inference request starts per API token. Simultaneously active requests are controlled by the concurrency limit below."
            value={draft.rateLimits.inferenceMaxRequests}
            unit="requests"
            disabled={disabled}
            onChange={(value) => setValue("rateLimits", "inferenceMaxRequests", value)}
          />
        </EnvironmentPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <EnvironmentPanel
          title="Logging: payload validation"
          description="Payload and event validation limits."
          icon={<FileInput className="h-4 w-4" />}
          dirty={isSubsetDirty("loggingIngest", LOGGING_PAYLOAD_KEYS)}
          isDefault={isSubsetDefault("loggingIngest", LOGGING_PAYLOAD_KEYS)}
          saving={savingSection === "loggingIngest:payload"}
          canEdit={canEdit}
          onRestore={() => restoreSubset("loggingIngest", LOGGING_PAYLOAD_KEYS)}
          onSave={() => void save("loggingIngest", "loggingIngest:payload", LOGGING_PAYLOAD_KEYS)}
        >
          <NumberSetting
            title="Request body"
            description="Maximum logging request body in KiB."
            help="The request body is the entire logging payload sent in one HTTP request, including every event in its batch. Larger values allow bigger uploads but require more memory to accept and validate."
            value={draft.loggingIngest.maxBodyBytes}
            divisor={KIB}
            unit="KiB"
            min={1}
            max={256 * 1024}
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "maxBodyBytes", value)}
          />
          <NumberSetting
            title="Batch size"
            description="Maximum number of events in one batch."
            help="A batch is a group of log events sent in one request. This setting limits the event count even when the encoded request body is still small enough."
            value={draft.loggingIngest.maxBatchSize}
            unit="events"
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "maxBatchSize", value)}
          />
          <NumberSetting
            title="Message size"
            description="Maximum UTF-8 message size in KiB."
            help="Limits the text message of one log event after UTF-8 encoding. Other labels and structured fields are controlled separately."
            value={draft.loggingIngest.maxMessageBytes}
            divisor={KIB}
            unit="KiB"
            min={1}
            max={4096}
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "maxMessageBytes", value)}
          />
          <CombinedNumberSetting
            title="Labels and fields"
            description="Maximum labels first, structured fields second."
            help="The first value limits searchable labels; the second limits structured fields in each event."
            controls={[
              {
                label: "Maximum labels",
                value: draft.loggingIngest.maxLabels,
                disabled,
                onChange: (value) => setValue("loggingIngest", "maxLabels", value),
              },
              {
                label: "Maximum fields",
                value: draft.loggingIngest.maxFields,
                disabled,
                onChange: (value) => setValue("loggingIngest", "maxFields", value),
              },
            ]}
          />
          <NumberSetting
            title="Key length"
            description="Maximum label or field key length in characters."
            help="A key is the name of a label or structured field, such as service, environment, or request_id. This limits the length of each name, not its stored value."
            value={draft.loggingIngest.maxKeyLength}
            unit="characters"
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "maxKeyLength", value)}
          />
          <NumberSetting
            title="Value size"
            description="Maximum encoded field value size in KiB."
            help="Applies to one label or structured-field value after encoding. The request-body limit still caps the combined size of the complete batch."
            value={draft.loggingIngest.maxValueBytes}
            divisor={KIB}
            unit="KiB"
            min={1}
            max={4096}
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "maxValueBytes", value)}
          />
        </EnvironmentPanel>
        <EnvironmentPanel
          title="Logging: structure and admission"
          description="Structure and ingest admission limits."
          icon={<FileInput className="h-4 w-4" />}
          dirty={isSubsetDirty("loggingIngest", LOGGING_ADMISSION_KEYS)}
          isDefault={isSubsetDefault("loggingIngest", LOGGING_ADMISSION_KEYS)}
          saving={savingSection === "loggingIngest:admission"}
          canEdit={canEdit}
          onRestore={() => restoreSubset("loggingIngest", LOGGING_ADMISSION_KEYS)}
          onSave={() =>
            void save("loggingIngest", "loggingIngest:admission", LOGGING_ADMISSION_KEYS)
          }
        >
          <NumberSetting
            title="JSON depth"
            description="Maximum number of JSON nesting levels."
            help="JSON depth counts nested objects and arrays, for example an object inside another object. Limiting it prevents unusually complex events from becoming expensive to validate and query."
            value={draft.loggingIngest.maxJsonDepth}
            unit="levels"
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "maxJsonDepth", value)}
          />
          <NumberSetting
            title="Rate-limit window"
            description="Logging rate-limit window in seconds."
            help="This window is used by every logging request and event counter in this panel. Changes affect newly calculated buckets immediately."
            value={draft.loggingIngest.rateLimitWindowSeconds}
            unit="seconds"
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "rateLimitWindowSeconds", value)}
          />
          <NumberSetting
            title="Global requests"
            description="Opfield-wide logging requests in each window."
            help="Counts logging HTTP requests from every ingest token combined. One request may contain many events, which are also counted by the separate global event limit."
            value={draft.loggingIngest.globalRequestsPerWindow}
            unit="requests"
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "globalRequestsPerWindow", value)}
          />
          <NumberSetting
            title="Global events"
            description="Opfield-wide ingested events in each window."
            help="Counts individual log events across all requests and tokens. A batch containing 100 events consumes 100 units from this limit."
            value={draft.loggingIngest.globalEventsPerWindow}
            unit="events"
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "globalEventsPerWindow", value)}
          />
          <NumberSetting
            title="Token requests"
            description="Default requests per ingest token in each window."
            help="Default request allowance for each ingest token. An environment-specific limit may replace or lower this value."
            value={draft.loggingIngest.tokenRequestsPerWindow}
            unit="requests"
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "tokenRequestsPerWindow", value)}
          />
          <NumberSetting
            title="Token events"
            description="Default events per ingest token in each window."
            help="Limits individual events accepted from one ingest token, regardless of how those events are divided into requests or batches."
            value={draft.loggingIngest.tokenEventsPerWindow}
            unit="events"
            disabled={disabled}
            onChange={(value) => setValue("loggingIngest", "tokenEventsPerWindow", value)}
          />
        </EnvironmentPanel>
      </div>

      <EnvironmentPanel
        title="HTTP and inference limits"
        description="HTTP, WebSocket, and concurrency limits."
        icon={<FileInput className="h-4 w-4" />}
        dirty={isDirty("requestLimits")}
        isDefault={isDefault("requestLimits")}
        saving={savingSection === "requestLimits"}
        canEdit={canEdit}
        onRestore={() => restore("requestLimits")}
        onSave={() => void save("requestLimits")}
      >
        <NumberSetting
          title="Default API body"
          description="Default API request body limit in MiB."
          help="Applies to API routes without a more specific upload or protocol limit. Oversized bodies are rejected with HTTP 413 before route processing."
          value={draft.requestLimits.requestBodyMaxBytes}
          divisor={MIB}
          unit="MiB"
          min={1}
          max={32}
          disabled={disabled}
          onChange={(value) => setValue("requestLimits", "requestBodyMaxBytes", value)}
        />
        <NumberSetting
          title="OAuth and auth body"
          description="OAuth and browser authentication body limit in KiB."
          help="Applies to sign-in forms, OAuth callbacks, passwords, passkeys, and verification codes. These routes use a smaller limit than general API requests because their payloads should remain small."
          value={draft.requestLimits.oauthBodyMaxBytes}
          divisor={KIB}
          unit="KiB"
          min={8}
          max={1024}
          disabled={disabled}
          onChange={(value) => setValue("requestLimits", "oauthBodyMaxBytes", value)}
        />
        <NumberSetting
          title="Inference HTTP body"
          description="Inference HTTP request body limit in MiB."
          help="Limits one complete inference request sent over HTTP, including conversation context and any attachments represented inside the request body."
          value={draft.requestLimits.inferenceHttpBodyMaxBytes}
          divisor={MIB}
          unit="MiB"
          min={1}
          max={2048}
          disabled={disabled}
          onChange={(value) => setValue("requestLimits", "inferenceHttpBodyMaxBytes", value)}
        />
        <NumberSetting
          title="Inference WebSocket payload"
          description="Inference WebSocket message limit in MiB."
          help="Limits one message sent over an inference WebSocket connection. It is independent from the HTTP body limit because WebSocket traffic uses separate messages after connecting."
          value={draft.requestLimits.inferenceWebSocketMaxPayloadBytes}
          divisor={MIB}
          unit="MiB"
          min={1}
          max={512}
          disabled={disabled}
          onChange={(value) =>
            setValue("requestLimits", "inferenceWebSocketMaxPayloadBytes", value)
          }
        />
        <NumberSetting
          title="Concurrent inference requests"
          description="Maximum active inference requests per API token."
          help="Concurrency means requests running at the same time. This protects capacity even when the token is still below its request-per-window rate limit."
          value={draft.requestLimits.inferenceMaxConcurrentRequestsPerToken}
          unit="requests"
          max={128}
          disabled={disabled}
          onChange={(value) =>
            setValue("requestLimits", "inferenceMaxConcurrentRequestsPerToken", value)
          }
        />
        <NumberSetting
          title="Concurrency lease"
          description="Concurrency lease duration in seconds."
          help="An inference slot remains reserved for this long without renewal, allowing Opfield to recover capacity after a worker or connection disappears."
          value={draft.requestLimits.inferenceConcurrencyLeaseSeconds}
          unit="seconds"
          min={30}
          max={2400}
          disabled={disabled}
          onChange={(value) => setValue("requestLimits", "inferenceConcurrencyLeaseSeconds", value)}
        />
      </EnvironmentPanel>

      <EnvironmentPanel
        title="Sessions"
        description="Lifetime for new and renewed browser sessions."
        icon={<Clock3 className="h-4 w-4" />}
        dirty={isDirty("sessions")}
        isDefault={isDefault("sessions")}
        saving={savingSection === "sessions"}
        canEdit={canEdit}
        onRestore={() => restore("sessions")}
        onSave={() => void save("sessions")}
      >
        <NumberSetting
          title="Session lifetime"
          description="Browser session lifetime in days."
          help="Applies to new sessions and rolling renewals. Existing sessions keep their stored expiry until their next renewal."
          value={draft.sessions.expirySeconds}
          divisor={86400}
          unit="days"
          min={1}
          max={365}
          disabled={disabled}
          onChange={(value) => setValue("sessions", "expirySeconds", value)}
        />
        <NumberSetting
          title="Absolute session lifetime"
          description="Maximum session age from sign-in in days. 0 turns the limit off."
          help="Ends a browser session this long after sign-in even while it is in use, so renewals cannot keep it alive forever. Applies to existing sessions too."
          value={draft.sessions.absoluteLifetimeSeconds ?? 0}
          divisor={86400}
          unit="days"
          min={0}
          max={365}
          disabled={disabled}
          onChange={(value) =>
            setValue("sessions", "absoluteLifetimeSeconds", value > 0 ? value : null)
          }
        />
      </EnvironmentPanel>

      <EnvironmentPanel
        title="PKI defaults"
        description="Revocation and certificate expiry defaults."
        icon={<KeyRound className="h-4 w-4" />}
        dirty={isDirty("pkiDefaults")}
        isDefault={isDefault("pkiDefaults")}
        saving={savingSection === "pkiDefaults"}
        canEdit={canEdit}
        onRestore={() => restore("pkiDefaults")}
        onSave={() => void save("pkiDefaults")}
      >
        <NumberSetting
          title="CRL validity"
          description="Generated CRL validity and cache duration in hours."
          help="Sets both the CRL next-update interval and cache lifetime. Shorter periods publish revocations sooner but regenerate CRLs more often."
          value={draft.pkiDefaults.crlValidityHours}
          unit="hours"
          disabled={disabled}
          onChange={(value) => setValue("pkiDefaults", "crlValidityHours", value)}
        />
        <NumberSetting
          title="Expiry warning"
          description="Expiry warning threshold in days."
          help="Creates warning alerts for active SSL certificates, PKI certificates, and certificate authorities."
          value={draft.pkiDefaults.expiryWarningDays}
          unit="days"
          disabled={disabled}
          onChange={(value) => setValue("pkiDefaults", "expiryWarningDays", value)}
        />
        <NumberSetting
          title="Expiry critical"
          description="Critical expiry threshold in days."
          help="Escalates an expiry alert to critical. This value must be less than or equal to the warning threshold."
          value={draft.pkiDefaults.expiryCriticalDays}
          unit="days"
          disabled={disabled}
          onChange={(value) => setValue("pkiDefaults", "expiryCriticalDays", value)}
        />
      </EnvironmentPanel>
    </div>
  );
}

function panelLabel(group: EnvironmentSettingsGroup): string {
  switch (group) {
    case "rateLimits":
      return "Rate limiting";
    case "loggingIngest":
      return "Logging ingest";
    case "requestLimits":
      return "HTTP and inference limits";
    case "sessions":
      return "Session";
    case "pkiDefaults":
      return "PKI default";
  }
}
