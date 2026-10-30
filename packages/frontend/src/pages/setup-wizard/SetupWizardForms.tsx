import { ArrowLeft, ArrowRight } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { applySmtpPreset, SMTP_PRESETS, type SmtpPresetId } from "../settings/smtp-presets";
import {
  isOidcDraftValid,
  isPublicUrlValid,
  isSmtpDraftValid,
  type OidcDraft,
  type SetupSmtpDraft,
} from "./setup-wizard-model";

interface NavigationProps {
  busy: boolean;
  onBack?: () => void;
  onContinue: () => void;
}

export function PublicUrlStep({
  busy,
  publicUrl,
  setPublicUrl,
  onContinue,
}: NavigationProps & { publicUrl: string; setPublicUrl: (value: string) => void }) {
  return (
    <section className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Public URL</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the canonical URL people and identity providers will use. Opfield will not infer it
          from the browser address.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <Input
          type="url"
          required
          value={publicUrl}
          placeholder="https://opfield.example.com"
          onChange={(event) => setPublicUrl(event.target.value)}
        />
        <div className="flex justify-center">
          <Button type="submit" pending={busy} disabled={!isPublicUrlValid(publicUrl)}>
            <ArrowRight className="h-4 w-4" />
            Continue
          </Button>
        </div>
      </form>
    </section>
  );
}

export function OidcConfigStep({
  alreadyConfigured,
  busy,
  oidc,
  setOidc,
  onBack,
  onContinue,
}: NavigationProps & {
  alreadyConfigured: boolean;
  oidc: OidcDraft;
  setOidc: Dispatch<SetStateAction<OidcDraft>>;
}) {
  return (
    <section className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Configure OIDC</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect Opfield to your OpenID Connect identity provider.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <Input
          required
          type="url"
          placeholder="Issuer URL"
          value={oidc.issuer}
          onChange={(event) => setOidc((value) => ({ ...value, issuer: event.target.value }))}
        />
        <Input
          required
          placeholder="Client ID"
          value={oidc.clientId}
          onChange={(event) => setOidc((value) => ({ ...value, clientId: event.target.value }))}
        />
        <Input
          required={!alreadyConfigured}
          type="password"
          placeholder={alreadyConfigured ? "Client secret (unchanged)" : "Client secret"}
          value={oidc.clientSecret}
          onChange={(event) => setOidc((value) => ({ ...value, clientSecret: event.target.value }))}
        />
        <Input
          required
          type="url"
          placeholder="Redirect URI"
          value={oidc.redirectUri}
          onChange={(event) => setOidc((value) => ({ ...value, redirectUri: event.target.value }))}
        />
        <Input
          required
          placeholder="Scopes"
          value={oidc.scopes}
          onChange={(event) => setOidc((value) => ({ ...value, scopes: event.target.value }))}
        />
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
            disabled={!isOidcDraftValid(oidc, alreadyConfigured)}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}

export function SmtpConfigStep({
  alreadyConfigured,
  busy,
  preset,
  setPreset,
  smtp,
  setSmtp,
  onBack,
  onContinue,
}: NavigationProps & {
  alreadyConfigured: boolean;
  preset: SmtpPresetId;
  setPreset: (value: SmtpPresetId) => void;
  smtp: SetupSmtpDraft;
  setSmtp: Dispatch<SetStateAction<SetupSmtpDraft>>;
}) {
  const selectedPreset = SMTP_PRESETS[preset];
  const usesProviderPreset = preset !== "generic";
  const showsUsername = !usesProviderPreset || preset === "postmark";
  const applyPreset = (nextPreset: SmtpPresetId) => {
    setPreset(nextPreset);
    setSmtp((current) => applySmtpPreset(current, nextPreset));
  };

  return (
    <section className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Configure email delivery</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Opfield will verify the SMTP connection when you apply the setup configuration.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <div className="space-y-1.5 text-left">
          <label htmlFor="setup-smtp-provider" className="text-sm font-medium">
            Email provider
          </label>
          <Select value={preset} onValueChange={(value) => applyPreset(value as SmtpPresetId)}>
            <SelectTrigger id="setup-smtp-provider" aria-label="SMTP provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SMTP_PRESETS).map(([id, item]) => (
                <SelectItem key={id} value={id} description={item.description}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{selectedPreset.description}</p>
        </div>
        {!usesProviderPreset && (
          <>
            <Input
              required
              aria-label="SMTP host"
              placeholder="SMTP host"
              value={smtp.host}
              onChange={(event) => setSmtp((value) => ({ ...value, host: event.target.value }))}
            />
            <Input
              required
              aria-label="SMTP port"
              type="number"
              min={1}
              max={65535}
              placeholder="Port"
              value={smtp.port}
              onChange={(event) => setSmtp((value) => ({ ...value, port: event.target.value }))}
            />
          </>
        )}
        {showsUsername && (
          <Input
            required
            aria-label="SMTP username"
            placeholder="Username"
            value={smtp.username}
            onChange={(event) => setSmtp((value) => ({ ...value, username: event.target.value }))}
          />
        )}
        <Input
          required={!alreadyConfigured}
          aria-label="SMTP password"
          type="password"
          placeholder={alreadyConfigured ? "Password (unchanged)" : "Password or API key"}
          value={smtp.password}
          onChange={(event) => setSmtp((value) => ({ ...value, password: event.target.value }))}
        />
        {!usesProviderPreset && (
          <div className="flex gap-2">
            {(["starttls", "tls"] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                className="flex-1"
                variant={smtp.tlsMode === mode ? "default" : "outline"}
                onClick={() => setSmtp((value) => ({ ...value, tlsMode: mode }))}
              >
                {mode === "starttls" ? "STARTTLS" : "TLS"}
              </Button>
            ))}
          </div>
        )}
        <Input
          required
          placeholder="Sender name"
          value={smtp.senderName}
          onChange={(event) => setSmtp((value) => ({ ...value, senderName: event.target.value }))}
        />
        <Input
          required
          type="email"
          placeholder="Sender email"
          value={smtp.senderEmail}
          onChange={(event) => setSmtp((value) => ({ ...value, senderEmail: event.target.value }))}
        />
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
            disabled={!isSmtpDraftValid(smtp, preset, alreadyConfigured)}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}
