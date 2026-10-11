import { FileArchive, FolderOpen, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Combobox } from "@/components/common/Combobox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress-bar";
import {
  type PreparedPageBuild,
  preparePageArchive,
  preparePageFolder,
  sha256Hex,
} from "@/lib/pages-manual-upload";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type { PageDeployment, PageTag } from "@/types";

const TAG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const directoryInputProps = { webkitdirectory: "", directory: "" };

export function PageManualDeployDialog({
  open,
  onOpenChange,
  projectId,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onUploaded: (deployment: PageDeployment) => void;
}) {
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [prepared, setPrepared] = useState<PreparedPageBuild | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<PageTag[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("");
  const busy = preparing || uploading;

  useEffect(() => {
    if (!open) return;
    void api
      .listPageTags(projectId)
      .then(setTags)
      .catch(() => setTags([]));
  }, [open, projectId]);

  const reset = useCallback(() => {
    setPrepared(null);
    setSourceError("");
    setTag("");
    setTags([]);
    setPreparing(false);
    setUploading(false);
    setProgress(0);
    setPhase("");
    if (archiveInputRef.current) archiveInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  }, []);

  const inspect = async (prepare: () => Promise<PreparedPageBuild>) => {
    setSourceError("");
    setPrepared(null);
    setPreparing(true);
    setPhase("Inspecting build…");
    try {
      setPrepared(await prepare());
      setPhase("");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Failed to inspect the build");
      setPhase("");
    } finally {
      setPreparing(false);
    }
  };

  const normalizedTag = tag.trim().toLowerCase();
  const tagError =
    normalizedTag &&
    (normalizedTag === "latest" || normalizedTag.length > 63 || !TAG_PATTERN.test(normalizedTag))
      ? "Tag must be a lowercase DNS label; latest is reserved"
      : "";

  const upload = async () => {
    if (!prepared || tagError || busy) return;
    // Names the build being sent, so the progress row says what is uploading.
    const uploadingPhase = `Uploading ${prepared.sourceLabel} (${formatBytes(prepared.archive.size)})…`;
    setUploading(true);
    setProgress(0);
    setPhase("Calculating checksum…");
    let succeeded = false;
    try {
      const sha256 = await sha256Hex(prepared.archive);
      setPhase(uploadingPhase);
      const deployment = await api.uploadPageBuild(
        projectId,
        prepared.archive,
        sha256,
        normalizedTag || undefined,
        (nextProgress, nextPhase) => {
          setProgress(nextProgress);
          setPhase(nextPhase === "finalizing" ? "Validating and publishing…" : uploadingPhase);
        }
      );
      succeeded = true;
      setUploading(false);
      onUploaded(deployment);
      toast.success("Page Project deployed");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to deploy Page Project");
    } finally {
      if (!succeeded) {
        setUploading(false);
        setPhase("");
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="sm:max-w-xl"
        hideCloseButton={busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            reset();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Deploy Page Project</DialogTitle>
          <DialogDescription>
            Upload a static build archive or choose a folder containing index.html or index.htm.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="m-0 min-w-0 space-y-4 border-0 p-0" disabled={busy}>
          <div className="space-y-1.5">
            <span id="page-build-label" className="text-sm font-medium">
              Build
            </span>
            <input
              ref={archiveInputRef}
              type="file"
              className="hidden"
              accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void inspect(() => preparePageArchive(file));
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              className="hidden"
              multiple
              {...directoryInputProps}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) void inspect(() => preparePageFolder(files));
              }}
            />
            <div
              aria-labelledby="page-build-label"
              className={cn(
                // The standard control height, like Input and Select; the pickers sit inside it.
                "flex h-9 min-w-0 items-stretch border bg-background",
                sourceError ? "border-destructive" : "border-input"
              )}
            >
              <div className="flex min-w-0 flex-1 items-center px-3">
                {/* The chosen build stays named while it uploads; the phase shows only while inspecting. */}
                {prepared && !sourceError ? (
                  <p className="flex min-w-0 items-center text-sm">
                    <span className="truncate">{prepared.sourceLabel}</span>
                    <span className="shrink-0">
                      {` · ${prepared.fileCount} files · ${formatBytes(prepared.archive.size)}`}
                    </span>
                  </p>
                ) : (
                  <p className={cn("truncate text-sm", sourceError && "text-destructive")}>
                    {sourceError || phase || "No build selected"}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-stretch border-l border-border">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-full rounded-none border-0"
                  onClick={() => {
                    if (!archiveInputRef.current) return;
                    archiveInputRef.current.value = "";
                    archiveInputRef.current.click();
                  }}
                >
                  <FileArchive className="h-4 w-4" />
                  Archive
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-full rounded-none border-0 border-l border-border"
                  onClick={() => {
                    if (!folderInputRef.current) return;
                    folderInputRef.current.value = "";
                    folderInputRef.current.click();
                  }}
                >
                  <FolderOpen className="h-4 w-4" />
                  Folder
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="page-deploy-tag">
              Tag <span className="text-muted-foreground">(optional)</span>
            </label>
            <Combobox
              value={tag}
              onValueChange={setTag}
              options={tags
                .filter((item) => !item.system)
                .map((item) => ({ value: item.name, label: item.name }))}
              freeText
              showAllOptionsOnFocus
              placeholder="No Tag"
              searchPlaceholder="Select or enter a Tag"
              emptyMessage="Enter a new Tag name"
              ariaLabel="Tag"
              inputClassName={tagError ? "border-destructive" : undefined}
            />
            {tagError ? <p className="text-sm text-destructive">{tagError}</p> : null}
          </div>

          {uploading ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span className="min-w-0 truncate">{phase}</span>
                <span className="shrink-0">{progress}%</span>
              </div>
              <ProgressBar value={progress} aria-label="Build upload progress" />
            </div>
          ) : null}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void upload()} disabled={!prepared || Boolean(tagError) || busy}>
            <UploadCloud className="h-4 w-4" />
            {uploading ? "Uploading…" : preparing ? "Preparing…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
