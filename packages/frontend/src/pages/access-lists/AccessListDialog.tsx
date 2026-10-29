import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus } from "lucide-react";
import { useEffect, useId, useMemo } from "react";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import {
  type CreateFolderChoices,
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { AccessList } from "@/types";
import {
  AccessRulePanel,
  CELL_INPUT,
  ROW,
  ROW_ANIMATION,
  type RuleChoices,
} from "./AccessRulePanel";
import { type AccessListForm, useAccessListForm } from "./access-list-form";
import {
  ADDRESS_PLACEHOLDER,
  sessionLengthLabel,
  signInMethodRows,
  signInMethodTitle,
} from "./access-options";
import { SessionSelect } from "./SessionSelect";
import { useAccessChoices } from "./use-access-choices";

export interface AccessListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The list to edit; `null` creates a new one. */
  accessList: AccessList | null;
  /** Called after a successful save; the dialog keeps its pending state until it settles. */
  onSaved: () => void | Promise<void>;
}

/**
 * Creates or edits an access list: its sign-in methods (with the users of the sign-in form and
 * basic authentication), the addresses that skip sign-in, and the Include / Require / Exclude
 * rules signed-in visitors are checked against.
 */
export function AccessListDialog({
  open,
  onOpenChange,
  accessList,
  onSaved,
}: AccessListDialogProps) {
  const form = useAccessListForm({ open, accessList, onOpenChange, onSaved });
  const scopes = useAuthStore((state) => state.user?.scopes);
  const folders = useResourceFolderStore((state) => state.foldersByType["access-list"]);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType["access-list"]);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  // Same destination rule as the create route: acl:create broadly or on the folder.
  const folderChoices = useMemo(
    () => getCreateFolderChoices(scopes ?? [], "acl:create", folders ?? []),
    [folders, scopes]
  );
  const destinationAllowed = form.isEdit || isCreateFolderAllowed(folderChoices, form.folderId);
  useEffect(() => {
    if (open && !accessList) void fetchFolders("access-list");
  }, [accessList, fetchFolders, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{form.isEdit ? "Edit Access List" : "Create Access List"}</DialogTitle>
        </DialogHeader>

        <AccessListFields
          form={form}
          accessList={accessList}
          folderChoices={folderChoices}
          foldersLoading={foldersLoading}
        />

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={form.save} pending={form.isSaving} disabled={!destinationAllowed}>
            {form.isEdit ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog body; it holds the dialog until providers, users, groups and tokens are in. */
function AccessListFields({
  form,
  accessList,
  folderChoices,
  foldersLoading,
}: {
  form: AccessListForm;
  accessList: AccessList | null;
  folderChoices: CreateFolderChoices;
  foldersLoading: boolean | undefined;
}) {
  const id = useId();
  const choices = useAccessChoices();
  useContentLoading(choices.loading);
  const methodRows = signInMethodRows(choices.providers, form.methods);
  const storedUsernames = new Set((accessList?.users ?? []).map((user) => user.username));
  const ruleChoices: RuleChoices = {
    opfield_user: choices.users ?? [],
    opfield_group: choices.groups ?? [],
    service_token: choices.serviceTokens ?? [],
    method: form.methods.map((key) => ({
      value: key,
      label: signInMethodTitle(key, choices.providers),
    })),
  };
  const defaultLabel =
    choices.defaultSessionTtlSeconds === null
      ? "Default"
      : `Default (${sessionLengthLabel(choices.defaultSessionTtlSeconds)})`;

  return (
    <AnimatedHeight>
      <div className="space-y-6">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">
              Name
            </label>
            <Input
              id={`${id}-name`}
              value={form.name}
              onChange={(event) => form.setName(event.target.value)}
              placeholder="e.g., Office Only"
            />
          </div>
          {!form.isEdit && (
            <div className="space-y-1.5">
              <label htmlFor={`${id}-folder`} className="text-sm font-medium">
                Folder
              </label>
              <CreateFolderSelect
                id={`${id}-folder`}
                choices={folderChoices}
                value={form.folderId}
                onChange={form.setFolderId}
                loading={foldersLoading}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <label htmlFor={`${id}-description`} className="text-sm font-medium">
              Description
            </label>
            <Input
              id={`${id}-description`}
              value={form.description}
              onChange={(event) => form.setDescription(event.target.value)}
              placeholder="Optional description"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-session`} className="text-sm font-medium">
              Stay signed in for
            </label>
            <SessionSelect
              id={`${id}-session`}
              value={form.sessionTtlSeconds}
              onChange={form.setSessionTtlSeconds}
              defaultLabel={defaultLabel}
            />
          </div>
        </div>

        <PanelShell
          title="Sign-in methods"
          description="Visitors pick one of these on the sign-in page."
        >
          <div className="divide-y divide-border">
            {methodRows.map((method) => {
              const enabled = form.methods.includes(method.key);
              return (
                <div key={method.key} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{method.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{method.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {method.key === "shared" && enabled ? (
                      <Input
                        type="password"
                        autoComplete="new-password"
                        aria-label="Shared password"
                        // A stored shared password stays while this is blank.
                        placeholder={
                          accessList?.sharedPasswordSet ? "Keep current password" : "Password"
                        }
                        value={form.sharedPassword}
                        onChange={(event) => form.setSharedPassword(event.target.value)}
                        className="w-44"
                      />
                    ) : null}
                    <Switch
                      checked={enabled}
                      onChange={(checked) => form.setMethod(method.key, checked)}
                      ariaLabel={method.title}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </PanelShell>

        {form.usersShown ? (
          <PanelShell
            title="Users"
            description="Accounts for the sign-in form and basic authentication."
            headerActionsClassName="pl-4"
            actions={
              <Button onClick={form.addUser}>
                <Plus />
                Add user
              </Button>
            }
          >
            {form.users.length > 0 ? (
              <AnimatePresence initial={false}>
                {form.users.map((user, index) => (
                  <motion.div key={user._key} layout {...ROW_ANIMATION} className={ROW}>
                    <Input
                      aria-label={`User ${index + 1} username`}
                      placeholder="Username"
                      value={user.username}
                      onChange={(event) => form.updateUser(index, "username", event.target.value)}
                      className={CELL_INPUT}
                    />
                    <Input
                      type="password"
                      autoComplete="new-password"
                      aria-label={`User ${index + 1} password`}
                      // A stored user keeps its password while this stays blank.
                      placeholder={
                        storedUsernames.has(user.username) ? "Keep current password" : "Password"
                      }
                      value={user.password}
                      onChange={(event) => form.updateUser(index, "password", event.target.value)}
                      className={`${CELL_INPUT} border-l border-border`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-none border-l border-border"
                      aria-label={`Remove user ${index + 1}`}
                      onClick={() => form.removeUser(index)}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </motion.div>
                ))}
              </AnimatePresence>
            ) : null}
          </PanelShell>
        ) : null}

        <PanelShell
          title="Skip sign-in"
          description={
            form.skip.length > 0
              ? "Visitors from these addresses get in without signing in."
              : "No addresses: every visitor signs in."
          }
          headerActionsClassName="pl-4"
          actions={
            <Button onClick={form.addSkip}>
              <Plus />
              Add address
            </Button>
          }
        >
          {form.skip.length > 0 ? (
            <AnimatePresence initial={false}>
              {form.skip.map((address, index) => (
                <motion.div key={address._key} layout {...ROW_ANIMATION} className={ROW}>
                  <Input
                    aria-label={`Skip sign-in address ${index + 1}`}
                    value={address.value}
                    placeholder={ADDRESS_PLACEHOLDER}
                    onChange={(event) => form.updateSkip(index, event.target.value)}
                    className={`${CELL_INPUT} font-mono`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="rounded-none border-l border-border"
                    aria-label={`Remove address ${index + 1}`}
                    onClick={() => form.removeSkip(index)}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                </motion.div>
              ))}
            </AnimatePresence>
          ) : null}
        </PanelShell>

        <AccessRulePanel
          title="Include"
          description="Signed-in visitors who match any of these get in."
          emptyDescription="No rules: nobody gets in by signing in."
          rules={form.rules.include}
          choices={ruleChoices}
          onChange={(rows) => form.setRuleRows("include", rows)}
        />
        <AccessRulePanel
          title="Require"
          description="Visitors must also match every one of these."
          emptyDescription="No rules: Include alone decides."
          rules={form.rules.require}
          choices={ruleChoices}
          onChange={(rows) => form.setRuleRows("require", rows)}
        />
        <AccessRulePanel
          title="Exclude"
          description="Visitors who match any of these never get in."
          emptyDescription="No rules: nobody is turned away by a rule."
          rules={form.rules.exclude}
          choices={ruleChoices}
          onChange={(rows) => form.setRuleRows("exclude", rows)}
        />
      </div>
    </AnimatedHeight>
  );
}
