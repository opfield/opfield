import { useEffect, useMemo, useState } from "react";
import { ContentLoading } from "@/components/common/ContentLoading";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import {
  allowedCreationFolderId,
  creationFolderChoices,
  flattenCreationFolders,
} from "@/lib/creation-folders";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";

const NO_SCOPES: string[] = [];
const ROOT_FOLDER_VALUE = "__root__";

interface DomainCertificateFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domainName: string | null;
  /** Issues the certificate into the chosen SSL certificate folder (null = root). */
  onIssue: (folderId: string | null) => Promise<void>;
}

/**
 * Issuing a certificate from a domain creates an SSL certificate, so it lands in an
 * SSL certificate folder the caller may create in (ssl:cert:issue on that folder).
 */
export function DomainCertificateFolderDialog({
  open,
  onOpenChange,
  domainName,
  onIssue,
}: DomainCertificateFolderDialogProps) {
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  const folders = useResourceFolderStore((state) => state.foldersByType["ssl-certificate"]);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType["ssl-certificate"]);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const [folderId, setFolderId] = useState("");
  const [isIssuing, setIsIssuing] = useState(false);
  const displayedDomainName = useRetainedDialogValue(domainName, open);
  const choices = useMemo(
    () => creationFolderChoices(scopes, "ssl:cert:issue", flattenCreationFolders(folders ?? [])),
    [folders, scopes]
  );

  useEffect(() => {
    if (!open) return;
    setFolderId("");
    setIsIssuing(false);
    void fetchFolders("ssl-certificate");
  }, [fetchFolders, open]);

  useEffect(() => {
    if (!open) return;
    setFolderId((current) => allowedCreationFolderId(choices, current));
  }, [choices, open]);

  const canIssue =
    !isIssuing &&
    (folderId ? choices.folders.some((folder) => folder.id === folderId) : choices.allowRoot);

  const issue = async () => {
    if (!canIssue) return;
    setIsIssuing(true);
    try {
      await onIssue(folderId || null);
      onOpenChange(false);
    } finally {
      setIsIssuing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue Certificate</DialogTitle>
          <DialogDescription>
            Choose the certificate folder for the certificate of{" "}
            {displayedDomainName ?? "this domain"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <ContentLoading loading={foldersLoading} />
          <label className="text-sm font-medium">Certificate folder</label>
          <Select
            value={folderId || (choices.allowRoot ? ROOT_FOLDER_VALUE : "")}
            onValueChange={(value) => setFolderId(value === ROOT_FOLDER_VALUE ? "" : value)}
            disabled={foldersLoading || isIssuing}
          >
            <SelectTrigger aria-label="Certificate folder" aria-busy={foldersLoading}>
              <SelectValue placeholder="Select a folder" />
            </SelectTrigger>
            <SelectContent>
              {choices.allowRoot && <SelectItem value={ROOT_FOLDER_VALUE}>No folder</SelectItem>}
              {choices.folders.map((folder) => (
                <SelectItem key={folder.id} value={folder.id}>
                  {"  ".repeat(folder.depth) + folder.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!foldersLoading && !choices.allowRoot && choices.folders.length === 0 && (
            <p className="text-xs text-muted-foreground">
              You cannot create SSL certificates in any folder.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isIssuing}>
            Cancel
          </Button>
          <Button onClick={() => void issue()} disabled={!canIssue} pending={isIssuing}>
            Issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
