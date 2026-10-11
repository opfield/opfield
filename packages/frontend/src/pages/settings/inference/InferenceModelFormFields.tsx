import { AnimatePresence, motion } from "framer-motion";
import { Database, Minus, Plus, Users } from "lucide-react";
import { type Dispatch, type SetStateAction, useMemo } from "react";
import { Combobox } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PermissionGroup, User } from "@/types";
import type { InferenceAccessSubject, InferenceModelMetadataSource } from "@/types/inference";
import {
  hasRequiredModelMetadata,
  type ModelForm,
  type ProviderModelOption,
  providerModelLabels,
} from "./inference-model-form";

type AccessMode = "everyone" | "selected" | "disabled";

const RESIZE_TRANSITION = { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const };
const REVEAL_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: RESIZE_TRANSITION,
};

export function ModelGeneralFields({
  form,
  setForm,
  options,
  providerId,
  remoteModelId,
  editingModelKey = null,
  selected,
  onProviderChange,
  onModelChange,
}: {
  form: ModelForm;
  setForm: Dispatch<SetStateAction<ModelForm>>;
  options: ProviderModelOption[];
  providerId: string;
  remoteModelId: string;
  /** The model being edited stays selectable even when its metadata is incomplete. */
  editingModelKey?: string | null;
  selected: ProviderModelOption | null;
  onProviderChange: (providerId: string) => void;
  onModelChange: (remoteModelId: string) => void;
}) {
  // Keep the edited and the currently selected model visible so an existing model stays editable.
  const pickable = useMemo(
    () =>
      options.filter(
        (option) =>
          hasRequiredModelMetadata(option) ||
          option.key === editingModelKey ||
          (option.providerId === providerId && option.remoteModelId === remoteModelId)
      ),
    [options, providerId, remoteModelId, editingModelKey]
  );
  const providers = useMemo(
    () =>
      [
        ...new Map(options.map((option) => [option.providerId, option.providerLabel])).entries(),
      ].map(([id, label]) => ({ id, label })),
    [options]
  );
  const models = useMemo(
    () => pickable.filter((option) => option.providerId === providerId),
    [pickable, providerId]
  );
  const modelLabels = useMemo(() => providerModelLabels(models), [models]);
  const setFormValue = <K extends keyof ModelForm>(key: K, value: ModelForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const technicalFields = selected
    ? [
        {
          key: "contextWindow" as const,
          label: "Context window",
          detected: selected.contextWindow,
          optional: false,
          editableWhenDetected: true,
        },
        {
          key: "maxInputTokens" as const,
          label: "Maximum input tokens",
          detected: selected.maxInputTokens,
          optional: false,
          editableWhenDetected: true,
        },
        {
          key: "maxOutputTokens" as const,
          label: "Maximum output tokens",
          detected: selected.maxOutputTokens,
          optional: true,
          editableWhenDetected: false,
        },
        {
          key: "autoCompactTokenLimit" as const,
          label: "Auto-compaction limit",
          detected: selected.autoCompactTokenLimit,
          optional: false,
          editableWhenDetected: true,
        },
      ]
    : [];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Provider</span>
          <Combobox
            value={providerId}
            options={providers.map((provider) => ({ value: provider.id, label: provider.label }))}
            onValueChange={onProviderChange}
            placeholder="Select provider"
            searchPlaceholder="Search providers..."
            emptyMessage="No connected providers"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Upstream model</span>
          <Combobox
            value={remoteModelId}
            options={models.map((model) => ({
              value: model.remoteModelId,
              label: modelLabels.get(model.key) ?? model.displayName,
              keywords: model.remoteModelId,
            }))}
            onValueChange={onModelChange}
            placeholder="Select model"
            searchPlaceholder="Search discovered models..."
            emptyMessage={
              options.some((option) => option.providerId === providerId)
                ? "No models with complete provider metadata"
                : "No discovered models"
            }
            disabled={!providerId}
          />
        </label>
      </div>

      <div
        data-testid="model-identity-fields"
        className={
          selected?.sourceType === "api"
            ? "grid gap-4 sm:grid-cols-2"
            : "grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem]"
        }
      >
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Public model ID</span>
          <Input
            value={form.publicId}
            onChange={(event) => setFormValue("publicId", event.target.value)}
            placeholder="kimi-k3"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Display name</span>
          <Input
            value={form.displayName}
            onChange={(event) => setFormValue("displayName", event.target.value)}
            placeholder="Kimi K3"
          />
        </label>
        {selected?.sourceType !== "api" ? (
          <label className="space-y-1.5">
            <span className="text-sm font-medium">Subscription multiplier</span>
            <Input
              type="number"
              min="0.01"
              step="0.1"
              value={form.subscriptionMultiplier}
              onChange={(event) => setFormValue("subscriptionMultiplier", event.target.value)}
            />
          </label>
        ) : null}
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {selected && (
          <motion.div key={selected.key} {...REVEAL_ANIMATION} className="overflow-hidden">
            <PanelShell
              title="Provider model metadata"
              description={`${selected.bindings.length} of ${selected.totalAccounts} enabled account${selected.totalAccounts === 1 ? "" : "s"} can serve this model`}
              icon={<Database className="h-4 w-4" />}
              wrapHeader
              headerActionsClassName="w-full min-w-0 shrink flex-wrap justify-start"
              actions={Object.entries(selected.capabilities).map(([capability, enabled]) => (
                <Badge key={capability} variant={enabled ? "success" : "secondary"}>
                  {capability}
                  {enabled ? "" : " unavailable"}
                </Badge>
              ))}
            >
              {technicalFields.map((field) => (
                <SettingsControlRow
                  key={field.key}
                  title={field.label}
                  description={
                    exceedsDetectedLimit(form[field.key], field.detected)
                      ? `Override exceeds provider metadata (${field.detected?.toLocaleString()}); upstream requests may still be rejected at the provider limit`
                      : field.detected == null
                        ? field.optional
                          ? "Optional; not reported by the provider"
                          : "Not reported by the provider; enter a value to continue"
                        : detectedDescription(
                            selected.metadataSources[field.key],
                            field.editableWhenDetected
                          )
                  }
                  help={
                    field.key === "autoCompactTokenLimit"
                      ? "Opfield starts compacting conversation context at this input-token threshold. It must not exceed Maximum input tokens."
                      : undefined
                  }
                >
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={form[field.key]}
                    readOnly={field.detected != null && !field.editableWhenDetected}
                    placeholder="Not reported"
                    aria-label={field.label}
                    className="w-full read-only:bg-muted/40 read-only:text-muted-foreground"
                    onChange={(event) => setFormValue(field.key, event.target.value)}
                  />
                </SettingsControlRow>
              ))}
              <SettingsControlRow
                title="Modalities"
                description={
                  selected.metadataSources.modalities === "fallback"
                    ? "Not reported by the provider; built-in catalog value"
                    : selected.metadataSources.modalities === "provider"
                      ? "Reported by the provider API"
                      : "Detected input modalities"
                }
              >
                <Input
                  readOnly
                  value={selected.modalities.join(", ")}
                  aria-label="Modalities"
                  className="w-full bg-muted/40 text-muted-foreground"
                />
              </SettingsControlRow>
            </PanelShell>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function detectedDescription(source: InferenceModelMetadataSource | undefined, editable: boolean) {
  const suffix = editable ? "; may be overridden" : "";
  if (source === "provider") return `Reported by the provider API${suffix}`;
  if (source === "derived") return `Calculated from limits reported by the provider${suffix}`;
  if (source === "fallback") return `Not reported by the provider; built-in catalog value${suffix}`;
  return `Detected from provider metadata${suffix}`;
}

function exceedsDetectedLimit(value: string, detected: number | null) {
  if (detected == null) return false;
  const configured = Number(value);
  return Number.isSafeInteger(configured) && configured > detected;
}

export function ModelAccessFields({
  mode,
  setMode,
  subjects,
  setSubjects,
  groups,
  users,
}: {
  mode: AccessMode;
  setMode: (value: AccessMode) => void;
  subjects: InferenceAccessSubject[];
  setSubjects: (value: InferenceAccessSubject[]) => void;
  groups: PermissionGroup[];
  users: User[];
}) {
  const rows: InferenceAccessSubject[] = subjects.length
    ? subjects
    : [{ subjectType: "group", subjectId: "" }];
  const updateRow = (index: number, value: InferenceAccessSubject) => {
    const next = [...rows];
    next[index] = value;
    setSubjects(next);
  };

  return (
    <PanelShell
      title="Model access"
      description="Choose who can use this model through Opfield"
      icon={<Users className="h-4 w-4" />}
      actions={
        mode === "selected" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Add access subject"
            title="Add access subject"
            disabled={rows.some((subject) => !subject.subjectId)}
            onClick={() => setSubjects([...rows, { subjectType: "group", subjectId: "" }])}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        ) : null
      }
    >
      <SettingsControlRow
        title="Access"
        description="Publish for everyone, selected users and groups, or disable access"
        help="Controls who can discover and request this model through Opfield. Selected access is additive across the users and permission groups listed below."
      >
        <Select value={mode} onValueChange={(value) => setMode(value as AccessMode)}>
          <SelectTrigger aria-label="Access" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="everyone">Everyone</SelectItem>
            <SelectItem value="selected">Selected users and groups</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </SettingsControlRow>
      <AnimatePresence initial={false} mode="popLayout">
        {mode === "selected" && (
          <motion.div {...REVEAL_ANIMATION} className="overflow-hidden">
            <div className="grid grid-cols-2 border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <div className="px-3 py-2">Subject type</div>
              <div className="border-l border-border px-3 py-2">User or group</div>
            </div>
            <AnimatePresence initial={false} mode="popLayout">
              {rows.map((subject, index) => {
                const options = subject.subjectType === "group" ? groups : users;
                return (
                  <motion.div
                    key={`access-subject-${index}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{
                      opacity: { duration: 0.12 },
                      y: { duration: 0.12, ease: [0.25, 0.1, 0.25, 1] },
                    }}
                    className="grid grid-cols-2 border-b border-border last:border-b-0"
                  >
                    <Select
                      value={subject.subjectType}
                      onValueChange={(value) =>
                        updateRow(index, {
                          subjectType: value as InferenceAccessSubject["subjectType"],
                          subjectId: "",
                        })
                      }
                    >
                      <SelectTrigger
                        aria-label={`Subject type ${index + 1}`}
                        className="h-9 w-full rounded-none border-0 shadow-none focus:ring-1 focus:ring-inset focus:ring-ring focus:ring-offset-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="group">Group</SelectItem>
                        <SelectItem value="user">User</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex min-w-0 items-center border-l border-border">
                      <Combobox
                        value={subject.subjectId}
                        options={options.map((option) => ({
                          value: option.id,
                          label: "email" in option ? option.name || option.email : option.name,
                          keywords: "email" in option ? option.email : option.description || "",
                          disabled: subjects.some(
                            (candidate, candidateIndex) =>
                              candidateIndex !== index &&
                              candidate.subjectType === subject.subjectType &&
                              candidate.subjectId === option.id
                          ),
                        }))}
                        onValueChange={(subjectId) => updateRow(index, { ...subject, subjectId })}
                        ariaLabel={`${subject.subjectType === "group" ? "Group" : "User"} ${index + 1}`}
                        placeholder={`Select ${subject.subjectType}`}
                        searchPlaceholder={`Search ${subject.subjectType}s...`}
                        emptyMessage={`No ${subject.subjectType}s found`}
                        className="min-w-0 flex-1"
                        inputClassName="h-9 rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove access subject ${index + 1}`}
                        className="rounded-none border-l border-border"
                        onClick={() =>
                          setSubjects(rows.filter((_, rowIndex) => rowIndex !== index))
                        }
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </PanelShell>
  );
}
