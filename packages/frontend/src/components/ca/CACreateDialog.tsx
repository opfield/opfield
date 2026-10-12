import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CreateFolderSelect } from "@/components/common/CreateFolderSelect";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api-error-toast";
import { flattenCreationFolders, placementFolderChoices } from "@/lib/creation-folders";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { KeyAlgorithm } from "@/types";

const NO_SCOPES: string[] = [];

interface CACreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined = root CA, "pick" = show parent selector, uuid = specific parent */
  parentId?: string;
}

export function CACreateDialog({ open, onOpenChange, parentId }: CACreateDialogProps) {
  const { cas, fetchCAs } = useCAStore();
  const hasScope = useAuthStore((s) => s.hasScope);

  const [selectedParentId, setSelectedParentId] = useState<string>("");
  const [commonName, setCommonName] = useState("");
  const [keyAlgorithm, setKeyAlgorithm] = useState<KeyAlgorithm>("ecdsa-p256");
  const [validityYears, setValidityYears] = useState(10);
  const [pathLengthConstraint, setPathLengthConstraint] = useState<number | undefined>(undefined);
  const [maxValidityDays, setMaxValidityDays] = useState(365);
  const [isSaving, setIsSaving] = useState(false);
  const [folderId, setFolderId] = useState("");
  const scopes = useAuthStore((s) => s.user?.scopes ?? NO_SCOPES);
  const caFolders = useResourceFolderStore((state) => state.foldersByType["pki-ca"]);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType["pki-ca"]);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);

  const needsParentPicker = parentId === "pick";
  const resolvedParentId = needsParentPicker ? selectedParentId : parentId;
  // Picking a parent is always an intermediate, also before the parent is chosen.
  const isIntermediate = needsParentPicker || !!resolvedParentId;
  const activeCAs = (cas || []).filter(
    (ca) =>
      ca.status === "active" && !ca.isSystem && hasScope(`pki:ca:create:intermediate:${ca.id}`)
  );
  // A folder holds whole hierarchies: an intermediate CA is listed in the folder of its root CA
  // (the CA list reports that folder on every CA), so its picker only shows where it will land.
  const parentFolderId = (cas || []).find((ca) => ca.id === resolvedParentId)?.folderId ?? "";
  const folderChoices = useMemo(() => {
    const folders = flattenCreationFolders(caFolders ?? []);
    return isIntermediate
      ? placementFolderChoices(folders, (id) => id === parentFolderId)
      : // A root CA lands where the caller may move a root CA: pki:ca:edit on the folder.
        placementFolderChoices(folders, (id) => canCreateInFolder(scopes, "pki:ca:edit", id));
  }, [caFolders, isIntermediate, parentFolderId, scopes]);

  useEffect(() => {
    if (open) void fetchFolders("pki-ca");
  }, [fetchFolders, open]);

  useEffect(() => {
    if (isIntermediate) setFolderId(parentFolderId);
  }, [isIntermediate, parentFolderId]);

  const handleCreate = async () => {
    if (!commonName.trim()) {
      toast.error("Common Name is required");
      return;
    }
    if (isIntermediate && !resolvedParentId) {
      toast.error("Select a parent CA");
      return;
    }

    setIsSaving(true);
    try {
      const data = {
        commonName,
        keyAlgorithm,
        validityYears,
        pathLengthConstraint,
        maxValidityDays,
      };

      if (isIntermediate) {
        await api.createIntermediateCA(resolvedParentId!, data);
      } else {
        await api.createRootCA({ ...data, folderId: folderId || null });
      }

      toast.success(`${isIntermediate ? "Intermediate" : "Root"} CA created`);
      onOpenChange(false);
      fetchCAs();
      setTimeout(() => {
        setCommonName("");
        setSelectedParentId("");
        setValidityYears(10);
        setPathLengthConstraint(undefined);
        setMaxValidityDays(365);
        setFolderId("");
      }, 200);
    } catch (err) {
      if (!handleLicenseApiError(err, "Internal PKI")) {
        toastApiError(err, "Failed to create CA");
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create {isIntermediate ? "Intermediate" : "Root"} CA</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {isIntermediate
            ? "Create a new intermediate CA signed by the parent."
            : "Create a new self-signed Root Certificate Authority."}
        </DialogDescription>

        <div className="space-y-4">
          {needsParentPicker && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Parent CA</label>
              <Select
                value={selectedParentId || "none"}
                onValueChange={(v) => setSelectedParentId(v === "none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select parent CA..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" disabled>
                    Select parent CA...
                  </SelectItem>
                  {activeCAs.map((ca) => (
                    <SelectItem key={ca.id} value={ca.id}>
                      {ca.commonName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="ca-create-folder" className="text-sm font-medium">
              Folder
            </label>
            <CreateFolderSelect
              id="ca-create-folder"
              choices={folderChoices}
              value={folderId}
              onChange={setFolderId}
              loading={foldersLoading}
              disabled={isIntermediate}
            />
            {isIntermediate && (
              <p className="text-xs text-muted-foreground">
                An intermediate CA stays in the folder of its root CA.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Common Name (CN)</label>
            <Input
              value={commonName}
              onChange={(e) => setCommonName(e.target.value)}
              placeholder={
                isIntermediate ? "e.g., My Org Intermediate CA" : "e.g., My Organization Root CA"
              }
              autoFocus={!needsParentPicker}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Key Algorithm</label>
              <Select
                value={keyAlgorithm}
                onValueChange={(v) => setKeyAlgorithm(v as KeyAlgorithm)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ecdsa-p256">ECDSA P-256</SelectItem>
                  <SelectItem value="ecdsa-p384">ECDSA P-384</SelectItem>
                  <SelectItem value="rsa-2048">RSA 2048</SelectItem>
                  <SelectItem value="rsa-4096">RSA 4096</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Validity (years)</label>
              <Input
                type="number"
                value={validityYears}
                onChange={(e) => setValidityYears(parseInt(e.target.value, 10) || 10)}
                min={1}
                max={30}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Path Length Constraint</label>
              <Input
                type="number"
                value={pathLengthConstraint ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setPathLengthConstraint(val === "" ? undefined : parseInt(val, 10));
                }}
                placeholder="Optional"
                min={0}
                max={10}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Max Cert Validity (days)</label>
              <Input
                type="number"
                value={maxValidityDays}
                onChange={(e) => setMaxValidityDays(parseInt(e.target.value, 10) || 365)}
                min={1}
                max={3650}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!commonName.trim() || (needsParentPicker && !selectedParentId)}
            pending={isSaving}
          >
            Create CA
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
