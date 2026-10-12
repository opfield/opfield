import { Network, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { getNodeAppearanceColor, NODE_APPEARANCE_COLOR_OPTIONS } from "@/lib/node-appearance";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import type { NodeAppearanceColor, PageProject } from "@/types";
import { PagePreviewLinksPanel } from "./PagePreviewLinksPanel";
import { PAGE_HOME_NODE_HINT } from "./page-format";

export function PageProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onProjectChange,
  homeNodeName,
  onCreateGroupRoute,
}: {
  project: PageProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectChange: (project: PageProject) => void;
  /** The project's home node; null while unknown. */
  homeNodeName?: string | null;
  /** Opens the Pages Route create flow for this project, when the caller can use an ingress group. */
  onCreateGroupRoute?: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [appearanceColor, setAppearanceColor] = useState<NodeAppearanceColor | null>(
    project.appearanceColor
  );
  const [spaFallback, setSpaFallback] = useState(project.spaFallback);
  const [previewsEnabled, setPreviewsEnabled] = useState(project.previewsEnabled ?? true);
  const [fallbackUrl, setFallbackUrl] = useState(project.fallbackUrl ?? "");
  const [maxDeployments, setMaxDeployments] = useState(String(project.maxDeployments));
  const [storageQuotaGiB, setStorageQuotaGiB] = useState(
    String((project.storageQuotaBytes / 1024 / 1024 / 1024).toFixed(2))
  );
  const [accessListId, setAccessListId] = useState(project.accessListId ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);

  // Seed the form when the dialog opens (or shows another Project) only. A
  // refreshed Project while open, e.g. after a link rotation, keeps the edits.
  const seededProjectId = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seededProjectId.current = null;
      return;
    }
    if (seededProjectId.current === project.id) return;
    seededProjectId.current = project.id;
    setName(project.name);
    setDescription(project.description ?? "");
    setAppearanceColor(project.appearanceColor);
    setSpaFallback(project.spaFallback);
    setPreviewsEnabled(project.previewsEnabled ?? true);
    setFallbackUrl(project.fallbackUrl ?? "");
    setMaxDeployments(String(project.maxDeployments));
    setStorageQuotaGiB(String((project.storageQuotaBytes / 1024 / 1024 / 1024).toFixed(2)));
    setAccessListId(project.accessListId ?? "");
  }, [open, project]);

  const save = async () => {
    if (!name.trim() || saving) return;
    const retention = Number(maxDeployments);
    const quotaGiB = Number(storageQuotaGiB);
    if (!Number.isInteger(retention) || retention < 1 || retention > 500) {
      toast.error("Maximum retained Deployments must be between 1 and 500");
      return;
    }
    if (!Number.isFinite(quotaGiB) || quotaGiB < 0.001) {
      toast.error("Project storage quota must be at least 1 MiB");
      return;
    }
    const normalizedFallbackUrl = fallbackUrl.trim();
    if (normalizedFallbackUrl) {
      try {
        const parsed = new URL(normalizedFallbackUrl);
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          /[\s;'"{}\\`$#]/.test(normalizedFallbackUrl)
        ) {
          throw new Error();
        }
      } catch {
        toast.error("Custom fallback URL must be an absolute HTTP(S) URL");
        return;
      }
    }

    setSaving(true);
    try {
      const updated = await api.updatePageProject(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        appearanceColor,
        spaFallback,
        previewsEnabled,
        fallbackUrl: normalizedFallbackUrl || null,
        maxDeployments: retention,
        storageQuotaBytes: Math.round(quotaGiB * 1024 * 1024 * 1024),
        ...(accessListId !== (project.accessListId ?? "")
          ? { accessListId: accessListId || null }
          : {}),
      });
      onProjectChange(updated);
      onOpenChange(false);
      toast.success("Project settings saved");
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to save Project settings");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Update project details, retention, storage quota, and preview links.
        </DialogDescription>
        <PanelShell
          icon={<Settings className="h-4 w-4" />}
          title="Project"
          description="Details, appearance, retention, and storage limits."
        >
          <SettingsControlRow title="Project name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My static site"
            />
          </SettingsControlRow>
          <SettingsControlRow title="Description" description="Optional project context.">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Static site deployed from GitLab"
            />
          </SettingsControlRow>
          <SettingsControlRow title="Home node" description={PAGE_HOME_NODE_HINT}>
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <span className="text-sm">{homeNodeName ?? "Unknown"}</span>
              {onCreateGroupRoute && (
                <Button
                  variant="link"
                  className="h-auto px-0"
                  onClick={() => {
                    onOpenChange(false);
                    onCreateGroupRoute();
                  }}
                >
                  <Network className="h-4 w-4" />
                  Create route on a group
                </Button>
              )}
            </div>
          </SettingsControlRow>
          <SettingsControlRow
            title="Color"
            description="Used for the Project icon and its Route target badge."
          >
            <div className="w-full space-y-2">
              <div className="grid grid-cols-8 gap-2">
                <button
                  type="button"
                  aria-label="Default color"
                  className={cn(
                    "aspect-square w-full border border-border bg-muted",
                    appearanceColor === null && "border-foreground"
                  )}
                  style={
                    appearanceColor === null
                      ? { borderColor: "var(--color-foreground)" }
                      : undefined
                  }
                  onClick={() => setAppearanceColor(null)}
                />
                {NODE_APPEARANCE_COLOR_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-label={`${option.label} color`}
                    className={cn(
                      "aspect-square w-full border border-border",
                      option.swatchClassName,
                      appearanceColor === option.value && "border-foreground"
                    )}
                    style={
                      appearanceColor === option.value
                        ? { borderColor: "var(--color-foreground)" }
                        : undefined
                    }
                    onClick={() => setAppearanceColor(option.value)}
                  />
                ))}
              </div>
              <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <span>Preview:</span>
                <Badge
                  variant="secondary"
                  size="inline"
                  className={getNodeAppearanceColor(appearanceColor)?.badgeClassName}
                >
                  {name.trim() || project.slug}
                </Badge>
              </div>
            </div>
          </SettingsControlRow>
          <SettingsControlRow
            title="Public previews"
            description="Disabling public previews revokes only preview URLs. Deployment files and Tags are retained, and bound domains remain available."
          >
            <Switch
              checked={previewsEnabled}
              onChange={setPreviewsEnabled}
              disabled={saving}
              ariaLabel="Enable public previews"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="SPA fallback"
            description="Serve index.html when a requested Pages path does not exist."
          >
            <Switch
              checked={spaFallback}
              onChange={setSpaFallback}
              ariaLabel="Enable SPA fallback"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Custom fallback URL"
            description="Redirect missing paths to this absolute HTTP(S) URL when SPA fallback is disabled."
          >
            <Input
              type="url"
              value={fallbackUrl}
              onChange={(event) => setFallbackUrl(event.target.value)}
              placeholder="https://example.com/not-found"
              disabled={spaFallback}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Maximum retained Deployments"
            description="Older unprotected Deployments are removed automatically."
          >
            <Input
              type="number"
              min={1}
              max={500}
              value={maxDeployments}
              onChange={(event) => setMaxDeployments(event.target.value)}
              placeholder="20"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Project storage quota"
            description="Maximum retained artifact storage in GiB."
          >
            <Input
              type="number"
              min={0.001}
              step={0.01}
              value={storageQuotaGiB}
              onChange={(event) => setStorageQuotaGiB(event.target.value)}
              placeholder="1.00"
            />
          </SettingsControlRow>
        </PanelShell>
        <PagePreviewLinksPanel
          project={project}
          accessListId={accessListId}
          onAccessListChange={setAccessListId}
          onProjectChange={onProjectChange}
          disabled={saving}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
