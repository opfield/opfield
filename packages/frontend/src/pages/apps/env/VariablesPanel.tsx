// An environment's variables and secrets (canvas frames env-live, env-staging): the container
// Environment tab's editor. Values reach each workload on its next recreate or deploy; "Save and
// recreate N workloads" recreates them one at a time right away.
import { Code2, Minus, Plus, RotateCcw, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type SecretRow, SecretsSection } from "@/pages/docker-detail/SecretsSection";
import { api } from "@/services/api";
import type { AppDetail, AppEnvironmentDetail, AppPendingWorkload, AppVariables } from "@/types";
import { MoreMenu, plural } from "../app-shared";
import { RecreateWorkloadsDialog } from "../dialogs/RecreateWorkloadsDialog";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MASK = "••••••••";

interface VarRow {
  key: string;
  value: string;
}

function parseRaw(text: string): VarRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
      const index = stripped.indexOf("=");
      return index >= 0
        ? { key: stripped.slice(0, index), value: stripped.slice(index + 1) }
        : { key: stripped, value: "" };
    });
}

function rawErrorLines(text: string): number[] {
  const errors = new Set<number>();
  const seen = new Map<string, number[]>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = stripped.indexOf("=");
    const key = eq >= 1 ? stripped.slice(0, eq) : "";
    if (!KEY_PATTERN.test(key)) {
      errors.add(index + 1);
      return;
    }
    seen.set(key, [...(seen.get(key) ?? []), index + 1]);
  });
  for (const lines of seen.values())
    if (lines.length > 1) for (const line of lines) errors.add(line);
  return [...errors].sort((a, b) => a - b);
}

const sameRows = (a: VarRow[], b: VarRow[]) =>
  a.length === b.length &&
  a.every((row, index) => row.key === b[index]?.key && row.value === b[index]?.value);

const secretRowsOf = (data: AppVariables): SecretRow[] =>
  data.secrets.map((secret) => ({ id: secret.key, key: secret.key, value: MASK, dirty: false }));

export function VariablesPanel({
  app,
  env,
  version,
}: {
  app: AppDetail;
  env: AppEnvironmentDetail;
  version: number;
}) {
  const [data, setData] = useState<AppVariables | null>(null);
  const [rows, setRows] = useState<VarRow[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("");
  const [secretRows, setSecretRows] = useState<SecretRow[]>([]);
  const [deletedSecrets, setDeletedSecrets] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState<"variables" | "secrets" | "both" | null>(null);
  const [recreating, setRecreating] = useState<AppPendingWorkload[] | null>(null);

  const apply = useCallback((next: AppVariables) => {
    setData(next);
    setRows(next.variables.map((item) => ({ key: item.key, value: item.value })));
    setRawText(next.variables.map((item) => `${item.key}=${item.value}`).join("\n"));
    setSecretRows(secretRowsOf(next));
    setDeletedSecrets(new Map());
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.getAppVariables(app.id, env.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load variables");
    }
  }, [app.id, env.id, apply]);

  // Reloads on realtime changes only while nothing is being edited.
  const [loadedVersion, setLoadedVersion] = useState(-1);
  const editedVariables = rawMode
    ? !sameRows(parseRaw(rawText), data?.variables ?? [])
    : !sameRows(rows, data?.variables ?? []);
  const editedSecrets = deletedSecrets.size > 0 || secretRows.some((row) => row.dirty);
  useEffect(() => {
    if (loadedVersion === version || editedVariables || editedSecrets) return;
    setLoadedVersion(version);
    void load();
  }, [version, loadedVersion, editedVariables, editedSecrets, load]);

  const tableErrors = useMemo(() => {
    const errors = new Set<number>();
    const seen = new Map<string, number[]>();
    rows.forEach((row, index) => {
      const key = row.key.trim();
      if (!key && !row.value) return;
      if (!KEY_PATTERN.test(key)) errors.add(index);
      seen.set(key, [...(seen.get(key) ?? []), index]);
    });
    for (const indices of seen.values())
      if (indices.length > 1) for (const i of indices) errors.add(i);
    return errors;
  }, [rows]);
  const rawErrors = useMemo(() => (rawMode ? rawErrorLines(rawText) : []), [rawMode, rawText]);
  const secretKeyErrors = useMemo(() => {
    const errors = new Set<number>();
    const seen = new Map<string, number[]>();
    const variableKeys = new Set((rawMode ? parseRaw(rawText) : rows).map((row) => row.key.trim()));
    secretRows.forEach((row, index) => {
      const key = row.key.trim();
      if (!key) return;
      // One key is either a variable or a secret.
      if (variableKeys.has(key)) errors.add(index);
      seen.set(key, [...(seen.get(key) ?? []), index]);
    });
    for (const indices of seen.values())
      if (indices.length > 1) for (const i of indices) errors.add(i);
    return errors;
  }, [secretRows, rows, rawMode, rawText]);
  const hasVariableErrors = rawMode ? rawErrors.length > 0 : tableErrors.size > 0;
  const hasSecretErrors =
    secretKeyErrors.size > 0 ||
    secretRows.some((row) => row.dirty && (!KEY_PATTERN.test(row.key.trim()) || !row.value));

  const variablesPayload = () =>
    (rawMode ? parseRaw(rawText) : rows)
      .map((row) => ({ key: row.key.trim(), value: row.value }))
      .filter((row) => row.key);

  const secretsPatch = () => ({
    set: Object.fromEntries(
      secretRows.filter((row) => row.dirty && row.value).map((row) => [row.key.trim(), row.value])
    ),
    delete: [...deletedSecrets.values()],
  });

  const workloadCount =
    (env.memberCounts.container ?? 0) +
    (env.memberCounts.deployment ?? 0) +
    (env.memberCounts.compose ?? 0);

  const save = async (which: "variables" | "secrets" | "both", recreate = false) => {
    setSaving(which);
    try {
      let next: AppVariables | null = null;
      if (
        (which === "variables" || which === "both") &&
        (editedVariables || which === "variables")
      ) {
        next = await api.setAppVariables(app.id, env.id, variablesPayload());
      }
      if ((which === "secrets" || which === "both") && editedSecrets) {
        next = await api.patchAppSecrets(app.id, env.id, secretsPatch());
      }
      if (!next) next = await api.getAppVariables(app.id, env.id);
      apply(next);
      setRawMode(false);
      const pending = next.pendingWorkloads.length;
      if (recreate && pending > 0) {
        setRecreating(next.pendingWorkloads);
      } else {
        toast.success(
          pending > 0
            ? `Saved · ${plural(pending, "workload")} get${pending === 1 ? "s" : ""} the new values on their next recreate or deploy`
            : "Saved"
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  };

  const update = (index: number, field: keyof VarRow, value: string) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  const switchToRaw = () => {
    setRawText(rows.map((row) => `${row.key}=${row.value}`).join("\n"));
    setRawMode(true);
  };
  const switchToTable = () => {
    setRows(parseRaw(rawText));
    setRawMode(false);
  };

  if (!data) return <ContentLoading loading />;

  const pending = data.pendingWorkloads;
  const dirty = editedVariables || editedSecrets;

  return (
    <>
      {pending.length > 0 && !dirty && (
        <Notice
          tone="warning"
          title={`${plural(pending.length, "workload")} ${pending.length === 1 ? "runs" : "run"} older values`}
          actions={
            <NoticeAction tone="warning" onClick={() => setRecreating(pending)}>
              Recreate {plural(pending.length, "workload")}
            </NoticeAction>
          }
        >
          {pending
            .slice(0, 3)
            .map((workload) => workload.name)
            .join(", ")}
          {pending.length > 3 ? ` and ${pending.length - 3} more` : ""} get the current variables
          and secrets on their next recreate or deploy.
        </Notice>
      )}
      <PanelShell
        title={`Variables · ${env.name}`}
        description={`Injected into every container of ${env.name}`}
        dirty={editedVariables}
        className={rawMode ? "overflow-visible" : undefined}
        actions={
          <>
            <Button
              variant="warning"
              onClick={() => void save("variables")}
              pending={saving === "variables"}
              disabled={!editedVariables || hasVariableErrors || saving !== null}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Save
            </Button>
            <MoreMenu label={`More variable actions for ${env.name}`}>
              <DropdownMenuItem
                disabled={
                  !dirty ||
                  hasVariableErrors ||
                  hasSecretErrors ||
                  saving !== null ||
                  workloadCount === 0
                }
                onClick={() => void save("both", true)}
              >
                <RotateCcw className="h-4 w-4" />
                Save and recreate {plural(workloadCount, "workload")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {!rawMode && (
                <DropdownMenuItem
                  onClick={() => setRows((current) => [...current, { key: "", value: "" }])}
                >
                  <Plus className="h-4 w-4" />
                  Add variable
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={hasVariableErrors}
                onClick={rawMode ? switchToTable : switchToRaw}
              >
                {rawMode ? <Table2 className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}
                {rawMode ? "Table view" : "Raw view"}
              </DropdownMenuItem>
            </MoreMenu>
          </>
        }
      >
        {rawMode ? (
          <CodeEditor
            value={rawText}
            onChange={setRawText}
            language="env"
            errorLines={rawErrors}
            minHeight="200px"
            className="-m-px"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            message="No variables yet."
            actionLabel="Add one"
            onAction={() => setRows([{ key: "", value: "" }])}
            embedded
          />
        ) : (
          <>
            <div className="grid grid-cols-[1fr_1fr] border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <div className="px-3 py-2">Key</div>
              <div className="border-l border-border px-3 py-2">Value</div>
            </div>
            {rows.map((row, index) => (
              <div
                key={index}
                className="grid grid-cols-[1fr_1fr] border-b border-border last:border-b-0"
              >
                <Input
                  value={row.key}
                  onChange={(event) => update(index, "key", event.target.value)}
                  className={cn(
                    "h-9 rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    tableErrors.has(index) && "bg-destructive/10 text-destructive"
                  )}
                  placeholder="KEY"
                  aria-label={`Variable ${index + 1} key`}
                />
                <div className="flex items-center border-l border-border">
                  <Input
                    value={row.value}
                    onChange={(event) => update(index, "value", event.target.value)}
                    className="h-9 min-w-0 flex-1 rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    placeholder="value"
                    aria-label={`Variable ${index + 1} value`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 rounded-none border-l border-border"
                    title="Remove variable"
                    aria-label={`Remove variable ${row.key || index + 1}`}
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </>
        )}
      </PanelShell>
      <SecretsSection
        canManageSecrets
        onSave={() => void save("secrets")}
        isSaving={saving === "secrets"}
        saveDisabled={!editedSecrets || hasSecretErrors || saving !== null}
        secretRows={secretRows}
        setSecretRows={setSecretRows}
        setDeletedSecrets={setDeletedSecrets}
        duplicateSecretIndices={secretKeyErrors}
        invalidKeyPattern={KEY_PATTERN}
        description={`Encrypted values for every container of ${env.name}`}
      />
      <RecreateWorkloadsDialog
        environmentName={env.name}
        workloads={recreating}
        onClose={() => setRecreating(null)}
        onFinished={() => void load()}
      />
    </>
  );
}
