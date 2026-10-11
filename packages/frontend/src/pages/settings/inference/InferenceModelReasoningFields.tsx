import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { motion } from "framer-motion";
import { GripVertical, Minus, Plus, Route } from "lucide-react";
import { useRef } from "react";
import { Combobox } from "@/components/common/Combobox";
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
import type { ProviderModelOption } from "./inference-model-form";

const RESIZE_TRANSITION = { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const };

export function reorderReasoningMapping(
  mapping: Record<string, string>,
  oldIndex: number,
  newIndex: number
) {
  return Object.fromEntries(arrayMove(Object.entries(mapping), oldIndex, newIndex));
}

export function ModelReasoningFields({
  selected,
  mapping,
  setMapping,
  defaultEffort,
  setDefaultEffort,
}: {
  selected: ProviderModelOption | null;
  mapping: Record<string, string>;
  setMapping: (mapping: Record<string, string>) => void;
  defaultEffort: string;
  setDefaultEffort: (effort: string) => void;
}) {
  const rowIdentity = useRef<Array<{ id: string; clientEffort: string; upstreamEffort: string }>>(
    []
  );
  const nextRowId = useRef(0);
  const previousRows = rowIdentity.current;
  const usedIds = new Set<string>();
  const rows = Object.entries(mapping).map(([clientEffort, upstreamEffort], index) => {
    const exact = previousRows.find(
      (row) =>
        !usedIds.has(row.id) &&
        row.clientEffort === clientEffort &&
        row.upstreamEffort === upstreamEffort
    );
    const positional = previousRows[index];
    const id =
      exact?.id ??
      (positional && !usedIds.has(positional.id)
        ? positional.id
        : `reasoning:${nextRowId.current++}`);
    usedIds.add(id);
    return { id, clientEffort, upstreamEffort };
  });
  rowIdentity.current = rows;
  const exposed = rows.flatMap(({ clientEffort, upstreamEffort }) =>
    clientEffort.trim() && upstreamEffort.trim() ? [clientEffort.trim()] : []
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const updateRow = (index: number, field: "client" | "upstream", value: string) => {
    setMapping(
      Object.fromEntries(
        rows.map((row, rowIndex) =>
          rowIndex === index
            ? [
                field === "client" ? value : row.clientEffort,
                field === "upstream" ? value : row.upstreamEffort,
              ]
            : [row.clientEffort, row.upstreamEffort]
        )
      )
    );
  };
  const reorderRows = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const oldIndex = rows.findIndex((row) => row.id === active.id);
    const newIndex = rows.findIndex((row) => row.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setMapping(reorderReasoningMapping(mapping, oldIndex, newIndex));
  };

  return (
    <PanelShell
      title="Client-to-provider mapping"
      description={`Map client efforts to values accepted by ${selected?.providerLabel ?? "the provider"}`}
      icon={<Route className="h-4 w-4" />}
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Add mapping"
          title="Add mapping"
          disabled={Object.hasOwn(mapping, "")}
          onClick={() => setMapping({ ...mapping, "": "" })}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      }
    >
      <SettingsControlRow
        title="Default reasoning effort"
        description="Used when the client does not provide an effort"
        help="The effort Opfield sends upstream when a client omits it. The selected value must be exposed by the client-to-provider mapping above."
      >
        <Select value={defaultEffort} onValueChange={setDefaultEffort} disabled={!exposed.length}>
          <SelectTrigger aria-label="Default reasoning effort" className="w-full">
            <SelectValue placeholder="Not available" />
          </SelectTrigger>
          <SelectContent>
            {exposed.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsControlRow>
      {rows.length ? (
        <>
          <div className="grid grid-cols-[2.25rem_1fr_1fr] border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <div>
              <span className="sr-only">Order</span>
            </div>
            <div className="px-3 py-2">Client effort</div>
            <div className="border-l border-border px-3 py-2">Provider effort</div>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderRows}>
            <SortableContext
              items={rows.map((row) => row.id)}
              strategy={verticalListSortingStrategy}
            >
              {rows.map((row, index) => (
                <SortableReasoningRow
                  key={row.id}
                  id={row.id}
                  index={index}
                  row={row}
                  isLast={index === rows.length - 1}
                  selected={selected}
                  updateRow={updateRow}
                  remove={() =>
                    setMapping(
                      Object.fromEntries(
                        rows
                          .filter((_, rowIndex) => rowIndex !== index)
                          .map(({ clientEffort, upstreamEffort }) => [clientEffort, upstreamEffort])
                      )
                    )
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
        </>
      ) : (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No reasoning efforts exposed. Use Add mapping to configure one.
        </div>
      )}
    </PanelShell>
  );
}

function SortableReasoningRow({
  id,
  index,
  row,
  isLast,
  selected,
  updateRow,
  remove,
}: {
  id: string;
  index: number;
  row: { clientEffort: string; upstreamEffort: string };
  isLast: boolean;
  selected: ProviderModelOption | null;
  updateRow: (index: number, field: "client" | "upstream", value: string) => void;
  remove: () => void;
}) {
  const sortable = useSortable({ id });
  return (
    <motion.div
      ref={sortable.setNodeRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: sortable.isDragging ? 0.7 : 1 }}
      exit={{ opacity: 0 }}
      transition={RESIZE_TRANSITION}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`grid grid-cols-[2.25rem_1fr_1fr] bg-card ${isLast ? "" : "border-b border-border"}`}
    >
      <Button
        ref={sortable.setActivatorNodeRef}
        variant="ghost"
        size="icon"
        className="cursor-grab rounded-none text-muted-foreground active:cursor-grabbing"
        aria-label={`Reorder reasoning mapping ${index + 1}`}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical />
      </Button>
      <Input
        value={row.clientEffort}
        onChange={(event) => updateRow(index, "client", event.target.value)}
        aria-label={`Client effort ${index + 1}`}
        placeholder="ultra"
        className="h-9 rounded-none border-0 border-l shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <div className="flex min-w-0 items-center border-l border-border">
        <Combobox
          freeText
          value={row.upstreamEffort}
          options={(selected?.reasoningEfforts ?? []).map((effort) => ({
            value: effort,
            label: effort,
          }))}
          onValueChange={(value) => updateRow(index, "upstream", value)}
          ariaLabel={`Provider effort ${index + 1}`}
          placeholder="Select or enter an effort"
          searchPlaceholder="Select or enter an effort"
          className="min-w-0 flex-1"
          inputClassName="h-9 rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove reasoning mapping ${index + 1}`}
          className="rounded-none border-l border-border"
          onClick={remove}
        >
          <Minus />
        </Button>
      </div>
    </motion.div>
  );
}
