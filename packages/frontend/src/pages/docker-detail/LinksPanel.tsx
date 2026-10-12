import { Boxes, Database, HardDrive, Link2, Plus, RotateCcw } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type LinkKind = "database" | "storage" | "container";

const KIND_ORDER: LinkKind[] = ["database", "storage", "container"];

const KIND_LABELS: Record<LinkKind, string> = {
  database: "Database",
  storage: "Storage",
  container: "Container",
};

const KIND_CHOICES: Record<
  LinkKind,
  { icon: typeof Database; title: string; description: string }
> = {
  database: {
    icon: Database,
    title: "Managed database",
    description: "A private connection to a managed database. Its credentials become variables.",
  },
  storage: {
    icon: HardDrive,
    title: "Managed storage",
    description: "Private object-storage credentials for chosen buckets, set as variables.",
  },
  container: {
    icon: Boxes,
    title: "Container",
    description:
      "A private connection to a port of another container, deployment or Compose service.",
  },
};

/** What one link section tells the shared Links panel about itself. */
export interface LinkSourceState {
  /** Rows the section shows in the panel (0 while it first loads). */
  rowCount: number;
  loading: boolean;
  /** How to add a link of this kind; absent when the user cannot create one. */
  add?: { disabled: boolean; open: () => void };
  /** A staged draft saved by the panel's Save button; absent for kinds that apply at once. */
  save?: { dirty: boolean; saving: boolean; disabled: boolean; label: string; onSave: () => void };
}

interface LinksPanelContextValue {
  report: (kind: LinkKind, state: LinkSourceState | null) => void;
}

const LinksPanelContext = createContext<LinksPanelContextValue | null>(null);

/** Whether a link section renders as rows of the shared Links panel. */
export function useInLinksPanel() {
  return useContext(LinksPanelContext) !== null;
}

/**
 * Reports a section's rows, add action and draft to the Links panel around it. A section
 * outside a panel keeps its own header and actions; the call is then a no-op.
 */
export function useLinkSource(kind: LinkKind, state: LinkSourceState) {
  const panel = useContext(LinksPanelContext);
  const report = panel?.report;
  // The panel keeps the latest callbacks; only the visible state re-renders it.
  useEffect(() => {
    report?.(kind, state);
  });
  useEffect(() => {
    if (!report) return;
    return () => report(kind, null);
  }, [kind, report]);
}

/** A link row's title, with its kind in front when the row is in the shared Links panel. */
export function LinkRowTitle({ kind, children }: { kind: LinkKind; children: ReactNode }) {
  if (!useInLinksPanel()) return <>{children}</>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <Badge variant="secondary" size="inline">
        {KIND_LABELS[kind]}
      </Badge>
      <span className="min-w-0">{children}</span>
    </span>
  );
}

function visibleSignature(sources: Map<LinkKind, LinkSourceState>) {
  return JSON.stringify(
    KIND_ORDER.map((kind) => {
      const state = sources.get(kind);
      if (!state) return null;
      return [
        state.rowCount,
        state.loading,
        state.add ? state.add.disabled : "none",
        state.save
          ? [state.save.dirty, state.save.saving, state.save.disabled, state.save.label]
          : "none",
      ];
    })
  );
}

/**
 * One block for every link of a workload: managed database links, managed storage links and
 * container links in a single list, each row marked with its kind. "Add link" asks for the
 * kind (only kinds the user can create are offered) and then opens that kind's own dialog.
 * Database and storage changes are staged and saved together with the panel's Save button
 * (`onSave` when the page saves them with other changes); container links apply at once.
 */
export function LinksPanel({
  description,
  onSave,
  children,
}: {
  description: ReactNode;
  /** Saves every staged link change; without it each staged section saves its own draft. */
  onSave?: () => void;
  children: ReactNode;
}) {
  // The sections' latest state, callbacks included. The panel re-renders only when what it
  // shows changes, so a section reporting on every render cannot loop.
  const sourcesRef = useRef(new Map<LinkKind, LinkSourceState>());
  const signatureRef = useRef("");
  const [, rerender] = useReducer((version: number) => version + 1, 0);
  const [pickOpen, setPickOpen] = useState(false);

  const report = useCallback((kind: LinkKind, state: LinkSourceState | null) => {
    if (state) sourcesRef.current.set(kind, state);
    else sourcesRef.current.delete(kind);
    const next = visibleSignature(sourcesRef.current);
    if (next === signatureRef.current) return;
    signatureRef.current = next;
    rerender();
  }, []);
  const context = useMemo(() => ({ report }), [report]);

  const sources = KIND_ORDER.flatMap((kind) => {
    const state = sourcesRef.current.get(kind);
    return state ? [{ kind, state }] : [];
  });
  const loading = sources.some(({ state }) => state.loading);
  const rowCount = sources.reduce((total, { state }) => total + state.rowCount, 0);
  const addable = sources.filter(({ state }) => state.add);
  const addDisabled = addable.every(({ state }) => state.add?.disabled);
  const saves = sources.filter(({ state }) => state.save);
  const dirtySaves = saves.filter(({ state }) => state.save?.dirty);
  const dirty = dirtySaves.length > 0;
  const saving = saves.some(({ state }) => state.save?.saving);
  const saveLabel = (dirtySaves[0] ?? saves[0])?.state.save?.label ?? "Save";

  const openKind = (kind: LinkKind) => {
    setPickOpen(false);
    sourcesRef.current.get(kind)?.add?.open();
  };
  const addLink = () => {
    const enabled = addable.filter(({ state }) => !state.add?.disabled);
    // With one kind to choose there is nothing to ask.
    if (enabled.length === 1) openKind(enabled[0]!.kind);
    else setPickOpen(true);
  };
  const save = () => {
    if (onSave) {
      onSave();
      return;
    }
    for (const { state } of dirtySaves) state.save?.onSave();
  };

  return (
    <LinksPanelContext.Provider value={context}>
      <PanelShell
        title="Links"
        icon={<Link2 className="h-4 w-4" />}
        description={description}
        dirty={dirty}
        actions={
          saves.length > 0 || addable.length > 0 ? (
            <div className="flex items-center gap-2">
              {saves.length > 0 && (
                <Button
                  type="button"
                  variant="warning"
                  pending={saving}
                  disabled={!dirty || dirtySaves.some(({ state }) => state.save?.disabled)}
                  onClick={save}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {saveLabel}
                </Button>
              )}
              {addable.length > 0 && (
                <Button type="button" disabled={addDisabled || saving} onClick={addLink}>
                  <Plus className="h-3.5 w-3.5" />
                  Add link
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {children}
        {!loading && rowCount === 0 && <EmptyState message="No links" embedded />}
      </PanelShell>

      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add link</DialogTitle>
          </DialogHeader>
          <DialogDescription>Choose what this workload connects to.</DialogDescription>
          <div className="space-y-3">
            {addable.map(({ kind, state }) => {
              const choice = KIND_CHOICES[kind];
              return (
                <ChoiceCard
                  key={kind}
                  icon={choice.icon}
                  title={choice.title}
                  description={choice.description}
                  disabled={state.add?.disabled}
                  onClick={() => openKind(kind)}
                />
              );
            })}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPickOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LinksPanelContext.Provider>
  );
}
