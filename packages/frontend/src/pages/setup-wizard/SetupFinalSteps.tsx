import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Database,
  KeyRound,
  type LucideIcon,
  Mail,
  MoreHorizontal,
  ShieldCheck,
} from "lucide-react";
import { type Dispatch, type SetStateAction, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type AdminDraft,
  isAdminDraftValid,
  isLoggingDraftValid,
  type LoggingDraft,
  type NetworkDraft,
  type OidcDraft,
  type PrimaryMethod,
  type SetupSmtpDraft,
} from "./setup-wizard-model";

interface NavigationProps {
  busy: boolean;
  onBack?: () => void;
  onContinue: () => void;
}

export function LicenseStep({
  busy,
  onActivate,
  onCommunity,
}: {
  busy: boolean;
  onActivate: (licenseKey: string) => void;
  onCommunity: () => void;
}) {
  const [licenseKey, setLicenseKey] = useState("");
  const trimmedKey = licenseKey.trim();

  return (
    <section className="mx-auto max-w-md space-y-3 text-center">
      <div>
        <h2 className="text-lg font-semibold">Opfield edition</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Community is available for internal and other noncompeting use under the{" "}
          <a
            className="underline underline-offset-4 hover:text-foreground"
            href="https://github.com/opfield/opfield/blob/main/LICENSE.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            PolyForm Perimeter License
          </a>
          . A Personal, Business, or Enterprise key unlocks paid-plan features and limits. By
          activating it, you agree to the{" "}
          <a
            className="underline underline-offset-4 hover:text-foreground"
            href="https://github.com/opfield/opfield/blob/main/COMMERCIAL-LICENSE.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            Paid Key Terms
          </a>
          .
        </p>
      </div>
      <form
        className="space-y-3 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedKey) onActivate(trimmedKey);
        }}
      >
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="setup-license-key">
            License key
          </label>
          <Input
            id="setup-license-key"
            value={licenseKey}
            onChange={(event) => setLicenseKey(event.target.value)}
            placeholder="WLT-GW-..."
            autoComplete="off"
            disabled={busy}
          />
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" variant="outline" onClick={onCommunity} disabled={busy}>
            Continue with Community
          </Button>
          <Button type="submit" pending={busy} disabled={!trimmedKey}>
            <KeyRound />
            Activate license
          </Button>
        </div>
      </form>
    </section>
  );
}

export function AIWorkspaceStep({
  busy,
  onConfigure,
  onSkip,
}: {
  busy: boolean;
  onConfigure: () => void;
  onSkip: () => void;
}) {
  return (
    <section className="mx-auto max-w-md space-y-3 text-center">
      <div>
        <h2 className="text-lg font-semibold">AI Workspace</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          AI Workspace is Opfield&apos;s recommended intent-driven interface, keeping guidance,
          actions, and infrastructure context in one Work Session so Opfield is easier to understand
          and operate. It is optional: Operations Console remains fully available without AI, and
          you can enable AI Workspace later.
        </p>
      </div>
      <div className="flex justify-center gap-2">
        <Button type="button" variant="outline" onClick={onSkip} disabled={busy}>
          <MoreHorizontal />
          Skip for now
        </Button>
        <Button type="button" onClick={onConfigure} disabled={busy}>
          <Bot className="h-4 w-4" />
          Configure AI Workspace
        </Button>
      </div>
    </section>
  );
}

const ADMIN_AUTH_METHODS: Record<PrimaryMethod, { label: string; icon: LucideIcon }> = {
  oidc: { label: "OIDC", icon: ShieldCheck },
  password: { label: "Password", icon: KeyRound },
  email_otp: { label: "Email code", icon: Mail },
};

export function AdminAuthMethodStep({
  admin,
  busy,
  enabledMethods,
  setAdmin,
  onBack,
  onContinue,
}: NavigationProps & {
  admin: AdminDraft;
  enabledMethods: PrimaryMethod[];
  setAdmin: Dispatch<SetStateAction<AdminDraft>>;
}) {
  const canContinue = admin.authMethod !== null && enabledMethods.includes(admin.authMethod);
  return (
    <section className="mx-auto max-w-xs space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Administrator sign-in</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose exactly one sign-in method for the first administrator.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canContinue) onContinue();
        }}
      >
        <div className="space-y-3">
          {enabledMethods.map((method) => {
            const option = ADMIN_AUTH_METHODS[method];
            const Icon = option.icon;
            return (
              <Button
                key={method}
                type="button"
                className="w-full"
                variant={admin.authMethod === method ? "default" : "outline"}
                aria-pressed={admin.authMethod === method}
                disabled={busy}
                onClick={() => setAdmin((value) => ({ ...value, authMethod: method }))}
              >
                <Icon className="h-4 w-4" />
                {option.label}
              </Button>
            );
          })}
        </div>
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-max flex-none"
            onClick={onBack}
            disabled={busy}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button type="submit" className="w-max flex-none" disabled={busy || !canContinue}>
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}

export function AdminDetailsStep({
  admin,
  busy,
  setAdmin,
  onBack,
  onContinue,
}: NavigationProps & {
  admin: AdminDraft;
  setAdmin: Dispatch<SetStateAction<AdminDraft>>;
}) {
  return (
    <section className="mx-auto max-w-sm space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Administrator details</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Create the first system administrator account.
        </p>
      </div>
      <form
        className="mx-auto max-w-sm space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <Input
          required
          placeholder="Full name"
          value={admin.name}
          onChange={(event) => setAdmin((value) => ({ ...value, name: event.target.value }))}
        />
        <Input
          required
          type="email"
          placeholder="Email"
          value={admin.email}
          onChange={(event) => setAdmin((value) => ({ ...value, email: event.target.value }))}
        />
        {admin.authMethod === "password" && (
          <Input
            required
            minLength={12}
            maxLength={72}
            type="password"
            autoComplete="new-password"
            placeholder="Initial password (12+ characters)"
            value={admin.password}
            onChange={(event) => setAdmin((value) => ({ ...value, password: event.target.value }))}
          />
        )}
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-max flex-none"
            onClick={onBack}
            disabled={busy}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            type="submit"
            className="w-max flex-none"
            pending={busy}
            disabled={!isAdminDraftValid(admin)}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}

const LOGGING_OPTIONS = [
  {
    mode: "disabled" as const,
    label: "Disabled",
  },
  {
    mode: "local" as const,
    label: "Managed local",
  },
  {
    mode: "external" as const,
    label: "External",
  },
];

export function LoggingStep({
  busy,
  hasSavedPassword,
  logging,
  storageLicensed,
  setLogging,
  onBack,
  onContinue,
}: NavigationProps & {
  hasSavedPassword: boolean;
  logging: LoggingDraft;
  /** Managed local and external storage need a Business license, which setup activates only after this step. */
  storageLicensed: boolean;
  setLogging: Dispatch<SetStateAction<LoggingDraft>>;
}) {
  return (
    <section className="mx-auto max-w-sm space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Structured logs</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Disable structured logs, manage ClickHouse locally, or connect an external instance.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <div className="space-y-3">
          {LOGGING_OPTIONS.map((option) => (
            <Button
              key={option.mode}
              type="button"
              className="w-full"
              variant={logging.mode === option.mode ? "default" : "outline"}
              aria-pressed={logging.mode === option.mode}
              disabled={option.mode !== "disabled" && !storageLicensed}
              onClick={() => setLogging((value) => ({ ...value, mode: option.mode }))}
            >
              {option.mode === "local" && <Database className="h-4 w-4" />}
              {option.label}
              {option.mode !== "disabled" && !storageLicensed && (
                <Badge size="inline" variant="info">
                  Business
                </Badge>
              )}
            </Button>
          ))}
        </div>
        {!storageLicensed && (
          <p className="text-center text-sm text-muted-foreground">
            Structured logs need the Business plan. Activate a license after setup, then turn them
            on in Settings.
          </p>
        )}
        {logging.mode === "external" && (
          <div className="space-y-3">
            <Input
              required
              type="url"
              placeholder="https://clickhouse.example.com:8443"
              value={logging.url}
              onChange={(event) => setLogging((value) => ({ ...value, url: event.target.value }))}
            />
            <Input
              required
              placeholder="Username"
              value={logging.username}
              onChange={(event) =>
                setLogging((value) => ({ ...value, username: event.target.value }))
              }
            />
            <Input
              required={!hasSavedPassword}
              type="password"
              placeholder={hasSavedPassword ? "Password (unchanged)" : "Password"}
              value={logging.password}
              onChange={(event) =>
                setLogging((value) => ({ ...value, password: event.target.value }))
              }
            />
            <Input
              required
              placeholder="Database"
              value={logging.database}
              onChange={(event) =>
                setLogging((value) => ({ ...value, database: event.target.value }))
              }
            />
            <Input
              required
              placeholder="Logs table"
              value={logging.table}
              onChange={(event) => setLogging((value) => ({ ...value, table: event.target.value }))}
            />
          </div>
        )}
        {logging.mode === "local" && (
          <p className="text-center text-sm text-muted-foreground">
            Opfield will attach a pinned ClickHouse container to its Docker network and preserve its
            volume if logging is disabled later.
          </p>
        )}
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-max flex-none"
            onClick={onBack}
            disabled={busy}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            type="submit"
            className="w-max flex-none"
            pending={busy}
            disabled={!isLoggingDraftValid(logging, hasSavedPassword)}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}

export function FinishStep({
  administrator,
  administratorCreated,
  busy,
  enabledMethods,
  logging,
  network,
  oidc,
  publicUrl,
  smtp,
  onBack,
  onContinue,
}: NavigationProps & {
  administrator: AdminDraft;
  administratorCreated: boolean;
  enabledMethods: PrimaryMethod[];
  logging: LoggingDraft;
  network: NetworkDraft;
  oidc: OidcDraft;
  publicUrl: string;
  smtp: SetupSmtpDraft;
}) {
  const signInMethods = enabledMethods.map((method) => ADMIN_AUTH_METHODS[method].label).join(", ");
  return (
    <section className="space-y-3">
      <PanelShell
        title="Review configuration"
        description="No changes have been applied yet. Confirm to configure Opfield in one operation."
      >
        <SettingsControlRow title="Public URL" controlsClassName="sm:min-w-0 sm:max-w-64">
          <span className="break-all text-right text-sm text-muted-foreground">{publicUrl}</span>
        </SettingsControlRow>
        <SettingsControlRow title="gRPC public target" controlsClassName="sm:min-w-0 sm:max-w-64">
          <span className="break-all text-right text-sm text-muted-foreground">
            {network.grpcPublicTarget}
          </span>
        </SettingsControlRow>
        <SettingsControlRow title="gRPC local IP" controlsClassName="sm:min-w-0 sm:max-w-64">
          <span className="break-all text-right text-sm text-muted-foreground">
            {network.grpcLocalIp || "Uses public target"}
          </span>
        </SettingsControlRow>
        <SettingsControlRow title="Sign-in methods" controlsClassName="sm:min-w-0 sm:max-w-64">
          <span className="text-right text-sm text-muted-foreground">{signInMethods}</span>
        </SettingsControlRow>
        {enabledMethods.includes("oidc") && (
          <>
            <SettingsControlRow title="OIDC issuer" controlsClassName="sm:min-w-0 sm:max-w-64">
              <span className="break-all text-right text-sm text-muted-foreground">
                {oidc.issuer}
              </span>
            </SettingsControlRow>
            <SettingsControlRow title="OIDC client" controlsClassName="sm:min-w-0 sm:max-w-64">
              <span className="break-all text-right text-sm text-muted-foreground">
                {oidc.clientId}
              </span>
            </SettingsControlRow>
            <SettingsControlRow title="OIDC callback" controlsClassName="sm:min-w-0 sm:max-w-64">
              <span className="break-all text-right text-sm text-muted-foreground">
                {oidc.redirectUri}
              </span>
            </SettingsControlRow>
            <SettingsControlRow title="OIDC scopes" controlsClassName="sm:min-w-0 sm:max-w-64">
              <span className="text-right text-sm text-muted-foreground">{oidc.scopes}</span>
            </SettingsControlRow>
          </>
        )}
        {(enabledMethods.includes("password") || enabledMethods.includes("email_otp")) && (
          <>
            <SettingsControlRow title="SMTP relay" controlsClassName="sm:min-w-0 sm:max-w-64">
              <span className="break-all text-right text-sm text-muted-foreground">
                {smtp.host}:{smtp.port}
              </span>
            </SettingsControlRow>
            <SettingsControlRow title="Email sender" controlsClassName="sm:min-w-0 sm:max-w-64">
              <span className="break-all text-right text-sm text-muted-foreground">
                {smtp.senderName} &lt;{smtp.senderEmail}&gt;
              </span>
            </SettingsControlRow>
          </>
        )}
        <SettingsControlRow title="Administrator" controlsClassName="sm:min-w-0 sm:max-w-64">
          <span className="break-all text-right text-sm text-muted-foreground">
            {administratorCreated ? "Already created" : administrator.email}
          </span>
        </SettingsControlRow>
        <SettingsControlRow title="Structured logs" controlsClassName="sm:min-w-0 sm:max-w-64">
          <span className="text-right text-sm capitalize text-muted-foreground">
            {logging.mode}
          </span>
        </SettingsControlRow>
        {logging.mode === "external" && (
          <>
            <SettingsControlRow title="ClickHouse URL" controlsClassName="sm:min-w-0 sm:max-w-64">
              <span className="break-all text-right text-sm text-muted-foreground">
                {logging.url}
              </span>
            </SettingsControlRow>
            <SettingsControlRow
              title="ClickHouse schema"
              controlsClassName="sm:min-w-0 sm:max-w-64"
            >
              <span className="break-all text-right text-sm text-muted-foreground">
                {logging.database}.{logging.table}
              </span>
            </SettingsControlRow>
          </>
        )}
      </PanelShell>
      <div className="flex justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-max flex-none"
          onClick={onBack}
          disabled={busy}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button type="button" className="w-max flex-none" onClick={onContinue} pending={busy}>
          <Check className="h-4 w-4" />
          Apply configuration
        </Button>
      </div>
    </section>
  );
}
