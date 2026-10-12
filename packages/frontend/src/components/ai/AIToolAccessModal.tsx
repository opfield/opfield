import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useContentLoading } from "@/components/common/reveal-gate";
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
import { Separator } from "@/components/ui/separator";
import { api } from "@/services/api";

type ToolCatalog = Record<
  string,
  Array<{
    name: string;
    displayName: string;
    displayDescription: string;
    destructive: boolean;
    requiredScope: string;
  }>
>;

interface AIToolAccessModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabledTools: string[];
  onSave: (disabledTools: string[]) => void;
}

export function AIToolAccessModal({
  open,
  onOpenChange,
  disabledTools: initialDisabled,
  onSave,
}: AIToolAccessModalProps) {
  // null until the catalog first loads; a reopen refreshes it in place.
  const [tools, setTools] = useState<ToolCatalog | null>(null);
  const [disabledTools, setDisabledTools] = useState<string[]>(initialDisabled);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (open) {
      setDisabledTools(initialDisabled);
      setSearch("");
      api
        .getAITools()
        .then(setTools)
        .catch(() => {
          toast.error("Failed to load tools");
          setTools((current) => current ?? {});
        });
    }
  }, [open, initialDisabled]);

  const toggleTool = (toolName: string) => {
    setDisabledTools((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName]
    );
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      onSave(disabledTools);
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-x-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>AI Tool Access</DialogTitle>
          <DialogDescription>Control which tools AI Workspace can use</DialogDescription>
        </DialogHeader>

        <ToolAccessList
          tools={tools}
          disabledTools={disabledTools}
          search={search}
          onSearchChange={setSearch}
          onToggleTool={toggleTool}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Dialog body: reports the catalog load, so the dialog opens with the list in place. */
function ToolAccessList({
  tools: loadedTools,
  disabledTools,
  search,
  onSearchChange,
  onToggleTool,
}: {
  tools: ToolCatalog | null;
  disabledTools: string[];
  search: string;
  onSearchChange: (search: string) => void;
  onToggleTool: (toolName: string) => void;
}) {
  useContentLoading(loadedTools === null);
  const tools = loadedTools ?? {};
  const categories = Object.keys(tools);
  const totalTools = Object.values(tools).flat().length;
  const enabledCount = totalTools - disabledTools.length;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleTools = Object.fromEntries(
    categories
      .map((category) => [
        category,
        tools[category].filter((tool) => {
          if (!normalizedSearch) return true;
          return [
            category,
            tool.displayName,
            tool.displayDescription,
            tool.name,
            tool.requiredScope,
          ].some((value) => value.toLowerCase().includes(normalizedSearch));
        }),
      ])
      .filter(([, items]) => items.length > 0)
  ) as ToolCatalog;
  const visibleCategories = Object.keys(visibleTools);

  return (
    <div className="min-w-0 space-y-2">
      <div className="overflow-hidden border border-border">
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search tools or scopes..."
          className="h-9 rounded-none border-0 border-b border-border text-sm focus-visible:ring-0"
        />
        <div className="max-h-[min(28rem,48dvh)] overflow-y-auto overflow-x-hidden overscroll-contain">
          {visibleCategories.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No tools found.
            </div>
          ) : (
            visibleCategories.map((category, ci) => (
              <div key={category}>
                {ci > 0 && <Separator />}
                <div className="px-3 py-1.5 bg-muted/50">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {category}
                  </p>
                </div>
                {visibleTools[category].map((tool) => {
                  const isEnabled = !disabledTools.includes(tool.name);
                  return (
                    <label
                      key={tool.name}
                      className="flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={() => onToggleTool(tool.name)}
                        className="form-checkbox shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="break-words text-sm font-medium">
                          {tool.displayName}
                          {tool.destructive && (
                            <span className="ml-1 text-xs text-warning-foreground">
                              (requires approval)
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 break-words text-xs text-muted-foreground">
                          {tool.displayDescription}
                        </p>
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {tool.name}
                          <span className="ml-2 text-muted-foreground/60">
                            scope: {tool.requiredScope}
                          </span>
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {enabledCount} of {totalTools} tool{totalTools !== 1 ? "s" : ""} enabled
          </p>
        </div>
      </div>
    </div>
  );
}
