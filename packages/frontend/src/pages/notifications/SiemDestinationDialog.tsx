import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { SwitchCard } from "@/components/common/SwitchCard";
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
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { SiemAuthType, SiemDestination } from "@/types";

const FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export function SiemDestinationDialog({
  open,
  onOpenChange,
  destination,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destination: SiemDestination | null;
  onSaved: () => void;
}) {
  const isEdit = !!destination;
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<SiemAuthType>("bearer");
  const [customHeaderName, setCustomHeaderName] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [secretError, setSecretError] = useState<string | null>(null);
  // The stored credential was issued for the saved endpoint, so the backend never forwards it
  // to a new URL implicitly.
  const urlChanged = isEdit && url.trim() !== destination.url;
  const secretPlaceholder = !isEdit
    ? "Required"
    : urlChanged
      ? "Required when the endpoint changes"
      : authType !== destination.authType
        ? "Required when the authentication changes"
        : "Leave blank to keep current";

  useEffect(() => {
    if (!open) return;
    setName(destination?.name ?? "");
    setUrl(destination?.url ?? "");
    setAuthType(destination?.authType ?? "bearer");
    setCustomHeaderName(destination?.customHeaderName ?? "");
    setSecret("");
    setSecretError(null);
    setEnabled(destination?.enabled ?? true);
  }, [destination, open]);

  const changeUrl = (value: string) => {
    setUrl(value);
    setSecretError(null);
  };

  const changeSecret = (value: string) => {
    setSecret(value);
    if (value) setSecretError(null);
  };

  const validateUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        Boolean(parsed.hostname) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  };

  const save = async () => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    const trimmedCustomHeaderName = customHeaderName.trim();
    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }
    if (!validateUrl(trimmedUrl)) {
      toast.error("Use an HTTPS URL without credentials, query parameters, or fragments");
      return;
    }
    if (authType === "custom_header" && !trimmedCustomHeaderName) {
      toast.error("Custom header name is required");
      return;
    }
    if (!isEdit && !secret) {
      setSecretError("Authentication secret is required");
      return;
    }
    if (isEdit && authType !== destination.authType && !secret) {
      setSecretError("Provide a new secret when changing authentication type");
      return;
    }
    if (isEdit && trimmedUrl !== destination.url && !secret) {
      setSecretError("Re-enter the secret when changing the destination URL");
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await api.updateSiemDestination(destination.id, {
          name: trimmedName,
          url: trimmedUrl,
          authType,
          ...(authType === "custom_header" ? { customHeaderName: trimmedCustomHeaderName } : {}),
          enabled,
          ...(secret ? { secret } : {}),
        });
        toast.success("SIEM destination updated");
      } else {
        await api.createSiemDestination({
          name: trimmedName,
          url: trimmedUrl,
          authType,
          ...(authType === "custom_header" ? { customHeaderName: trimmedCustomHeaderName } : {}),
          secret,
          enabled,
        });
        toast.success("SIEM destination created");
      }
      onOpenChange(false);
      onSaved();
    } catch (error) {
      setSaving(false);
      if (error instanceof ApiRequestError && error.code === "SIEM_SECRET_REQUIRED") {
        setSecretError(error.message);
        return;
      }
      if (!handleLicenseApiError(error, "SIEM destinations")) {
        toastApiError(error, "Failed to save SIEM destination");
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit SIEM Destination" : "New SIEM Destination"}</DialogTitle>
          <DialogDescription>
            Opfield sends privacy-reduced audit events to this HTTPS collector.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="siem-name">
              Name
            </label>
            <Input
              id="siem-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Security operations"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="siem-url">
              HTTPS endpoint
            </label>
            <Input
              id="siem-url"
              type="url"
              value={url}
              onChange={(event) => changeUrl(event.target.value)}
              placeholder="https://siem.example.com/opfield/audit"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              No credentials, query parameters, or URL fragments.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Authentication</label>
            <Select value={authType} onValueChange={(value) => setAuthType(value as SiemAuthType)}>
              <SelectTrigger aria-label="Authentication method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="hmac_sha256">HMAC-SHA256</SelectItem>
                <SelectItem value="custom_header">Custom header</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <AnimatedHeight>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={authType} {...FORM_ANIMATION} className="space-y-4">
                {authType === "custom_header" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="siem-custom-header-name">
                        Custom header
                      </label>
                      <Input
                        id="siem-custom-header-name"
                        value={customHeaderName}
                        onChange={(event) => setCustomHeaderName(event.target.value)}
                        placeholder="X-API-Key"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="siem-secret">
                        Header value
                      </label>
                      <Input
                        id="siem-secret"
                        type="password"
                        value={secret}
                        onChange={(event) => changeSecret(event.target.value)}
                        placeholder={secretPlaceholder}
                        autoComplete="new-password"
                        aria-invalid={secretError ? true : undefined}
                        aria-describedby={secretError ? "siem-secret-error" : undefined}
                      />
                      <SecretError message={secretError} />
                      <p className="text-xs text-muted-foreground">
                        Opfield sends this header with every request. Opfield transport headers
                        cannot be overridden.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="siem-secret">
                      {authType === "bearer" ? "Bearer token" : "HMAC secret"}
                    </label>
                    <Input
                      id="siem-secret"
                      type="password"
                      value={secret}
                      onChange={(event) => changeSecret(event.target.value)}
                      placeholder={secretPlaceholder}
                      autoComplete="new-password"
                      aria-invalid={secretError ? true : undefined}
                      aria-describedby={secretError ? "siem-secret-error" : undefined}
                    />
                    <SecretError message={secretError} />
                    {authType === "hmac_sha256" && (
                      <p className="text-xs text-muted-foreground">
                        Opfield sends <code>X-Gateway-Timestamp</code> and signs it with the raw
                        JSON body in <code>X-Gateway-Signature-256</code>.
                      </p>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </AnimatedHeight>
          <div className="pt-4">
            <SwitchCard
              label="Delivery enabled"
              description="Disabled destinations keep their queued events paused until re-enabled."
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Secrets are encrypted at rest and cannot be viewed again. Full audit details and
            collector response bodies are not exported.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} pending={saving}>
            {isEdit ? "Save Changes" : "Create Destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p id="siem-secret-error" role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}
