import { Eye, FlaskConical, HelpCircle, Minus, Plus, Save, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { CreateFolderSelect, getCreateFolderChoices } from "@/components/common/CreateFolderSelect";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { ReferenceTable, type ReferenceTableRow } from "@/components/common/ReferenceTable";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { analyzeTemplateContent } from "@/lib/nginx-template-analysis";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { ProxyHostType, TemplateVariableDef } from "@/types";

const CHEATSHEET_VARIABLES: ReferenceTableRow[] = [
  { term: "{{id}}", description: "Host UUID" },
  { term: "{{serverNames}}", description: "Space-separated domains" },
  { term: "{{upstream}}", description: "scheme://host:port" },
  { term: "{{forwardScheme}}", description: "http or https" },
  { term: "{{forwardHost}}", description: "Upstream hostname" },
  { term: "{{forwardPort}}", description: "Upstream port" },
  { term: "{{sslEnabled}}", description: "Boolean" },
  { term: "{{sslForced}}", description: "Boolean" },
  { term: "{{http2Support}}", description: "Boolean" },
  { term: "{{websocketSupport}}", description: "Boolean" },
  { term: "{{sslCertPath}}", description: "SSL cert file path" },
  { term: "{{sslKeyPath}}", description: "SSL key file path" },
  { term: "{{sslChainPath}}", description: "SSL chain file path" },
  { term: "{{redirectUrl}}", description: "Redirect target URL" },
  { term: "{{redirectStatusCode}}", description: "301/302/307/308" },
  { term: "{{cacheEnabled}}", description: "Boolean" },
  { term: "{{cacheMaxAge}}", description: "Seconds" },
  { term: "{{rateLimitEnabled}}", description: "Boolean" },
  { term: "{{rateLimitRPS}}", description: "Requests/sec" },
  { term: "{{rateLimitBurst}}", description: "Burst size" },
  { term: "{{connectionsPerIp}}", description: "Concurrent connections per client IP" },
  { term: "{{logPath}}", description: "Log file base path" },
  { term: "{{advancedConfig}}", description: "Raw advanced config" },
  { term: "{{#each customHeaders}}", description: "Iterate custom headers" },
  { term: "{{#each customRewrites}}", description: "Iterate rewrite rules" },
  { term: "{{#each accessList.ipRules}}", description: "Iterate access-list IP rules" },
];

const CHEATSHEET_HELPERS: ReferenceTableRow[] = [
  { term: "{{#if sslEnabled}} ... {{/if}}", description: "Conditional rendering" },
  { term: "{{#unless sslForced}} ... {{/unless}}", description: "Inverse conditional rendering" },
  { term: "{{sanitize value}}", description: "Strip dangerous characters from values" },
  {
    term: "{{sanitizeRewrite value}}",
    description: "Like sanitize, but keeps $ for rewrite regexes",
  },
  { term: "{{#if (eq a b)}} ... {{/if}}", description: "Equality comparison" },
];

export function NginxTemplateEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id;
  const backHref = "/routes/templates";

  const [isLoading, setIsLoading] = useState(!isNew);
  const [isSaving, setIsSaving] = useState(false);
  const [isBuiltin, setIsBuiltin] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<ProxyHostType>("proxy");
  const [content, setContent] = useState("");
  const [variables, setVariables] = useState<TemplateVariableDef[]>([]);
  const [folderId, setFolderId] = useState("");
  /** The template as last loaded or saved: what the editor compares against for unsaved changes. */
  const [saved, setSaved] = useState<{
    name: string;
    description: string;
    content: string;
    variables: string;
  } | null>(null);
  const scopes = useAuthStore((s) => s.user?.scopes);
  const templateFolders = useResourceFolderStore((state) => state.foldersByType["nginx-template"]);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType["nginx-template"]);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  // Same destinations the create route accepts: proxy:templates:manage broadly or on the folder.
  const folderChoices = useMemo(
    () => getCreateFolderChoices(scopes ?? [], "proxy:templates:manage", templateFolders ?? []),
    [scopes, templateFolders]
  );

  useEffect(() => {
    if (isNew) void fetchFolders("nginx-template");
  }, [fetchFolders, isNew]);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewResult, setPreviewResult] = useState("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [isTesting, setIsTesting] = useState(false);

  const templateDiagnostics = useMemo(
    () =>
      analyzeTemplateContent(
        content,
        variables.map((variable) => variable.name.trim()).filter(Boolean)
      ),
    [content, variables]
  );

  const loadTemplate = useCallback(async () => {
    if (isNew || !id) return;
    setIsLoading(true);
    try {
      const t = await api.getNginxTemplate(id);
      setName(t.name);
      setDescription(t.description || "");
      setType(t.type);
      setContent(t.content);
      setVariables(t.variables || []);
      setIsBuiltin(t.isBuiltin);
      setSaved({
        name: t.name,
        description: t.description || "",
        content: t.content,
        variables: JSON.stringify(t.variables || []),
      });
    } catch {
      toast.error("Failed to load template");
      navigate(backHref);
    } finally {
      setIsLoading(false);
    }
  }, [id, isNew, navigate]);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  useRealtime(!isNew ? "nginx.template.changed" : null, (payload) => {
    const event = payload as { id?: string; action?: string } | undefined;
    if (!id || (event?.id && event.id !== id)) return;
    if (event?.action === "deleted") {
      toast.error("Template was deleted");
      navigate(backHref);
      return;
    }
    loadTemplate();
  });

  // Unsaved changes of an existing template, per field: the warning border of a changed value.
  const nameChanged = saved !== null && name !== saved.name;
  const descriptionChanged = saved !== null && description !== saved.description;
  const contentChanged = saved !== null && content !== saved.content;
  const variablesChanged = saved !== null && JSON.stringify(variables) !== saved.variables;
  const dirty = isNew || nameChanged || descriptionChanged || contentChanged || variablesChanged;
  const changedStyle = { borderColor: "var(--color-warning)" };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!content.trim()) {
      toast.error("Template content is required");
      return;
    }

    setIsSaving(true);
    try {
      const validVars = variables.filter((v) => v.name.trim());
      if (isNew) {
        const t = await api.createNginxTemplate({
          name,
          description: description || undefined,
          type,
          content,
          variables: validVars,
          folderId: folderId || null,
        });
        toast.success("Template created");
        navigate(`/nginx-templates/${t.id}`, { replace: true });
      } else {
        await api.updateNginxTemplate(id!, {
          name,
          description: description || null,
          content,
          variables: validVars,
        });
        setSaved({ name, description, content, variables: JSON.stringify(variables) });
        toast.success("Template saved");
      }
    } catch (err) {
      toastApiError(err, "Failed to save template");
    } finally {
      setIsSaving(false);
    }
  };

  const handlePreview = async () => {
    setPreviewOpen(true);
    setIsPreviewLoading(true);
    try {
      const result = await api.previewNginxTemplate(content);
      setPreviewResult(result.rendered);
    } catch (err) {
      setPreviewResult(`Error: ${err instanceof Error ? err.message : "Preview failed"}`);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const result = await api.testNginxTemplate(content, id);
      if (result.valid) {
        toast.success("Config test passed");
      } else {
        toast.error(result.errors.join(", ") || "Config test failed");
      }
    } catch (err) {
      toastApiError(err, "Test failed");
    } finally {
      setIsTesting(false);
    }
  };

  const updateVariable = (
    index: number,
    patch: Partial<Pick<TemplateVariableDef, "name" | "type" | "default" | "description">>
  ) => {
    setVariables((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  };

  const addVariable = () => {
    setVariables((prev) => [...prev, { name: "", type: "string", description: "" }]);
  };

  const removeVariable = (index: number) => {
    setVariables((prev) => prev.filter((_, i) => i !== index));
  };

  const headerActions = [
    ...(!isBuiltin
      ? [
          {
            id: "template:settings",
            label: "Template settings",
            icon: <Settings2 className="h-4 w-4" />,
            onClick: () => setSettingsOpen(true),
          },
        ]
      : []),
    {
      id: "template:test",
      label: isTesting ? "Testing template" : "Test template",
      icon: <FlaskConical className="h-4 w-4" />,
      disabled: !content.trim() || isTesting,
      onClick: handleTest,
    },
    ...(!isBuiltin
      ? [
          {
            id: "template:save",
            label: isSaving ? "Saving template" : "Save template",
            icon: <Save className="h-4 w-4" />,
            disabled: isSaving || !dirty || !name.trim() || !content.trim(),
            onClick: handleSave,
          },
        ]
      : []),
    {
      id: "template:preview",
      label: "Preview template",
      icon: <Eye className="h-4 w-4" />,
      disabled: !content.trim(),
      onClick: handlePreview,
      separatorBefore: true,
    },
    {
      id: "template:cheatsheet",
      label: "Variables cheatsheet",
      icon: <HelpCircle className="h-4 w-4" />,
      onClick: () => setCheatsheetOpen(true),
    },
  ];

  if (isLoading) return <NginxTemplateEditorSkeleton />;

  return (
    <PageTransition>
      <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
        <PageHeader
          className="min-w-0 shrink-0"
          leading={<PageBackButton onClick={() => navigate(backHref)} />}
          title={isNew ? "Create Config Template" : name}
          badges={
            <>
              <Badge variant="secondary" size="inline" className="uppercase">
                {type}
              </Badge>
              {isBuiltin && (
                <Badge variant="outline" size="inline">
                  Built-in
                </Badge>
              )}
            </>
          }
          description={
            isNew
              ? "Define a Handlebars nginx server block template"
              : isBuiltin
                ? "Built-in template (read-only)"
                : "Edit nginx config template"
          }
          actions={
            <ResponsiveHeaderActions actions={headerActions}>
              {!isBuiltin && (
                <Button variant="outline" onClick={() => setSettingsOpen(true)}>
                  <Settings2 className="h-4 w-4" />
                  Settings
                </Button>
              )}
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={!content.trim()}
                pending={isTesting}
              >
                <FlaskConical className="h-4 w-4" />
                Test
              </Button>
              {!isBuiltin && (
                <Button
                  variant="outline"
                  onClick={handleSave}
                  disabled={!dirty || !name.trim() || !content.trim()}
                  pending={isSaving}
                >
                  <Save className="h-4 w-4" />
                  Save
                </Button>
              )}
              <Button variant="outline" onClick={handlePreview} disabled={!content.trim()}>
                <Eye className="h-4 w-4" />
                Preview
              </Button>
              <Button variant="outline" onClick={() => setCheatsheetOpen(true)}>
                <HelpCircle className="h-4 w-4" />
                Variables Cheatsheet
              </Button>
            </ResponsiveHeaderActions>
          }
        />

        <div
          className={
            isNew
              ? "grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_12rem] shrink-0"
              : "grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem] shrink-0"
          }
        >
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isBuiltin}
              style={nameChanged ? changedStyle : undefined}
              placeholder="Template name"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isBuiltin}
              style={descriptionChanged ? changedStyle : undefined}
              placeholder="Optional description"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Host Type</label>
            <Select
              value={type}
              onValueChange={(value) => setType(value as ProxyHostType)}
              disabled={!isNew}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="proxy">Proxy</SelectItem>
                <SelectItem value="redirect">Redirect</SelectItem>
                <SelectItem value="404">404</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {isNew && (
            <div className="space-y-1.5">
              <label htmlFor="nginx-template-folder" className="text-xs text-muted-foreground">
                Folder
              </label>
              <CreateFolderSelect
                id="nginx-template-folder"
                choices={folderChoices}
                value={folderId}
                onChange={setFolderId}
                loading={foldersLoading}
              />
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 flex flex-col relative">
          <CodeEditor
            value={content}
            onChange={setContent}
            readOnly={isBuiltin}
            className={contentChanged ? "!border-warning" : ""}
            errorLines={templateDiagnostics.errorLines}
            errorRanges={templateDiagnostics.errorRanges}
            showGutterBorder={false}
          />
        </div>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        {/* The preview takes the dialog's full height; the editor fills it and scrolls inside. */}
        <DialogContent className="h-[calc(100dvh-6rem)] w-[92vw] sm:max-w-5xl" fillHeight>
          <DialogHeader>
            <DialogTitle>Rendered Preview</DialogTitle>
          </DialogHeader>
          <DialogDescription>Preview the template rendered with sample data.</DialogDescription>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ContentLoading loading={isPreviewLoading} />
            <CodeEditor
              value={previewResult}
              onChange={() => {}}
              readOnly
              className="border-border"
              height="100%"
              showGutterBorder={false}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cheatsheetOpen} onOpenChange={setCheatsheetOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Template Cheatsheet</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Variables and Handlebars helpers available in nginx templates.
          </DialogDescription>
          <div className="space-y-5">
            <ReferenceTable title="Variables" termLabel="Variable" rows={CHEATSHEET_VARIABLES} />
            <ReferenceTable title="Helpers" termLabel="Usage" rows={CHEATSHEET_HELPERS} />
          </div>
        </DialogContent>
      </Dialog>

      {!isBuiltin && (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="w-[90vw] sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Template Settings</DialogTitle>
            </DialogHeader>
            <DialogDescription>
              Configure custom variables that proxy hosts can fill when using this template.
            </DialogDescription>
            <PanelShell
              title="Custom Variables"
              dirty={variablesChanged}
              description={
                <>
                  Use them inside the template as{" "}
                  <code className="bg-muted px-1">{"{{variableName}}"}</code>.
                </>
              }
              actions={
                <Button variant="outline" onClick={addVariable}>
                  <Plus />
                  Add
                </Button>
              }
              className="overflow-visible"
            >
              <div className="overflow-x-hidden">
                <div className="w-full min-w-0">
                  {variables.length > 0 && (
                    <div className="grid grid-cols-[9rem_7rem_8rem_minmax(0,1fr)_2.25rem] border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider sticky top-0 z-10 bg-card">
                      <div className="px-3 py-2">Variable</div>
                      <div className="px-3 py-2 border-l border-border">Type</div>
                      <div className="px-3 py-2 border-l border-border">Default</div>
                      <div className="px-3 py-2 border-l border-border">Description</div>
                      <div />
                    </div>
                  )}
                  <div>
                    {variables.length > 0 ? (
                      variables.map((variable, index) => (
                        <div
                          key={`variable-${index}`}
                          className="grid grid-cols-[9rem_7rem_8rem_minmax(0,1fr)_2.25rem] border-b border-border last:border-b-0"
                        >
                          <Input
                            value={variable.name}
                            onChange={(e) => updateVariable(index, { name: e.target.value })}
                            placeholder="Variable name"
                            className="h-9 w-36 font-mono text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          />
                          <div className="border-l border-border">
                            <Select
                              value={variable.type}
                              onValueChange={(value) =>
                                updateVariable(index, {
                                  type: value as "string" | "number" | "boolean",
                                })
                              }
                            >
                              <SelectTrigger className="h-9 w-full border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="string">String</SelectItem>
                                <SelectItem value="number">Number</SelectItem>
                                <SelectItem value="boolean">Boolean</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="border-l border-border">
                            {variable.type === "boolean" ? (
                              <Select
                                value={
                                  variable.default === undefined
                                    ? "__none__"
                                    : variable.default
                                      ? "true"
                                      : "false"
                                }
                                onValueChange={(value) =>
                                  updateVariable(index, {
                                    default: value === "__none__" ? undefined : value === "true",
                                  })
                                }
                              >
                                <SelectTrigger className="h-9 w-full border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">None</SelectItem>
                                  <SelectItem value="true">True</SelectItem>
                                  <SelectItem value="false">False</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : (
                              <Input
                                value={String(variable.default ?? "")}
                                onChange={(e) =>
                                  updateVariable(index, {
                                    default:
                                      variable.type === "number"
                                        ? e.target.value
                                          ? Number(e.target.value)
                                          : undefined
                                        : e.target.value || undefined,
                                  })
                                }
                                placeholder="Default"
                                className="h-9 w-full text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                              />
                            )}
                          </div>
                          <div className="border-l border-border">
                            <Input
                              value={variable.description || ""}
                              onChange={(e) =>
                                updateVariable(index, { description: e.target.value || undefined })
                              }
                              placeholder="Description"
                              className="h-9 w-full min-w-0 text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                            />
                          </div>
                          <div className="flex items-center justify-center border-l border-border">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="w-full rounded-none"
                              aria-label={`Remove variable ${index + 1}`}
                              onClick={() => removeVariable(index)}
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <EmptyState message="No custom variables configured." embedded />
                    )}
                  </div>
                </div>
              </div>
            </PanelShell>
          </DialogContent>
        </Dialog>
      )}
    </PageTransition>
  );
}

function NginxTemplateEditorSkeleton() {
  return <DetailPageSkeleton label="Loading config template" />;
}
