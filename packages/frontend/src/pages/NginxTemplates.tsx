import { Copy, FileCode, FolderPlus, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor, codeEditorHeightForLines } from "@/components/ui/code-editor";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { hasCreationDestination } from "@/lib/creation-folders";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { NginxTemplate } from "@/types";

export function getTemplatePreviewEditorHeight(content: string): string {
  const lineCount = Math.max(1, content.split("\n").length);
  const height = Math.min(Math.max(codeEditorHeightForLines(lineCount), 120), 640);
  return `min(64dvh, ${height}px)`;
}

/** Read-only folder that holds the built-in templates above the operator's folders. */
const BUILTIN_FOLDER_ID = "nginx-templates-builtin";

const stopRowEvent = (event: SyntheticEvent) => event.stopPropagation();

export function NginxTemplates({
  embedded,
  onCreateRef,
  onCreateFolderRef,
}: {
  embedded?: boolean;
  onCreateRef?: (fn: () => void) => void;
  onCreateFolderRef?: (fn: () => void) => void;
}) {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const canViewTemplates = hasScopedAccess("proxy:templates:view");
  const cachedTemplates = canViewTemplates
    ? api.getCached<NginxTemplate[]>("nginx-templates:list")
    : undefined;
  const [templates, setTemplates] = useState<NginxTemplate[]>(cachedTemplates ?? []);
  const [isLoading, setIsLoading] = useState(canViewTemplates && !cachedTemplates);
  const {
    open: previewOpen,
    value: previewTemplate,
    setValue: setPreviewTemplate,
    onOpenChange: onPreviewOpenChange,
  } = useDeferredDialogState<NginxTemplate>();
  const [previewContent, setPreviewContent] = useState("");
  const [search, setSearch] = useState("");
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const previewEditorHeight = useMemo(
    () => getTemplatePreviewEditorHeight(previewContent),
    [previewContent]
  );

  const load = useCallback(async () => {
    if (!canViewTemplates) {
      setTemplates([]);
      setIsLoading(false);
      return;
    }
    try {
      const data = await api.listNginxTemplates();
      setTemplates(data || []);
    } catch {
      toast.error("Failed to load templates");
    } finally {
      setIsLoading(false);
    }
  }, [canViewTemplates]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtime("nginx.template.changed", () => {
    load();
  });

  // Deleting a folder moves its templates to ungrouped.
  useRealtime("nginx.template.folder.changed", () => {
    load();
  });

  // Expose create action to parent
  const createRefSet = useRef(false);
  if (onCreateRef && !createRefSet.current) {
    onCreateRef(() => navigate("/nginx-templates/new"));
    createRefSet.current = true;
  }

  const handleClone = async (id: string) => {
    try {
      const clone = await api.cloneNginxTemplate(id);
      toast.success("Template cloned");
      navigate(`/nginx-templates/${clone.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clone");
    }
  };

  const handleDelete = async (t: NginxTemplate) => {
    const ok = await confirm({
      title: "Delete Template",
      description: `Delete "${t.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteNginxTemplate(t.id);
      toast.success("Template deleted");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const handlePreview = async (template: NginxTemplate) => {
    try {
      const result = await api.previewNginxTemplate(template.content);
      setPreviewContent(result.rendered);
      setPreviewTemplate(template);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to render preview");
    }
  };

  const canManageTemplates = hasScope("proxy:templates:manage");
  // Creating needs proxy:templates:manage broadly or on a destination folder.
  const canCreateTemplates = hasCreationDestination(user?.scopes ?? [], "proxy:templates:manage");
  const canManageFolders = useCanManageSomeFolders("proxy:templates:folders:manage");
  // Mirrors the template routes: manage:<id> edits and deletes, clone reads the
  // source and creates a new template (broad manage).
  const templateAccess = (template: NginxTemplate) => {
    const canManageTemplate = hasScope(`proxy:templates:manage:${template.id}`);
    const canView = hasScope(`proxy:templates:view:${template.id}`);
    return {
      canView,
      canEdit: canManageTemplate && !template.isBuiltin,
      canClone: canManageTemplates && canView,
      canDelete: canManageTemplate && !template.isBuiltin,
    };
  };
  const openTemplate = (template: NginxTemplate) => {
    const access = templateAccess(template);
    if (access.canEdit) navigate(`/nginx-templates/${template.id}`);
    else if (access.canView) void handlePreview(template);
  };

  const query = search.trim().toLowerCase();
  const visibleTemplates = query
    ? templates.filter((template) =>
        [template.name, template.description].some((value) => value?.toLowerCase().includes(query))
      )
    : templates;
  // Built-in templates keep the server's order.
  const builtinTemplates = visibleTemplates
    .filter((template) => template.isBuiltin)
    .map((template, index) => ({ ...template, sortOrder: index }));
  const customTemplates = visibleTemplates.filter((template) => !template.isBuiltin);

  const columns: ResourceListColumn<NginxTemplate>[] = [
    {
      id: "name",
      label: "Name",
      renderCell: (template) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{template.name}</span>
            {template.isBuiltin && <Badge size="inline">Built-in</Badge>}
          </div>
          {template.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {template.description}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "type",
      label: "Type",
      width: "8rem",
      align: "right",
      renderCell: (template) => <Badge variant="secondary">{template.type}</Badge>,
    },
    {
      id: "actions",
      label: "Actions",
      align: "right",
      width: "5rem",
      renderCell: (template) => {
        const access = templateAccess(template);
        if (!access.canEdit && !access.canClone && !access.canDelete) return null;
        return (
          <div className="flex justify-end" onClick={stopRowEvent} onPointerDown={stopRowEvent}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Actions for ${template.name}`}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {access.canEdit && (
                  <DropdownMenuItem onClick={() => navigate(`/nginx-templates/${template.id}`)}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                )}
                {access.canClone && (
                  <DropdownMenuItem onClick={() => handleClone(template.id)}>
                    <Copy className="h-4 w-4" />
                    Clone
                  </DropdownMenuItem>
                )}
                {access.canDelete && (
                  <>
                    {(access.canEdit || access.canClone) && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={() => handleDelete(template)}
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  if (!canViewTemplates) {
    return null;
  }

  const content = (
    <>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <PageHeader
            title="Config Templates"
            description="Nginx server block templates for proxy hosts"
            actions={
              <ResponsiveHeaderActions
                actions={[
                  ...(canManageFolders && createFolderAction
                    ? [
                        {
                          label: "Add Folder",
                          icon: <FolderPlus className="h-4 w-4" />,
                          onClick: createFolderAction,
                        },
                      ]
                    : []),
                  ...(canCreateTemplates
                    ? [
                        {
                          label: "Create Template",
                          icon: <Plus className="h-4 w-4" />,
                          onClick: () => navigate("/nginx-templates/new"),
                        },
                      ]
                    : []),
                ]}
              >
                {canManageFolders && (
                  <Button variant="outline" onClick={() => createFolderAction?.()}>
                    <FolderPlus className="h-4 w-4" />
                    Add Folder
                  </Button>
                )}
                {canCreateTemplates && (
                  <Button onClick={() => navigate("/nginx-templates/new")}>
                    <Plus className="h-4 w-4" />
                    Create Template
                  </Button>
                )}
              </ResponsiveHeaderActions>
            }
          />
        )}

        <FolderedResourceList<NginxTemplate>
          resourceType="nginx-template"
          realtimeChannel="nginx.template.folder.changed"
          resources={customTemplates}
          systemFolders={[{ id: BUILTIN_FOLDER_ID, name: "Built-in", items: builtinTemplates }]}
          columns={columns}
          search={{
            placeholder: "Search templates...",
            search,
            onSearchChange: setSearch,
            hasActiveFilters: search !== "",
            onReset: () => setSearch(""),
          }}
          loading={isLoading}
          loadingLabel="Loading config templates..."
          emptyState={
            <EmptyState
              message="No config templates."
              actionLabel={canCreateTemplates ? "Create one" : undefined}
              actionHref={canCreateTemplates ? "/nginx-templates/new" : undefined}
              hasActiveFilters={search !== ""}
              onReset={() => setSearch("")}
            />
          }
          minWidth={600}
          canManageFolders={canManageFolders}
          canViewItem={(template) => {
            const access = templateAccess(template);
            return access.canEdit || access.canView;
          }}
          canReorganizeItem={(template) =>
            canManageFolders &&
            !template.isBuiltin &&
            hasScope(`proxy:templates:manage:${template.id}`)
          }
          getResourceLabel={(template) => template.name}
          onItemClick={openTemplate}
          onRefresh={load}
          onCreateFolderRef={(fn) => {
            setCreateFolderAction(() => fn);
            onCreateFolderRef?.(fn);
          }}
        />
      </div>
      <Dialog open={previewOpen} onOpenChange={onPreviewOpenChange}>
        <DialogContent className="w-[92vw] sm:max-w-[64rem]">
          <DialogHeader>
            <DialogTitle>{previewTemplate?.name ?? "Template Preview"}</DialogTitle>
          </DialogHeader>
          <CodeEditor
            value={previewContent}
            onChange={() => {}}
            readOnly
            language="nginx"
            height={previewEditorHeight}
            lineWrapping={false}
            showGutterBorder={false}
          />
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) return content;
  return <PageTransition>{content}</PageTransition>;
}
