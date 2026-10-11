import { Check, Lock, Mail, RotateCcw, Save, ShieldAlert, Trash2, Unlock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AdminUserInvitationRow } from "@/components/admin/AdminUserInvitationRow";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getInitials } from "@/lib/utils";
import { api } from "@/services/api";
import type { BrowserSession, User } from "@/types";

type LocalAuthMethod = "password" | "email_otp" | "oidc";

/** The session count; the dialog opens once it is known. */
function ActiveSessionsSummary({
  loading,
  count,
  onOpen,
}: {
  loading: boolean;
  count: number;
  onOpen: () => void;
}) {
  useContentLoading(loading);
  if (loading) return null;
  if (count === 0) return <span className="text-sm text-muted-foreground">No active sessions</span>;
  return (
    <Button variant="link" className="h-auto p-0" onClick={onOpen}>
      {count} active session{count === 1 ? "" : "s"}
    </Button>
  );
}

export function AdminUserConfigDialog({
  open,
  user,
  canResetMfa,
  onOpenChange,
  onUserUpdated,
  onUserDeleted,
}: {
  open: boolean;
  user: User | null;
  canResetMfa: boolean;
  onOpenChange: (open: boolean) => void;
  onUserUpdated: (user: User) => void;
  onUserDeleted: (user: User) => void;
}) {
  const [name, setName] = useState("");
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  // The user whose sessions this opening has loaded. Later reloads update in place.
  const [sessionsLoadedFor, setSessionsLoadedFor] = useState<string | null>(null);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
  // The action whose request runs; every action is disabled meanwhile.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const saving = busyAction !== null;
  const [nameSaved, setNameSaved] = useState(false);
  const [passwordLinkCoolingDown, setPasswordLinkCoolingDown] = useState(false);
  const nameSavedTimer = useRef<number | null>(null);
  const passwordLinkCooldownTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (nameSavedTimer.current !== null) window.clearTimeout(nameSavedTimer.current);
      if (passwordLinkCooldownTimer.current !== null)
        window.clearTimeout(passwordLinkCooldownTimer.current);
    },
    []
  );

  // Reset while rendering the opening, so its first frame already waits for the sessions.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSessions([]);
      setSessionsLoadedFor(null);
    }
  }

  useEffect(() => {
    if (!open || !user) return;
    setName(user.name ?? user.email);
    setSessionsDialogOpen(false);
    let active = true;
    void api
      .listAdminUserSessions(user.id)
      .then((result) => {
        if (active) setSessions(result);
      })
      .catch((error) => {
        if (active)
          toast.error(error instanceof Error ? error.message : "Failed to load active sessions");
      })
      .finally(() => {
        if (active) setSessionsLoadedFor(user.id);
      });
    return () => {
      active = false;
    };
  }, [open, user]);

  if (!user) return null;

  const sessionsLoading = sessionsLoadedFor !== user.id;
  const isBusy = (action: string) => busyAction === action;

  const authMethod = (user.authMethod ?? "oidc") as LocalAuthMethod;
  const isOidc = authMethod === "oidc";

  const run = async (action: string, task: () => Promise<void>) => {
    setBusyAction(action);
    try {
      await task();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update user");
    } finally {
      setBusyAction(null);
    }
  };

  const saveName = () =>
    run("name", async () => {
      const updated = await api.updateUserName(user.id, name.trim());
      onUserUpdated(updated);
      setNameSaved(true);
      if (nameSavedTimer.current !== null) window.clearTimeout(nameSavedTimer.current);
      nameSavedTimer.current = window.setTimeout(() => {
        setNameSaved(false);
        nameSavedTimer.current = null;
      }, 2000);
      toast.success("User name updated");
    });

  const toggleBlock = () =>
    run("block", async () => {
      const blocked = !user.isBlocked;
      await api.blockUser(user.id, blocked);
      onUserUpdated({ ...user, isBlocked: blocked });
      toast.success(blocked ? "User blocked" : "User unblocked");
    });

  const changeAuthMethod = async (nextMethod: LocalAuthMethod) => {
    if (nextMethod === authMethod) return;
    const accepted = await confirm({
      title: "Change Sign-In Method",
      description:
        nextMethod === "password"
          ? "Existing browser sessions will be revoked and the user will receive a password-setup link."
          : "Existing browser sessions will be revoked.",
      confirmLabel: "Change method",
    });
    if (!accepted) return;
    await run("auth-method", async () => {
      const updated = await api.updateUserAuthMethod(user.id, nextMethod);
      onUserUpdated(updated);
      setSessions([]);
      toast.success("Sign-in method updated");
    });
  };

  const sendPasswordLink = () =>
    run("password-link", async () => {
      const result = await api.sendUserPasswordLink(user.id);
      toast.success(
        result.purpose === "password_setup"
          ? "Password setup link sent"
          : "Password reset link sent"
      );
      setPasswordLinkCoolingDown(true);
      if (passwordLinkCooldownTimer.current !== null)
        window.clearTimeout(passwordLinkCooldownTimer.current);
      passwordLinkCooldownTimer.current = window.setTimeout(() => {
        setPasswordLinkCoolingDown(false);
        passwordLinkCooldownTimer.current = null;
      }, 5000);
    });

  const sendInvitation = () =>
    run("invitation", async () => {
      onUserUpdated(await api.sendUserInvitation(user.id));
      toast.success("Invitation email sent");
    });

  const revokeSession = (sessionId: string) =>
    run(`session:${sessionId}`, async () => {
      await api.revokeAdminUserSession(user.id, sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      toast.success("Session revoked");
    });

  const revokeAllSessions = () =>
    run("sessions", async () => {
      await api.revokeAllAdminUserSessions(user.id);
      setSessions([]);
      toast.success("All browser sessions revoked");
    });

  const resetMfa = async () => {
    const accepted = await confirm({
      title: "Reset MFA",
      description:
        "This removes the user's Gateway TOTP, passkeys, recovery codes, and browser sessions.",
      confirmLabel: "Reset MFA",
      variant: "destructive",
    });
    if (!accepted) return;
    await run("mfa", async () => {
      await api.resetAdminUserMfa(user.id);
      setSessions([]);
      toast.success("MFA reset");
    });
  };

  const deleteUser = async () => {
    const accepted = await confirm({
      title: "Delete User",
      description: `Delete "${user.name || user.email}"? Their access and tokens will be revoked. Only a system administrator can restore them.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!accepted) return;
    await run("delete", async () => {
      await api.deleteUser(user.id);
      setSessionsDialogOpen(false);
      onOpenChange(false);
      onUserDeleted(user);
      toast.success("User deleted");
    });
  };

  const resetAvatar = async () => {
    const accepted = await confirm({
      title: "Reset Avatar",
      description: `Remove the current avatar for "${user.name || user.email}"? An identity provider may restore its avatar the next time the user signs in.`,
      confirmLabel: "Reset",
      variant: "destructive",
    });
    if (!accepted) return;
    await run("avatar", async () => {
      const updated = await api.resetUserAvatar(user.id);
      onUserUpdated(updated);
      toast.success("Avatar reset");
    });
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setSessionsDialogOpen(false);
            setPasswordLinkCoolingDown(false);
            if (passwordLinkCooldownTimer.current !== null) {
              window.clearTimeout(passwordLinkCooldownTimer.current);
              passwordLinkCooldownTimer.current = null;
            }
          }
          onOpenChange(nextOpen);
        }}
      >
        <DialogContent aria-describedby={undefined} className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Configure User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <PanelShell title="Account" bodyClassName="divide-y divide-border">
              <section className="flex items-center gap-4 px-4 py-3">
                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarImage src={user.avatarUrl ?? undefined} />
                  <AvatarFallback className="text-sm">
                    {getInitials(user.name || user.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{user.name || user.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                </div>
                <Badge variant="secondary" size="inline" className="shrink-0">
                  {user.groupNames?.join(", ") ?? user.groupName}
                </Badge>
              </section>

              <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <p className="text-sm font-medium">Avatar</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Remove the current image. OIDC may restore the provider avatar at next sign-in.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void resetAvatar()}
                  pending={isBusy("avatar")}
                  disabled={saving || !user.avatarUrl}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset avatar
                </Button>
              </section>

              {!isOidc && (
                <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div>
                    <p className="text-sm font-medium">Name</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Used throughout Gateway.</p>
                  </div>
                  <div className="flex w-full border border-input bg-background sm:w-72 sm:shrink-0">
                    <Input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setNameSaved(false);
                      }}
                      maxLength={255}
                      className="border-0 bg-transparent focus-visible:ring-0"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={saveName}
                      disabled={saving || !name.trim() || name.trim() === user.name}
                      aria-label={nameSaved ? "Name saved" : "Save name"}
                      title={nameSaved ? "Saved" : "Save name"}
                      className="relative shrink-0 rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Check
                        className={`absolute h-4 w-4 transition-all duration-200 ${nameSaved ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
                      />
                      <Save
                        className={`h-4 w-4 transition-all duration-200 ${nameSaved ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
                      />
                    </Button>
                  </div>
                </section>
              )}

              <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <p className="text-sm font-medium">Sign-in method</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Changing it signs the user out everywhere.
                  </p>
                </div>
                <Select
                  value={authMethod}
                  onValueChange={(value) => void changeAuthMethod(value as LocalAuthMethod)}
                >
                  <SelectTrigger className="w-full sm:w-48" disabled={saving}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oidc">OIDC</SelectItem>
                    <SelectItem value="password">Email and password</SelectItem>
                    <SelectItem value="email_otp">Email code</SelectItem>
                  </SelectContent>
                </Select>
              </section>

              {authMethod === "password" && (
                <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div>
                    <p className="text-sm font-medium">Password email</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Sends setup before the first sign-in, otherwise a reset link.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={sendPasswordLink}
                    pending={isBusy("password-link")}
                    disabled={saving || passwordLinkCoolingDown}
                  >
                    <Mail /> Send link
                  </Button>
                </section>
              )}

              <AdminUserInvitationRow
                user={user}
                pending={isBusy("invitation")}
                disabled={saving}
                onSend={sendInvitation}
              />

              <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <p className="text-sm font-medium">Active sessions</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Browser sessions currently authorized for this account.
                  </p>
                </div>
                <div className="shrink-0">
                  <ActiveSessionsSummary
                    loading={sessionsLoading}
                    count={sessions.length}
                    onOpen={() => setSessionsDialogOpen(true)}
                  />
                </div>
              </section>

              {canResetMfa && !isOidc && (
                <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div>
                    <p className="text-sm font-medium">Multi-factor authentication</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Removes Gateway MFA factors and signs the user out everywhere.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => void resetMfa()}
                    pending={isBusy("mfa")}
                    disabled={saving}
                  >
                    <ShieldAlert /> Reset MFA
                  </Button>
                </section>
              )}
            </PanelShell>

            <PanelShell
              title="Destructive actions"
              description="These actions can revoke access or remove the account."
              bodyClassName="divide-y divide-border"
            >
              <section className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Account status</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {user.isBlocked ? "The account cannot sign in." : "The account can sign in."}
                  </p>
                </div>
                <Button
                  variant={user.isBlocked ? "outline" : "destructive"}
                  onClick={toggleBlock}
                  pending={isBusy("block")}
                  disabled={saving}
                >
                  {isBusy("block") ? null : user.isBlocked ? <Unlock /> : <Lock />}
                  {user.isBlocked ? "Unblock user" : "Block user"}
                </Button>
              </section>
              <section className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Delete user</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Revokes access and keeps a restorable audit record.
                  </p>
                </div>
                <Button
                  variant="destructive"
                  onClick={() => void deleteUser()}
                  pending={isBusy("delete")}
                  disabled={saving}
                >
                  <Trash2 />
                  Delete user
                </Button>
              </section>
            </PanelShell>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sessionsDialogOpen} onOpenChange={setSessionsDialogOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Active Sessions</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Browser sessions currently authorized for this account.
          </p>
          <div className="border border-border">
            <div className="max-h-[min(25rem,48dvh)] divide-y divide-border overflow-y-auto overscroll-contain">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {session.userAgent || "Unknown browser"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {session.authMethod.replace("_", " ")} · {session.ipAddress || "Unknown IP"} ·
                      Last active <RelativeTime value={session.lastSeenAt} />
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => revokeSession(session.id)}
                    pending={isBusy(`session:${session.id}`)}
                    disabled={saving}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={revokeAllSessions}
              pending={isBusy("sessions")}
              disabled={saving || sessions.length === 0}
            >
              Revoke all
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
