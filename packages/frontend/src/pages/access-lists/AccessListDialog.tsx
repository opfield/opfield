import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, GripVertical, Minus, Plus } from "lucide-react";
import { useId, useMemo } from "react";
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
import { Switch } from "@/components/ui/switch";
import type { AccessList, IPRule } from "@/types";
import { type IPRuleInput, useAccessListForm } from "./access-list-form";
import { type AccessListIpRuleWarning, analyzeAccessListIpRules } from "./ip-rule-analysis";

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

// A sortable row takes its transform from dnd-kit, so it fades only and never slides through framer's `y`.
const SORTABLE_ROW_TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] as const };

const RULE_TYPE_OPTIONS: SegmentedChoiceOption<IPRule["type"]>[] = [
  { value: "allow", label: "Allow", tone: "success" },
  { value: "deny", label: "Deny", tone: "destructive" },
];

const CELL_INPUT =
  "h-9 min-w-0 flex-1 rounded-none border-0 bg-background shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * Creates or edits an access list in two sections. IP rules are numbered rows
 * (nginx checks them in order and denies whatever matches none) that are
 * reordered by their drag handle, by pointer or keyboard; a rule that cannot
 * change the outcome carries a warning. Basic authentication is switched by
 * the checkbox in its section title.
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
  const ruleWarnings = useMemo(() => {
    const byIndex = new Map<number, AccessListIpRuleWarning>();
    for (const warning of analyzeAccessListIpRules(form.ipRules))
      byIndex.set(warning.index, warning);
    return byIndex;
  }, [form.ipRules]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const reorderRules = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const fromIndex = form.ipRules.findIndex((rule) => rule._key === active.id);
    const toIndex = form.ipRules.findIndex((rule) => rule._key === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    form.moveIpRule(fromIndex, toIndex);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{form.isEdit ? "Edit Access List" : "Create Access List"}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {form.isEdit
            ? "Update access list settings"
            : "Create a new access list with IP rules and optional basic authentication"}
        </DialogDescription>

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
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={reorderRules}
                >
                  <SortableContext
                    items={form.ipRules.map((rule) => rule._key)}
                    strategy={verticalListSortingStrategy}
                  >
                    <AnimatePresence initial={false}>
                      {form.ipRules.map((rule, index) => (
                        <SortableIpRuleRow
                          key={rule._key}
                          rule={rule}
                          index={index}
                          warning={ruleWarnings.get(index)}
                          warningId={`${id}-rule-${rule._key}-warning`}
                          onChange={form.updateIpRule}
                          onRemove={form.removeIpRule}
                        />
                      ))}
                    </AnimatePresence>
                  </SortableContext>
                </DndContext>
              ) : null}
            </PanelShell>

            <PanelShell
              title="Basic authentication"
              description="Visitors also sign in with a username and password."
              headerActionsClassName="pl-4"
              actions={
                <div className="flex items-center gap-3">
                  {form.basicAuthEnabled ? (
                    <Button onClick={() => form.addBasicAuthUser()}>
                      <Plus />
                      Add user
                    </Button>
                  ) : null}
                  <Switch
                    checked={form.basicAuthEnabled}
                    onChange={form.setBasicAuthEnabled}
                    ariaLabel="Basic authentication"
                  />
                </div>
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

function SortableIpRuleRow({
  rule,
  index,
  warning,
  warningId,
  onChange,
  onRemove,
}: {
  rule: IPRuleInput;
  index: number;
  warning: AccessListIpRuleWarning | undefined;
  warningId: string;
  onChange: (index: number, field: keyof IPRule, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const sortable = useSortable({ id: rule._key });
  return (
    <motion.div
      ref={sortable.setNodeRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: sortable.isDragging ? 0.7 : 1 }}
      exit={{ opacity: 0 }}
      transition={SORTABLE_ROW_TRANSITION}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        zIndex: sortable.isDragging ? 10 : undefined,
      }}
      className="relative border-b border-border bg-card last:border-b-0"
    >
      <div className="flex">
        <Button
          ref={sortable.setActivatorNodeRef}
          variant="ghost"
          size="icon"
          className="cursor-grab rounded-none text-muted-foreground active:cursor-grabbing"
          aria-label={`Reorder IP rule ${index + 1}`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical />
        </Button>
        <span className="flex w-10 shrink-0 items-center justify-center border-x border-border font-mono text-xs text-muted-foreground tabular-nums">
          {index + 1}
        </span>
        <SegmentedChoice
          flush
          aria-label={`Rule ${index + 1} action`}
          value={rule.type}
          options={RULE_TYPE_OPTIONS}
          onChange={(type) => onChange(index, "type", type)}
        />
        <Input
          aria-label={`Rule ${index + 1} address`}
          aria-describedby={warning ? warningId : undefined}
          value={rule.value}
          onChange={(event) => onChange(index, "value", event.target.value)}
          className={`${CELL_INPUT} border-l border-border font-mono`}
          placeholder="203.0.113.0/24, 192.0.2.10 or all"
        />
        <Button
          variant="ghost"
          size="icon"
          className="rounded-none border-l border-border"
          aria-label={`Remove IP rule ${index + 1}`}
          onClick={() => onRemove(index)}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {warning ? (
        <p
          id={warningId}
          className="flex items-start gap-2 border-t border-border px-3 py-2 text-xs text-warning-text"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{warning.message}</span>
        </p>
      ) : null}
    </motion.div>
  );
}
