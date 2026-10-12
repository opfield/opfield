import { type ComponentProps, useEffect, useState } from "react";
import { toast } from "sonner";
import { ScopePicker } from "@/components/common/ScopePicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildFinalScopes, parseScopesForForm, requiresResourceSelection } from "@/lib/scope-utils";

type PickerProps = ComponentProps<typeof ScopePicker>;

/** What the scope picker shows besides the selection: the catalog, restrictions, resource lists. */
export type AccessScopePickerProps = Pick<
  PickerProps,
  | "scopes"
  | "cas"
  | "nodes"
  | "proxyHosts"
  | "databases"
  | "loggingSchemas"
  | "restrictableScopes"
  | "allowedResourceIds"
  | "inheritedScopes"
  | "inheritedFromName"
  | "searchPlaceholder"
>;

interface AccessScopesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The raw scopes the lines stand for. */
  scopes: readonly string[];
  picker: AccessScopePickerProps;
  /** Receives the edited scopes; the lines are rebuilt from them. Absent: review only. */
  onApply?: (scopes: string[]) => void;
}

/**
 * "Review N scopes": the scope picker over the raw scopes an access list stands for. Applying
 * rebuilds the lines; scopes no line covers show as one "Custom scopes" line.
 */
export function AccessScopesDialog({
  open,
  onOpenChange,
  title,
  scopes,
  picker,
  onApply,
}: AccessScopesDialogProps) {
  const [baseScopes, setBaseScopes] = useState<string[]>([]);
  const [resources, setResources] = useState<Record<string, string[]>>({});
  const [initialResourceLimitedScopes, setInitialResourceLimitedScopes] = useState<string[]>([]);
  const allowedResourceIds = picker.allowedResourceIds ?? {};
  const readOnly = !onApply;
  const scopesKey = scopes.join("\n");

  // Each opening starts from the scopes the lines stand for.
  useEffect(() => {
    if (!open) return;
    const parsed = parseScopesForForm(scopesKey ? scopesKey.split("\n") : []);
    setBaseScopes(parsed.baseScopes);
    setResources(parsed.resources);
    setInitialResourceLimitedScopes(Object.keys(parsed.resources));
  }, [open, scopesKey]);

  const selectedCount = buildFinalScopes(baseScopes, resources).length;

  const toggleScope = (scope: string) => {
    setBaseScopes((current) => {
      if (current.includes(scope)) {
        setResources((currentResources) => {
          const next = { ...currentResources };
          delete next[scope];
          return next;
        });
        return current.filter((value) => value !== scope);
      }
      const allowedIds = allowedResourceIds[scope];
      if (allowedIds?.length) {
        setResources((currentResources) => ({ ...currentResources, [scope]: allowedIds }));
      }
      return [...current, scope];
    });
  };

  const toggleResource = (scope: string, resourceId: string) => {
    setResources((current) => {
      const selected = current[scope] ?? [];
      return {
        ...current,
        [scope]: selected.includes(resourceId)
          ? selected.filter((id) => id !== resourceId)
          : [...selected, resourceId],
      };
    });
    setBaseScopes((current) => [...new Set([...current, scope])]);
  };

  const apply = () => {
    const missing = baseScopes.find(
      (scope) =>
        requiresResourceSelection(scope, allowedResourceIds, initialResourceLimitedScopes) &&
        (resources[scope]?.length ?? 0) === 0
    );
    if (missing) {
      toast.error(`Select at least one resource for ${missing}`);
      return;
    }
    onApply?.(buildFinalScopes(baseScopes, resources));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {readOnly
            ? "The raw scopes the access lines stand for."
            : "Review and edit the raw scopes. Scopes no access line covers show as a Custom scopes line."}
        </DialogDescription>
        <ScopePicker
          {...picker}
          header={<span className="text-sm font-medium">Scopes</span>}
          selected={baseScopes}
          onToggle={toggleScope}
          resources={resources}
          onResourcesChange={readOnly ? undefined : setResources}
          onToggleResource={toggleResource}
          readOnly={readOnly}
          footer={`${selectedCount} scope${selectedCount === 1 ? "" : "s"} selected`}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {readOnly ? null : (
            <Button type="button" onClick={apply}>
              Apply
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
