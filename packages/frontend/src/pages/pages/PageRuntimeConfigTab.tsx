import { AlertCircle, Code2, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  PageRuntimeConfigRecord,
  PageRuntimeConfigsResponse,
  PageRuntimeConfigTag,
} from "@/types";

const DEFAULT_TARGET = "default";
const MAX_RUNTIME_CONFIG_BYTES = 64 * 1024;

export interface PageRuntimeConfigValidation {
  valid: boolean;
  error: string | null;
  errorLines: number[];
  bytes: number;
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return new Blob([value]).size;
}

function lineAtPosition(source: string, position: number): number {
  return source.slice(0, Math.max(0, position)).split("\n").length;
}

function lastNonEmptyLine(source: string): number {
  const lines = source.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) return index + 1;
  }
  return 1;
}

export function validatePageRuntimeConfig(source: string): PageRuntimeConfigValidation {
  const bytes = utf8ByteLength(source);
  if (!source.trim()) {
    return { valid: false, error: "Configuration must be valid JSON.", errorLines: [1], bytes };
  }
  if (bytes > MAX_RUNTIME_CONFIG_BYTES) {
    return {
      valid: false,
      error: "Configuration must be a JSON object no larger than 64 KiB.",
      errorLines: [],
      bytes,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    const position = message.match(/position\s+(\d+)/i)?.[1];
    const explicitLine = message.match(/line\s+(\d+)/i)?.[1];
    const line = position
      ? lineAtPosition(source, Number(position))
      : explicitLine
        ? Number(explicitLine)
        : lastNonEmptyLine(source);
    return {
      valid: false,
      error: "Configuration must be valid JSON.",
      errorLines: [line],
      bytes,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      valid: false,
      error: "Configuration must be a JSON object.",
      errorLines: [1],
      bytes,
    };
  }

  return { valid: true, error: null, errorLines: [], bytes };
}

function sourceForRecord(record: PageRuntimeConfigRecord | undefined): string {
  if (!record) return "{}";
  if (typeof record.source === "string") return record.source;
  return JSON.stringify(record.value ?? {}, null, 2);
}

function findTag(
  snapshot: PageRuntimeConfigsResponse | null,
  tagId: string
): PageRuntimeConfigTag | null {
  return snapshot?.tags.find((tag) => tag.id === tagId) ?? null;
}

function findOverride(
  snapshot: PageRuntimeConfigsResponse | null,
  tagId: string
): PageRuntimeConfigRecord | null {
  const listed = snapshot?.overrides.find((config) => config.tagId === tagId);
  if (listed) return listed;
  const tag = findTag(snapshot, tagId);
  if (!tag?.hasOverride) return null;
  return tag.override ?? tag.effective ?? null;
}

function selectedRecord(
  snapshot: PageRuntimeConfigsResponse | null,
  target: string
): PageRuntimeConfigRecord | undefined {
  if (!snapshot) return undefined;
  if (target === DEFAULT_TARGET) return snapshot.default;
  return findOverride(snapshot, target) ?? findTag(snapshot, target)?.effective ?? snapshot.default;
}

export interface PageRuntimeConfigEditorState {
  source: string;
  savedSource: string;
}

export function pageRuntimeConfigEditorState(
  snapshot: PageRuntimeConfigsResponse,
  target: string
): PageRuntimeConfigEditorState {
  const nextSource = sourceForRecord(selectedRecord(snapshot, target));
  return { source: nextSource, savedSource: nextSource };
}

export function mergeUpdatedRecord(
  snapshot: PageRuntimeConfigsResponse,
  target: string,
  updated: PageRuntimeConfigRecord
): PageRuntimeConfigsResponse {
  if (target === DEFAULT_TARGET) {
    return {
      ...snapshot,
      default: updated,
      tags: snapshot.tags.map((tag) =>
        tag.hasOverride
          ? tag
          : {
              ...tag,
              inherited: true,
              effective: updated,
            }
      ),
    };
  }
  const overrides = [
    ...snapshot.overrides.filter((config) => config.tagId !== target),
    { ...updated, tagId: updated.tagId ?? target },
  ];
  return {
    ...snapshot,
    overrides,
    tags: snapshot.tags.map((tag) =>
      tag.id === target
        ? {
            ...tag,
            hasOverride: true,
            inherited: false,
            override: { ...updated, tagId: updated.tagId ?? target },
            effective: { ...updated, tagId: updated.tagId ?? target },
          }
        : tag
    ),
  };
}

function isGenerationConflict(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "PAGES_RUNTIME_CONFIG_GENERATION_CONFLICT"
  );
}

export function PageRuntimeConfigTab({ projectId }: { projectId: string }) {
  const canEdit = useAuthStore((state) => state.hasScopedAccess(`pages:edit:${projectId}`));
  const [snapshot, setSnapshot] = useState<PageRuntimeConfigsResponse | null>(null);
  const [selectedTarget, setSelectedTarget] = useState(DEFAULT_TARGET);
  const [source, setSource] = useState("{}");
  const [savedSource, setSavedSource] = useState("{}");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectedTargetRef = useRef(selectedTarget);
  const dirtyRef = useRef(false);

  selectedTargetRef.current = selectedTarget;
  const dirty = source !== savedSource;
  dirtyRef.current = dirty;

  const applySelection = useCallback((next: PageRuntimeConfigsResponse, target: string) => {
    const nextState = pageRuntimeConfigEditorState(next, target);
    setSource(nextState.source);
    setSavedSource(nextState.savedSource);
    setConflicted(false);
  }, []);

  const load = useCallback(
    async (forceApply = false) => {
      setLoading(true);
      setLoadError(null);
      try {
        const next = await api.getPageRuntimeConfigs(projectId);
        setSnapshot(next);
        const target = selectedTargetRef.current;
        const targetExists =
          target === DEFAULT_TARGET || next.tags.some((tag) => tag.id === target);
        if (forceApply || !dirtyRef.current) {
          const nextTarget = targetExists ? target : DEFAULT_TARGET;
          if (nextTarget !== target) setSelectedTarget(nextTarget);
          applySelection(next, nextTarget);
        }
      } catch (error) {
        setLoadError(
          error instanceof Error ? error.message : "Failed to load runtime configuration"
        );
      } finally {
        setLoading(false);
      }
    },
    [applySelection, projectId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("pages.config.changed", (payload) => {
    const event = payload as { projectId?: string };
    if ((!event.projectId || event.projectId === projectId) && !dirtyRef.current) {
      void load();
    }
  });

  useRealtime("pages.tag.changed", (payload) => {
    const event = payload as { projectId?: string };
    if ((!event.projectId || event.projectId === projectId) && !dirtyRef.current) {
      void load();
    }
  });

  const selectedTag = useMemo(() => findTag(snapshot, selectedTarget), [selectedTarget, snapshot]);
  const override = useMemo(
    () => (selectedTarget === DEFAULT_TARGET ? null : findOverride(snapshot, selectedTarget)),
    [selectedTarget, snapshot]
  );
  const inherited = selectedTarget !== DEFAULT_TARGET && !override;
  const validation = useMemo(() => validatePageRuntimeConfig(source), [source]);
  const hasSelection = selectedTarget === DEFAULT_TARGET || !!selectedTag;
  const canSave =
    canEdit &&
    hasSelection &&
    dirty &&
    validation.valid &&
    !conflicted &&
    !loadError &&
    !saving &&
    !loading;

  const chooseTarget = async (target: string) => {
    if (target === selectedTarget) return;
    if (dirty) {
      const discard = await confirm({
        title: "Discard Unsaved Configuration?",
        description: "Your edits will be discarded when you switch the configuration target.",
        confirmLabel: "Discard edits",
        variant: "destructive",
      });
      if (!discard) return;
    }
    setSelectedTarget(target);
    if (snapshot) applySelection(snapshot, target);
  };

  const save = async () => {
    if (!canSave || !snapshot) return;
    setSaving(true);
    try {
      const expectedGeneration =
        selectedTarget === DEFAULT_TARGET
          ? snapshot.default.generation
          : (override?.generation ?? 0);
      const updated =
        selectedTarget === DEFAULT_TARGET
          ? await api.updatePageRuntimeConfigDefault(projectId, {
              source,
              expectedGeneration,
            })
          : await api.updatePageRuntimeConfigTag(projectId, selectedTarget, {
              source,
              expectedGeneration,
            });
      const next = mergeUpdatedRecord(snapshot, selectedTarget, updated);
      setSnapshot(next);
      const nextSource = sourceForRecord(updated);
      setSource(nextSource);
      setSavedSource(nextSource);
      setConflicted(false);
      toast.success("Runtime configuration saved");
    } catch (error) {
      if (isGenerationConflict(error)) {
        setConflicted(true);
        toast.error("Runtime configuration changed elsewhere. Reload before saving again.");
      } else {
        toastApiError(error, "Failed to save runtime configuration");
      }
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!canEdit || !override || saving) return;
    const confirmed = await confirm({
      title: "Reset Tag Configuration?",
      description: "This removes the Tag override and republishes the Default configuration.",
      confirmLabel: "Reset to default",
      variant: "destructive",
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await api.deletePageRuntimeConfigTag(projectId, selectedTarget, override.generation);
      await load(true);
      toast.success("Tag now inherits the Default configuration");
    } catch (error) {
      toastApiError(error, "Failed to reset Tag configuration");
    } finally {
      setSaving(false);
    }
  };

  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {override && (
        <Button variant="outline" onClick={() => void reset()} disabled={!canEdit || saving}>
          <RotateCcw className="h-4 w-4" />
          Reset to default
        </Button>
      )}
      <Button onClick={() => void save()} disabled={!canSave}>
        <Save className="h-4 w-4" />
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );

  useContentLoading(loading && !snapshot);

  return (
    <PanelShell
      icon={<Code2 className="h-4 w-4" />}
      title="Runtime configuration"
      description="Public JSON exposed as window.runtime.config. Do not store secrets."
      actions={actions}
      className="flex min-h-0 flex-1 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      wrapHeader
      dirty={dirty}
    >
      <SettingsControlRow
        title="Configuration"
        description="Default applies to previews and Tags without an override."
        help="This public JSON is injected into the deployed Pages application and can be read in browser code from window.runtime.config. Tag overrides replace the Default value only for deployments published to that Tag. Never store secrets here."
        controlsClassName="sm:min-w-56"
      >
        <div className="flex w-full items-center gap-2">
          <Select
            value={selectedTarget}
            onValueChange={(value) => void chooseTarget(value)}
            disabled={loading || !snapshot}
          >
            <SelectTrigger aria-label="Runtime configuration target">
              <SelectValue placeholder="Select configuration target" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_TARGET}>Default</SelectItem>
              {snapshot?.tags.map((tag) => (
                <SelectItem key={tag.id} value={tag.id}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {inherited && <Badge variant="secondary">Inherited</Badge>}
        </div>
      </SettingsControlRow>

      {loading && !snapshot ? null : loadError ? (
        <p className="flex-1 p-4 text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {(validation.error || conflicted) && (
            <p className="flex items-start gap-2 px-4 py-2 text-sm text-destructive" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {conflicted
                ? "Runtime configuration changed elsewhere. Reload this tab before saving again."
                : validation.error}
            </p>
          )}
          <CodeEditor
            value={source}
            onChange={(value) => setSource(value)}
            language="json"
            readOnly={!canEdit}
            minHeight="0px"
            bordered={false}
            showGutterBorder={false}
            className="min-h-0 flex-1"
            errorLines={validation.errorLines}
          />
        </div>
      )}
    </PanelShell>
  );
}
