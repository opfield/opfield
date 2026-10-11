import { startRegistration } from "@simplewebauthn/browser";
import { Check, KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import { CopyButton } from "@/components/common/CopyButton";
import { CopyValueField } from "@/components/common/CopyValueField";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

type MfaScreen = "method" | "totp" | "recovery" | "complete";
type MfaSetupMode = "onboarding" | "standalone";

function passkeyName(response: unknown): string {
  const attachment = (response as { authenticatorAttachment?: string }).authenticatorAttachment;
  if (attachment !== "platform") return "Security key";
  if (/Macintosh|iPhone|iPad/i.test(navigator.userAgent)) return "iCloud Keychain";
  if (/Windows/i.test(navigator.userAgent)) return "Windows Hello";
  if (/Android/i.test(navigator.userAgent)) return "Android passkey";
  return "This device's passkey";
}

export function MfaSetupWizard({
  open,
  onBack,
  onConfigured,
  onSkipped,
  allowSkip = true,
  mode = "onboarding",
}: {
  open: boolean;
  onBack: () => void;
  onConfigured: () => Promise<void>;
  onSkipped?: () => Promise<void>;
  allowSkip?: boolean;
  /** Standalone setup must not refer to or mutate the finalize-setup checklist. */
  mode?: MfaSetupMode;
}) {
  const [screen, setScreen] = useState<MfaScreen>("method");
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [pendingChoice, setPendingChoice] = useState<"passkey" | "totp" | null>(null);
  const isStandalone = mode === "standalone";

  useEffect(() => {
    if (!open) return;
    setScreen("method");
    setTotp(null);
    setCode("");
    setRecoveryCodes([]);
    setSaving(false);
  }, [open]);

  const startTotp = async () => {
    setPendingChoice("totp");
    setSaving(true);
    try {
      setTotp(await api.beginCurrentUserTotpSetup());
      setScreen("totp");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to start authenticator setup");
    } finally {
      setSaving(false);
    }
  };

  const confirmTotp = async () => {
    if (code.length !== 6) return;
    setSaving(true);
    try {
      setRecoveryCodes(await api.confirmCurrentUserTotpSetup(code));
      setScreen("recovery");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The authentication code is not valid");
    } finally {
      setSaving(false);
    }
  };

  const registerPasskey = async () => {
    setPendingChoice("passkey");
    setSaving(true);
    try {
      const options = await api.beginCurrentUserPasskeyRegistration();
      const response = await startRegistration({ optionsJSON: options as never });
      await api.finishCurrentUserPasskeyRegistration(response, passkeyName(response));
      setScreen("complete");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to add passkey");
    } finally {
      setSaving(false);
    }
  };

  return (
    <FinalizeSetupWizardDialog
      open={open}
      title="Set Up MFA"
      description={
        <>
          <p>
            Multi-factor authentication adds a second proof of identity to this account. It protects
            Gateway even when a password or email sign-in code is exposed.
          </p>
          <p>
            A passkey is the recommended phishing-resistant option. It can live on this device, in a
            password manager, or on a hardware security key. An authenticator app is an alternative
            that generates time-based one-time codes when you sign in.
          </p>
          <p>
            Authenticator-app setup also gives you recovery codes. Store them somewhere safe before
            finishing: each code works once if you lose access to the app. You can add another
            method or manage MFA later from your account settings.
          </p>
        </>
      }
      stepKey={screen}
      onClose={onBack}
      onBack={screen === "totp" ? () => setScreen("method") : undefined}
      backDisabled={saving}
      onSkip={allowSkip && screen !== "complete" && screen !== "recovery" ? onSkipped : undefined}
      skipDisabled={saving}
      footer={
        screen === "totp" ? (
          <Button onClick={() => void confirmTotp()} pending={saving} disabled={code.length !== 6}>
            <Check />
            Activate TOTP
          </Button>
        ) : screen === "recovery" ? (
          <>
            <CopyButton
              value={recoveryCodes.join("\n")}
              label="recovery codes"
              className="rounded-full border border-border bg-background hover:bg-accent hover:text-accent-foreground"
            />
            <Button onClick={() => setScreen("complete")} disabled={saving}>
              <Check /> I saved these codes
            </Button>
          </>
        ) : screen === "complete" ? (
          <Button onClick={() => void onConfigured()} disabled={saving}>
            <Check /> {isStandalone ? "Done" : "Back to checklist"}
          </Button>
        ) : null
      }
    >
      {screen === "method" ? (
        <div className="space-y-3">
          <ChoiceCard
            icon={KeyRound}
            title="Add a passkey"
            description="Use this device, a password manager, or a security key."
            pending={saving && pendingChoice === "passkey"}
            disabled={saving}
            onClick={() => void registerPasskey()}
          />
          <ChoiceCard
            icon={Smartphone}
            title="Authenticator app"
            description="Scan a QR code with any compatible TOTP app."
            pending={saving && pendingChoice === "totp"}
            disabled={saving}
            onClick={() => void startTotp()}
          />
        </div>
      ) : screen === "totp" ? (
        // The screen opens once the setup secret has arrived.
        totp && (
          <div className="space-y-4">
            <div className="flex justify-center bg-qr p-4">
              <QRCodeSVG
                value={totp.uri}
                size={176}
                level="M"
                marginSize={4}
                title="TOTP setup QR code"
              />
            </div>
            <CopyValueField label="Manual setup key" value={totp.secret} />
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Authentication code</span>
              <Input
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                autoFocus
              />
            </label>
          </div>
        )
      ) : screen === "recovery" ? (
        <div className="space-y-4">
          <Notice tone="warning" icon={ShieldCheck} title="Store your recovery codes">
            Each code works once if you lose access to your authenticator app. You must acknowledge
            this step before setup is complete.
          </Notice>
          <div className="grid grid-cols-2 gap-2">
            {recoveryCodes.map((recoveryCode) => (
              <Input key={recoveryCode} value={recoveryCode} readOnly className="font-mono" />
            ))}
          </div>
        </div>
      ) : (
        <FinalizeSetupCompletion
          title="MFA is protecting this account"
          continueIn={
            isStandalone
              ? "Continue in Profile → Security to add another passkey, manage authenticator apps, or regenerate recovery codes."
              : "Continue from your account menu → Security to add another passkey, manage authenticator apps, or regenerate recovery codes."
          }
        >
          Keep your recovery codes safe if you configured an authenticator app; each one can restore
          access once.
        </FinalizeSetupCompletion>
      )}
    </FinalizeSetupWizardDialog>
  );
}
