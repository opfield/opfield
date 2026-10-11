import { Check, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
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
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { PermissionGroup } from "@/types";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

type InviteMethod = "password" | "email_otp";

const METHOD_DETAILS: Record<InviteMethod, { label: string; description: string }> = {
  password: {
    label: "Email and password",
    description: "Opfield sends a one-time email link so the user can set their password.",
  },
  email_otp: {
    label: "Email code",
    description: "The user signs in using a one-time code sent to their email address.",
  },
};

export function InviteUsersSetupWizard({
  open,
  methods,
  onBack,
  onConfigured,
  onSkipped,
}: {
  open: boolean;
  methods: { password: boolean; emailOtp: boolean };
  onBack: () => void;
  onConfigured: () => Promise<void>;
  onSkipped: () => Promise<void>;
}) {
  const availableMethods = useMemo<InviteMethod[]>(
    () => [
      ...(methods.password ? (["password"] as const) : []),
      ...(methods.emailOtp ? (["email_otp"] as const) : []),
    ],
    [methods.emailOtp, methods.password]
  );
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [method, setMethod] = useState<InviteMethod>(availableMethods[0] ?? "password");
  const [groupId, setGroupId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(false);
  // The groups load as the wizard opens; mark them loading in that very render
  // so the dialog waits for them instead of filling the group picker later.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setLoading(true);
  }

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setName("");
    setMethod(availableMethods[0] ?? "password");
    setGroupId("");
    setCompleted(false);
    setSaving(false);
    setLoading(true);
    api
      .listGroups()
      .then((nextGroups) => {
        setGroups(nextGroups);
        const defaultGroup =
          nextGroups.find((group) => group.name === "viewer") ??
          nextGroups.find((group) => !group.isBuiltin) ??
          nextGroups[0];
        setGroupId(defaultGroup?.id ?? "");
      })
      .catch((cause) =>
        toast.error(cause instanceof Error ? cause.message : "Failed to load groups")
      )
      .finally(() => setLoading(false));
  }, [availableMethods, open]);

  const invite = async () => {
    if (!email.trim() || !name.trim() || !groupId || !availableMethods.includes(method)) return;
    setSaving(true);
    try {
      await api.createUser({
        email: email.trim(),
        name: name.trim(),
        groupId,
        authMethod: method,
      });
      setCompleted(true);
    } catch (cause) {
      if (!handleLicenseApiError(cause, "Users")) {
        toast.error(cause instanceof Error ? cause.message : "Failed to invite user");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <FinalizeSetupWizardDialog
      open={open}
      title="Invite Users"
      description={
        <>
          <p>
            Opfield is most useful when the people who operate the infrastructure have their own
            accounts and only the access they need. This step creates one additional user and puts
            them in a permission group from the start.
          </p>
          <p>
            Choose a local sign-in method that you enabled during setup. Password accounts receive a
            secure setup link by email; email-code accounts sign in with a one-time code. OIDC users
            can be created later after their identity-provider account exists.
          </p>
          <p>
            This invitation is optional. You can invite more people, change their group, or suspend
            an account later from Administration → Users.
          </p>
        </>
      }
      stepKey={completed ? "complete" : "invite"}
      onBack={completed ? undefined : onBack}
      onSkip={completed ? undefined : onSkipped}
      skipDisabled={loading || saving}
      footer={
        completed ? (
          <Button onClick={() => void onConfigured()} disabled={saving}>
            <Check /> Back to checklist
          </Button>
        ) : (
          <Button
            onClick={() => void invite()}
            pending={saving}
            disabled={loading || !email.trim() || !name.trim() || !groupId}
          >
            <UserPlus /> Invite user
          </Button>
        )
      }
    >
      <ContentLoading loading={loading && !completed} />
      {completed ? (
        <FinalizeSetupCompletion
          title="User invited"
          continueIn="Continue from Administration → Users to invite people, assign groups, and review account access."
        >
          {method === "password"
            ? `Opfield created the account and emailed a password setup link to ${email.trim()}.`
            : `Opfield created the account for ${email.trim()}. They can sign in with their email address and receive a one-time code.`}
        </FinalizeSetupCompletion>
      ) : (
        <PanelShell
          title="New user"
          description="The invitation applies the selected group before the user signs in."
        >
          <SettingsControlRow title="Full name" description="Shown in activity and access records.">
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </SettingsControlRow>
          <SettingsControlRow
            title="Email"
            description={
              method === "password"
                ? "Where Opfield sends the password setup link."
                : "Used for this account and for one-time sign-in codes."
            }
          >
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="operator@example.com"
            />
          </SettingsControlRow>
          {availableMethods.length > 1 && (
            <SettingsControlRow
              title="Sign-in method"
              description={METHOD_DETAILS[method].description}
            >
              <Select value={method} onValueChange={(value) => setMethod(value as InviteMethod)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableMethods.map((item) => (
                    <SelectItem key={item} value={item}>
                      {METHOD_DETAILS[item].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsControlRow>
          )}
          <SettingsControlRow
            title="Permission group"
            description="Defines what this user can view and change."
          >
            <Select value={groupId} onValueChange={setGroupId} disabled={loading}>
              <SelectTrigger>
                <SelectValue placeholder="Select group" />
              </SelectTrigger>
              <SelectContent>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
        </PanelShell>
      )}
    </FinalizeSetupWizardDialog>
  );
}
