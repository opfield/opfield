import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus } from "lucide-react";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AccessRuleSelector } from "@/types";
import { type AccessRuleInput, newRuleInput } from "./access-list-form";
import { CHOICE_SELECTORS, SELECTOR_PLACEHOLDERS, SELECTORS } from "./access-options";
import type { AccessChoice } from "./use-access-choices";

export const CELL_INPUT =
  "h-9 min-w-0 flex-1 rounded-none border-0 bg-background shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
const CELL_SELECT = "h-9 w-44 shrink-0 rounded-none border-0 border-r border-border shadow-none";
export const ROW = "flex border-b border-border last:border-b-0";

export const ROW_ANIMATION = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] as const },
};

/** The options of each picked selector; values a row holds that are not among them stay listed. */
export type RuleChoices = Partial<Record<AccessRuleSelector, AccessChoice[]>>;

function choicesFor(rule: AccessRuleInput, choices: RuleChoices): AccessChoice[] {
  const options = choices[rule.selector] ?? [];
  const missing = rule.values
    .filter((value) => value && !options.some((option) => option.value === value))
    .map((value) => ({ value, label: value }));
  return [...options, ...missing];
}

function RuleRow({
  rule,
  label,
  choices,
  onChange,
  onRemove,
}: {
  rule: AccessRuleInput;
  label: string;
  choices: RuleChoices;
  onChange: (rule: AccessRuleInput) => void;
  onRemove: () => void;
}) {
  const options = CHOICE_SELECTORS.has(rule.selector) ? choicesFor(rule, choices) : null;
  return (
    <motion.div layout {...ROW_ANIMATION} className={ROW}>
      <Select
        value={rule.selector}
        onValueChange={(next) => {
          const selector = next as AccessRuleSelector;
          const first = choices[selector]?.[0]?.value;
          onChange({ ...rule, selector, text: "", values: first ? [first] : [] });
        }}
      >
        <SelectTrigger aria-label={`${label} selector`} className={CELL_SELECT}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SELECTORS.map((selector) => (
            <SelectItem key={selector.value} value={selector.value}>
              {selector.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {rule.selector === "everyone" ? (
        <span className="flex h-9 flex-1 items-center px-3 text-sm text-muted-foreground">
          Any visitor who signs in
        </span>
      ) : options ? (
        // A rule picks one value here; more values set through the API stay until it is changed.
        <Select
          value={rule.values[0] ?? ""}
          onValueChange={(value) => onChange({ ...rule, values: [value] })}
        >
          <SelectTrigger
            aria-label={`${label} value`}
            className={`${CELL_SELECT} w-auto flex-1 border-r-0`}
          >
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          aria-label={`${label} value`}
          value={rule.text}
          placeholder={SELECTOR_PLACEHOLDERS[rule.selector]}
          onChange={(event) => onChange({ ...rule, text: event.target.value })}
          className={`${CELL_INPUT} ${rule.selector === "ip" ? "font-mono" : ""}`}
        />
      )}
      <Button
        variant="ghost"
        size="icon"
        className="rounded-none border-l border-border"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
    </motion.div>
  );
}

/** Include, Require or Exclude: one row per rule, each a selector and its value. */
export function AccessRulePanel({
  title,
  description,
  emptyDescription,
  rules,
  choices,
  onChange,
}: {
  title: string;
  description: string;
  emptyDescription: string;
  rules: AccessRuleInput[];
  choices: RuleChoices;
  onChange: (rules: AccessRuleInput[]) => void;
}) {
  return (
    <PanelShell
      title={title}
      description={rules.length > 0 ? description : emptyDescription}
      headerActionsClassName="pl-4"
      actions={
        <Button onClick={() => onChange([...rules, newRuleInput()])}>
          <Plus />
          Add rule
        </Button>
      }
    >
      {rules.length > 0 ? (
        <AnimatePresence initial={false}>
          {rules.map((rule, index) => (
            <RuleRow
              key={rule._key}
              rule={rule}
              label={`${title} rule ${index + 1}`}
              choices={choices}
              onChange={(next) => onChange(rules.map((item, at) => (at === index ? next : item)))}
              onRemove={() => onChange(rules.filter((_, at) => at !== index))}
            />
          ))}
        </AnimatePresence>
      ) : null}
    </PanelShell>
  );
}
