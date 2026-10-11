import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { User } from "@/types";

/**
 * The one-time account invitation email, offered while the user has never
 * signed in. Once sent, the action gives way to when it was sent.
 */
export function AdminUserInvitationRow({
  user,
  pending,
  disabled,
  onSend,
}: {
  user: User;
  pending: boolean;
  disabled: boolean;
  onSend: () => void;
}) {
  const canReadSettings = useAuthStore((state) => state.hasScope("settings:gateway:view"));
  const invitable = !user.invitationSentAt && user.lastLoginAt === null;
  const checkSmtp = invitable && canReadSettings;
  // undefined while loading; null when unknown, and the server still enforces it.
  const [smtpVerified, setSmtpVerified] = useState<boolean | null | undefined>(undefined);

  useEffect(() => {
    if (!checkSmtp) return;
    let active = true;
    void api
      .getAuthProvisioningSettings()
      .then((settings) => {
        if (active) setSmtpVerified(Boolean(settings.smtp?.verifiedAt));
      })
      .catch(() => {
        if (active) setSmtpVerified(null);
      });
    return () => {
      active = false;
    };
  }, [checkSmtp]);

  useContentLoading(checkSmtp && smtpVerified === undefined);

  if (!user.invitationSentAt && !invitable) return null;
  const smtpMissing = checkSmtp && smtpVerified === false;

  return (
    <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div>
        <p className="text-sm font-medium">Invitation email</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {user.invitationSentAt
            ? "Told the user their Opfield account was created."
            : smtpMissing
              ? "Sending requires verified SMTP."
              : "Tells the user their Opfield account was created. Available once, before the first sign-in."}
        </p>
      </div>
      {user.invitationSentAt ? (
        <span className="shrink-0 text-sm text-muted-foreground">
          Invitation sent <RelativeTime value={user.invitationSentAt} />
        </span>
      ) : (
        <Button
          variant="outline"
          onClick={onSend}
          pending={pending}
          disabled={disabled || smtpMissing}
        >
          <Mail /> Send invitation email
        </Button>
      )}
    </section>
  );
}
