import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus } from "lucide-react";
import { useId } from "react";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { PanelShell } from "@/components/common/PanelShell";
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
import { SegmentedChoice, type SegmentedChoiceOption } from "@/components/ui/segmented-choice";
import type { AccessList, IPRule } from "@/types";
import { useAccessListForm } from "./access-list-form";

export interface AccessListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The list to edit; `null` creates a new one. */
  accessList: AccessList | null;
  /** Called after a successful save; the dialog keeps its pending state until it settles. */
  onSaved: () => void | Promise<void>;
}

const ROW_ANIMATION = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] as const },
};

const RULE_TYPE_OPTIONS: SegmentedChoiceOption<IPRule["type"]>[] = [
  { value: "allow", label: "Allow", tone: "success" },
  { value: "deny", label: "Deny", tone: "destructive" },
];

const CELL_INPUT =
  "h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * Creates or edits an access list in two sections. IP rules are numbered rows
 * (nginx checks them in order and denies whatever matches none); basic
 * authentication is switched by the checkbox in its section title.
 */
export function AccessListDialog({
  open,
  onOpenChange,
  accessList,
  onSaved,
}: AccessListDialogProps) {
  const form = useAccessListForm({ open, accessList, onOpenChange, onSaved });
  const id = useId();
  const storedUsernames = new Set((accessList?.basicAuthUsers ?? []).map((user) => user.username));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{form.isEdit ? "Edit Access List" : "Create Access List"}</DialogTitle>
          <DialogDescription>
            {form.isEdit
              ? "Update access list settings"
              : "Create a new access list with IP rules and optional basic authentication"}
          </DialogDescription>
        </DialogHeader>

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
            </div>

            <PanelShell
              title="IP rules"
              description={
                form.ipRules.length > 0
                  ? "First match wins; addresses that match no rule are denied."
                  : "No rules: every address can reach the routes that use this list."
              }
              headerActionsClassName="pl-4"
              actions={
                <Button onClick={() => form.addIpRule()}>
                  <Plus />
                  Add rule
                </Button>
              }
            >
              {form.ipRules.length > 0 ? (
                <AnimatePresence initial={false} mode="popLayout">
                  {form.ipRules.map((rule, index) => (
                    <motion.div
                      key={rule._key}
                      layout
                      {...ROW_ANIMATION}
                      className="flex border-b border-border last:border-b-0"
                    >
                      <span className="flex w-10 shrink-0 items-center justify-center border-r border-border font-mono text-xs text-muted-foreground tabular-nums">
                        {index + 1}
                      </span>
                      <SegmentedChoice
                        flush
                        aria-label={`Rule ${index + 1} action`}
                        value={rule.type}
                        options={RULE_TYPE_OPTIONS}
                        onChange={(type) => form.updateIpRule(index, "type", type)}
                      />
                      <Input
                        aria-label={`Rule ${index + 1} address`}
                        value={rule.value}
                        onChange={(event) => form.updateIpRule(index, "value", event.target.value)}
                        className={`${CELL_INPUT} border-l border-border font-mono`}
                        placeholder="203.0.113.0/24, 192.0.2.10 or all"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-none border-l border-border"
                        aria-label={`Remove IP rule ${index + 1}`}
                        onClick={() => form.removeIpRule(index)}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              ) : null}
            </PanelShell>

            <PanelShell
              title={
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="form-checkbox shrink-0"
                    checked={form.basicAuthEnabled}
                    onChange={(event) => form.setBasicAuthEnabled(event.target.checked)}
                  />
                  Basic authentication
                </label>
              }
              description="Visitors also sign in with a username and password."
              headerActionsClassName="pl-4"
              actions={
                form.basicAuthEnabled ? (
                  <Button onClick={() => form.addBasicAuthUser()}>
                    <Plus />
                    Add user
                  </Button>
                ) : null
              }
            >
              {form.basicAuthEnabled && form.basicAuthUsers.length > 0 ? (
                <AnimatePresence initial={false} mode="popLayout">
                  {form.basicAuthUsers.map((user, index) => (
                    <motion.div
                      key={user._key}
                      layout
                      {...ROW_ANIMATION}
                      className="flex border-b border-border last:border-b-0"
                    >
                      <Input
                        aria-label={`Auth user ${index + 1} username`}
                        placeholder="Username"
                        value={user.username}
                        onChange={(event) =>
                          form.updateBasicAuthUser(index, "username", event.target.value)
                        }
                        className={CELL_INPUT}
                      />
                      <Input
                        type="password"
                        autoComplete="new-password"
                        aria-label={`Auth user ${index + 1} password`}
                        // A stored user keeps its password while this stays blank.
                        placeholder={
                          storedUsernames.has(user.username) ? "Keep current password" : "Password"
                        }
                        value={user.password}
                        onChange={(event) =>
                          form.updateBasicAuthUser(index, "password", event.target.value)
                        }
                        className={`${CELL_INPUT} border-l border-border`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-none border-l border-border"
                        aria-label={`Remove auth user ${index + 1}`}
                        onClick={() => form.removeBasicAuthUser(index)}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              ) : null}
            </PanelShell>
          </div>
        </AnimatedHeight>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={form.save} pending={form.isSaving}>
            {form.isEdit ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
