import { FileText, FolderPlus, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CreateFolderSelect } from "@/components/common/CreateFolderSelect";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { flattenCreationFolders, placementFolderChoices } from "@/lib/creation-folders";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type {
  CertificatePolicy,
  CertificateType,
  CustomExtension,
  KeyAlgorithm,
  Template,
} from "@/types";
import {
  StepCustomExtensions,
  StepDistribution,
  StepExtKeyUsage,
  StepGeneral,
  StepKeyUsage,
  StepPolicies,
  StepSAN,
  StepSubjectDN,
  WIZARD_STEPS,
} from "./PkiTemplateWizardSteps";

/** Read-only folder that holds the built-in templates above the operator's folders. */
const BUILTIN_FOLDER_ID = "pki-templates-builtin";

const stopRowEvent = (event: SyntheticEvent) => event.stopPropagation();

export function PkiTemplatesTab({
  embedded,
  onCreateRef,
  onCreateFolderRef,
}: {
  embedded?: boolean;
  onCreateRef?: (fn: () => void) => void;
  onCreateFolderRef?: (fn: () => void) => void;
}) {
  const { hasScope } = useAuthStore();
  const canListTemplates = hasScope("pki:templates:view");
  const canCreateTemplates = hasScope("pki:templates:create");
  const canEditTemplates = hasScope("pki:templates:edit");
  const canDeleteTemplates = hasScope("pki:templates:delete");
  const canManageFolders = useCanManageSomeFolders("pki:templates:folders:manage");
  const [folderId, setFolderId] = useState("");
  const templateFolders = useResourceFolderStore((state) => state.foldersByType["pki-template"]);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType["pki-template"]);
  // Templates are not folder-scopable: placing a new one needs the folder scope, like a move.
  const folderChoices = useMemo(
    () =>
      placementFolderChoices(flattenCreationFolders(templateFolders ?? []), () => canManageFolders),
    [canManageFolders, templateFolders]
  );
  const cachedTemplates = canListTemplates
    ? api.getCached<Template[]>("templates:list")
    : undefined;
  const [templates, setTemplates] = useState<Template[]>(cachedTemplates ?? []);
  const [isLoading, setIsLoading] = useState(canListTemplates && !cachedTemplates);
  const [search, setSearch] = useState("");
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  // Built-in templates open the same wizard with every field disabled.
  const [viewOnly, setViewOnly] = useState(false);
  const [step, setStep] = useState(0);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [certType, setCertType] = useState<CertificateType>("tls-server");
  const [keyAlgorithm, setKeyAlgorithm] = useState<KeyAlgorithm>("ecdsa-p256");
  const [validityDays, setValidityDays] = useState(365);
  const [keyUsage, setKeyUsage] = useState<string[]>([]);
  const [extKeyUsage, setExtKeyUsage] = useState<string[]>([]);
  const [customEkuOid, setCustomEkuOid] = useState("");
  const [requireSans, setRequireSans] = useState(true);
  const [sanTypes, setSanTypes] = useState<string[]>(["dns", "ip"]);
  const [dnO, setDnO] = useState("");
  const [dnOu, setDnOu] = useState("");
  const [dnL, setDnL] = useState("");
  const [dnSt, setDnSt] = useState("");
  const [dnC, setDnC] = useState("");
  const [crlDistributionPoints, setCrlDistributionPoints] = useState<string[]>([]);
  const [caIssuersUrl, setCaIssuersUrl] = useState("");
  const [certificatePolicies, setCertificatePolicies] = useState<CertificatePolicy[]>([]);
  const [customExtensions, setCustomExtensions] = useState<CustomExtension[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const loadTemplates = useCallback(async () => {
    if (!canListTemplates) {
      setTemplates([]);
      setIsLoading(false);
      return;
    }
    try {
      const data = await api.listTemplates();
      setTemplates(data || []);
    } catch {
      toast.error("Failed to load templates");
    } finally {
      setIsLoading(false);
    }
  }, [canListTemplates]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  useRealtime("pki.template.changed", () => {
    loadTemplates();
  });

  // Deleting a folder moves its templates to ungrouped.
  useRealtime("pki.template.folder.changed", () => {
    loadTemplates();
  });

  const resetForm = () => {
    setName("");
    setDescription("");
    setCertType("tls-server");
    setKeyAlgorithm("ecdsa-p256");
    setValidityDays(365);
    setKeyUsage([]);
    setExtKeyUsage([]);
    setCustomEkuOid("");
    setRequireSans(true);
    setSanTypes(["dns", "ip"]);
    setDnO("");
    setDnOu("");
    setDnL("");
    setDnSt("");
    setDnC("");
    setCrlDistributionPoints([]);
    setCaIssuersUrl("");
    setCertificatePolicies([]);
    setCustomExtensions([]);
    setFolderId("");
    setStep(0);
  };

  const openCreate = () => {
    setEditing(null);
    setViewOnly(false);
    resetForm();
    setDialogOpen(true);
  };

  // Expose create action to parent
  const createRefSet = useRef(false);
  if (onCreateRef && !createRefSet.current) {
    onCreateRef(openCreate);
    createRefSet.current = true;
  }

  const openEdit = (t: Template, { readOnly = false }: { readOnly?: boolean } = {}) => {
    setEditing(t);
    setViewOnly(readOnly);
    setName(t.name);
    setDescription(t.description || "");
    setCertType(t.certType);
    setKeyAlgorithm(t.keyAlgorithm);
    setValidityDays(t.validityDays);
    setKeyUsage(t.keyUsage || []);
    setExtKeyUsage(t.extKeyUsage || []);
    setRequireSans(t.requireSans);
    setSanTypes(t.sanTypes || []);
    setDnO(t.subjectDnFields?.o || "");
    setDnOu(t.subjectDnFields?.ou || "");
    setDnL(t.subjectDnFields?.l || "");
    setDnSt(t.subjectDnFields?.st || "");
    setDnC(t.subjectDnFields?.c || "");
    setCrlDistributionPoints(t.crlDistributionPoints || []);
    setCaIssuersUrl(t.authorityInfoAccess?.caIssuersUrl || "");
    setCertificatePolicies(t.certificatePolicies || []);
    setCustomExtensions(t.customExtensions || []);
    setStep(0);
    setDialogOpen(true);
  };

  const buildPayload = () => ({
    name,
    description: description || undefined,
    certType,
    keyAlgorithm,
    validityDays,
    keyUsage,
    extKeyUsage,
    requireSans,
    sanTypes,
    subjectDnFields: {
      ...(dnO ? { o: dnO } : {}),
      ...(dnOu ? { ou: dnOu } : {}),
      ...(dnL ? { l: dnL } : {}),
      ...(dnSt ? { st: dnSt } : {}),
      ...(dnC ? { c: dnC } : {}),
    },
    crlDistributionPoints: crlDistributionPoints.filter((u) => u.trim()),
    authorityInfoAccess: {
      ...(caIssuersUrl ? { caIssuersUrl } : {}),
    },
    certificatePolicies: certificatePolicies.filter((p) => p.oid.trim()),
    customExtensions: customExtensions.filter((e) => e.oid.trim() && e.value.trim()),
  });

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setIsSaving(true);
    try {
      const payload = buildPayload();
      if (editing) {
        await api.updateTemplate(editing.id, payload);
        toast.success("Template updated");
      } else {
        await api.createTemplate({ ...payload, folderId: folderId || null });
        toast.success("Template created");
      }
      setDialogOpen(false);
      loadTemplates();
    } catch (err) {
      if (!handleLicenseApiError(err, "Internal PKI templates")) {
        toastApiError(err, "Failed to save template");
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (template: Template) => {
    const ok = await confirm({
      title: "Delete Template",
      description: `Delete "${template.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteTemplate(template.id);
      toast.success("Template deleted");
      loadTemplates();
    } catch (err) {
      if (!handleLicenseApiError(err, "Internal PKI templates")) {
        toastApiError(err, "Failed to delete template");
      }
    }
  };

  const isLastStep = step === WIZARD_STEPS.length - 1;
  const canProceed =
    step === 0 ? name.trim() !== "" && validityDays >= 1 && validityDays <= 3650 : true;
  const canOpenTemplate = (template: Template) => template.isBuiltin || canEditTemplates;
  const query = search.trim().toLowerCase();
  const visibleTemplates = query
    ? templates.filter((template) =>
        [template.name, template.description].some((value) => value?.toLowerCase().includes(query))
      )
    : templates;
  const templateColumns: ResourceListColumn<Template>[] = [
    {
      id: "name",
      label: "Name",
      renderCell: (template) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{template.name}</span>
            {template.isBuiltin && <Badge size="inline">Built-in</Badge>}
          </div>
          {template.description && (
            <p
              className="mt-0.5 truncate text-xs text-muted-foreground"
              title={template.description}
            >
              {template.description}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "type",
      label: "Type",
      width: "9rem",
      align: "right",
      renderCell: (template) => <Badge variant="secondary">{template.certType}</Badge>,
    },
    {
      id: "algorithm",
      label: "Algorithm",
      width: "9rem",
      align: "right",
      renderCell: (template) => <Badge variant="secondary">{template.keyAlgorithm}</Badge>,
    },
    {
      id: "validity",
      label: "Validity",
      width: "7rem",
      align: "right",
      renderCell: (template) => <Badge variant="secondary">{template.validityDays}d</Badge>,
    },
    {
      id: "actions",
      label: "Actions",
      align: "right",
      width: "5rem",
      renderCell: (template) =>
        (canEditTemplates || canDeleteTemplates) && !template.isBuiltin ? (
          <div className="flex justify-end" onClick={stopRowEvent} onPointerDown={stopRowEvent}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Actions for ${template.name}`}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEditTemplates && (
                  <DropdownMenuItem onClick={() => openEdit(template)}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                )}
                {canDeleteTemplates && (
                  <DropdownMenuItem
                    onClick={() => handleDelete(template)}
                    className="text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null,
    },
  ];

  if (!canListTemplates) {
    return null;
  }

  const content = (
    <>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <PageHeader
            title="Templates"
            description="Certificate issuance templates"
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
                          onClick: openCreate,
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
                  <Button onClick={openCreate}>
                    <Plus className="h-4 w-4" />
                    Create Template
                  </Button>
                )}
              </ResponsiveHeaderActions>
            }
          />
        )}

        <FolderedResourceList<Template>
          resourceType="pki-template"
          realtimeChannel="pki.template.folder.changed"
          resources={visibleTemplates.filter((template) => !template.isBuiltin)}
          systemFolders={[
            {
              id: BUILTIN_FOLDER_ID,
              name: "Built-in",
              // Built-in templates keep the server's order.
              items: visibleTemplates
                .filter((template) => template.isBuiltin)
                .map((template, index) => ({ ...template, sortOrder: index })),
            },
          ]}
          columns={templateColumns}
          search={{
            placeholder: "Search templates...",
            search,
            onSearchChange: setSearch,
            hasActiveFilters: search !== "",
            onReset: () => setSearch(""),
          }}
          loading={isLoading}
          loadingLabel="Loading certificate templates..."
          emptyState={
            <EmptyState
              message="No templates."
              {...(canCreateTemplates ? { actionLabel: "Create one", onAction: openCreate } : {})}
              hasActiveFilters={search !== ""}
              onReset={() => setSearch("")}
            />
          }
          minWidth={760}
          canManageFolders={canManageFolders}
          canViewItem={canOpenTemplate}
          canReorganizeItem={(template) =>
            canManageFolders && canEditTemplates && !template.isBuiltin
          }
          getResourceLabel={(template) => template.name}
          onItemClick={(template) => {
            if (template.isBuiltin) openEdit(template, { readOnly: true });
            else if (canEditTemplates) openEdit(template);
          }}
          onRefresh={loadTemplates}
          onCreateFolderRef={(fn) => {
            setCreateFolderAction(() => fn);
            onCreateFolderRef?.(fn);
          }}
        />

        {/* Wizard Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {viewOnly ? editing?.name : editing ? "Edit Template" : "Create Template"}
              </DialogTitle>
            </DialogHeader>
            {viewOnly && (
              <DialogDescription>Built-in template. Its settings are read-only.</DialogDescription>
            )}

            {/* Step indicator */}
            <div className="flex gap-1">
              {/* Step progress segments; each one jumps to its step. */}
              {WIZARD_STEPS.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  aria-label={s.title}
                  className={`flex-1 h-1 transition-colors ${i <= step ? "bg-primary" : "bg-muted"}`}
                  onClick={() => setStep(i)}
                />
              ))}
            </div>
            <div className="mb-2">
              <p className="text-sm font-medium">{WIZARD_STEPS[step].title}</p>
              <p className="text-xs text-muted-foreground">{WIZARD_STEPS[step].subtitle}</p>
            </div>

            {/* Step content */}
            <fieldset className="-mx-1 min-w-0 space-y-4 border-0 px-1 pb-1" disabled={viewOnly}>
              {step === 0 && (
                <StepGeneral
                  name={name}
                  setName={setName}
                  description={description}
                  setDescription={setDescription}
                  certType={certType}
                  setCertType={setCertType}
                  keyAlgorithm={keyAlgorithm}
                  setKeyAlgorithm={setKeyAlgorithm}
                  validityDays={validityDays}
                  setValidityDays={setValidityDays}
                />
              )}
              {step === 0 && !editing && (
                <div className="space-y-1.5">
                  <label htmlFor="pki-template-folder" className="text-sm font-medium">
                    Folder
                  </label>
                  <CreateFolderSelect
                    id="pki-template-folder"
                    choices={folderChoices}
                    value={folderId}
                    onChange={setFolderId}
                    loading={foldersLoading}
                  />
                </div>
              )}
              {step === 1 && <StepKeyUsage keyUsage={keyUsage} setKeyUsage={setKeyUsage} />}
              {step === 2 && (
                <StepExtKeyUsage
                  extKeyUsage={extKeyUsage}
                  setExtKeyUsage={setExtKeyUsage}
                  customEkuOid={customEkuOid}
                  setCustomEkuOid={setCustomEkuOid}
                />
              )}
              {step === 3 && (
                <StepSAN
                  requireSans={requireSans}
                  setRequireSans={setRequireSans}
                  sanTypes={sanTypes}
                  setSanTypes={setSanTypes}
                />
              )}
              {step === 4 && (
                <StepSubjectDN
                  dnO={dnO}
                  setDnO={setDnO}
                  dnOu={dnOu}
                  setDnOu={setDnOu}
                  dnL={dnL}
                  setDnL={setDnL}
                  dnSt={dnSt}
                  setDnSt={setDnSt}
                  dnC={dnC}
                  setDnC={setDnC}
                />
              )}
              {step === 5 && (
                <StepDistribution
                  crlDistributionPoints={crlDistributionPoints}
                  setCrlDistributionPoints={setCrlDistributionPoints}
                  caIssuersUrl={caIssuersUrl}
                  setCaIssuersUrl={setCaIssuersUrl}
                />
              )}
              {step === 6 && (
                <StepPolicies
                  certificatePolicies={certificatePolicies}
                  setCertificatePolicies={setCertificatePolicies}
                />
              )}
              {step === 7 && (
                <StepCustomExtensions
                  customExtensions={customExtensions}
                  setCustomExtensions={setCustomExtensions}
                />
              )}
            </fieldset>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                {viewOnly ? "Close" : "Cancel"}
              </Button>
              {step > 0 && (
                <Button variant="outline" onClick={() => setStep(step - 1)}>
                  Back
                </Button>
              )}
              {viewOnly ? (
                !isLastStep && <Button onClick={() => setStep(step + 1)}>Next</Button>
              ) : isLastStep ? (
                <Button onClick={handleSave} disabled={!canProceed} pending={isSaving}>
                  {editing ? "Update" : "Create"}
                </Button>
              ) : (
                <Button onClick={() => setStep(step + 1)} disabled={!canProceed}>
                  Next
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );

  if (embedded) return content;
  return <PageTransition>{content}</PageTransition>;
}
