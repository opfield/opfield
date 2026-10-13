import { Minus, Plus } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
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
import { cn } from "@/lib/utils";
import type { LoggingFieldDefinition, LoggingSchemaMode } from "@/types";

const FIELD_TYPES = ["string", "number", "boolean", "datetime", "json"] as const;

export function LoggingSchemaEditor({
  schema,
  canEdit,
  dirty = false,
  onSave,
}: {
  schema: { fieldSchema: LoggingFieldDefinition[]; schemaMode: LoggingSchemaMode };
  canEdit: boolean;
  /** Unsaved field changes: the warning border of a changed block. */
  dirty?: boolean;
  onSave: (patch: {
    fieldSchema?: LoggingFieldDefinition[];
    schemaMode?: LoggingSchemaMode;
  }) => Promise<void>;
}) {
  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const field of schema.fieldSchema) {
      const key = `${field.location}:${field.key}`;
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    return duplicates;
  }, [schema.fieldSchema]);

  const updateField = (index: number, patch: Partial<LoggingFieldDefinition>) => {
    const next = schema.fieldSchema.map((field, i) =>
      i === index ? { ...field, ...patch } : field
    );
    void onSave({ fieldSchema: next });
  };

  const addField = () => {
    void onSave({
      fieldSchema: [
        ...schema.fieldSchema,
        {
          location: "field",
          key: `field_${schema.fieldSchema.length + 1}`,
          type: "string",
          required: false,
        },
      ],
    });
  };

  const removeField = (index: number) => {
    void onSave({ fieldSchema: schema.fieldSchema.filter((_, i) => i !== index) });
  };

  const invalid = duplicateKeys.size > 0 || schema.fieldSchema.some((field) => !field.key);
  const inputCell =
    "h-9 text-xs font-mono border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
  const selectTrigger =
    "h-9 w-full rounded-none border-0 px-3 text-xs shadow-none focus:ring-0 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  return (
    <PanelShell
      title="Fields"
      description="Define accepted labels and typed fields for attached environments"
      dirty={dirty}
      actions={
        canEdit ? (
          <Button
            variant="outline"
            onClick={() => {
              if (invalid) toast.error("Fix duplicate or empty keys before adding more fields");
              else addField();
            }}
          >
            <Plus /> Add Field
          </Button>
        ) : null
      }
    >
      <div className="overflow-x-auto">
        <div className="grid min-w-[880px] grid-cols-[120px_minmax(160px,1fr)_140px_96px_minmax(220px,1.4fr)_36px] border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <div className="px-3 py-2">Location</div>
          <div className="border-l border-border px-3 py-2">Key</div>
          <div className="border-l border-border px-3 py-2">Type</div>
          <div className="border-l border-border px-3 py-2">Required</div>
          <div className="border-l border-border px-3 py-2">Description</div>
          <div />
        </div>
        {schema.fieldSchema.length === 0 ? (
          <EmptyState message="No declared fields" embedded />
        ) : (
          schema.fieldSchema.map((field, index) => {
            const duplicate = duplicateKeys.has(`${field.location}:${field.key}`);
            return (
              <div
                key={`${field.location}-${field.key}-${index}`}
                className="grid min-w-[880px] grid-cols-[120px_minmax(160px,1fr)_140px_96px_minmax(220px,1.4fr)_36px] border-b border-border last:border-b-0"
              >
                <Select
                  value={field.location}
                  disabled={!canEdit}
                  onValueChange={(value) =>
                    updateField(index, {
                      location: value as "label" | "field",
                      type: value === "label" ? "string" : field.type,
                    })
                  }
                >
                  <SelectTrigger className={selectTrigger}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="label">Label</SelectItem>
                    <SelectItem value="field">Field</SelectItem>
                  </SelectContent>
                </Select>
                <div className="border-l border-border">
                  <Input
                    value={field.key}
                    disabled={!canEdit}
                    className={cn(inputCell, duplicate && "ring-1 ring-inset ring-destructive")}
                    onChange={(event) => updateField(index, { key: event.target.value })}
                  />
                </div>
                <div className="border-l border-border">
                  <Select
                    value={field.type}
                    disabled={!canEdit || field.location === "label"}
                    onValueChange={(value) =>
                      updateField(index, { type: value as LoggingFieldDefinition["type"] })
                    }
                  >
                    <SelectTrigger className={selectTrigger}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="border-l border-border">
                  <Select
                    value={field.required ? "yes" : "no"}
                    disabled={!canEdit}
                    onValueChange={(value) => updateField(index, { required: value === "yes" })}
                  >
                    <SelectTrigger className={selectTrigger}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="border-l border-border">
                  <Input
                    value={field.description ?? ""}
                    disabled={!canEdit}
                    className={inputCell}
                    onChange={(event) => updateField(index, { description: event.target.value })}
                  />
                </div>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove field ${field.key || index + 1}`}
                    className="border-l border-border"
                    onClick={() => removeField(index)}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </PanelShell>
  );
}
