// Promote <source> to <target> (canvas frames env-promote, env-promote-summary): step 1 lists what
// runs in the source per paired member with a switch each, step 2 summarises what happens in the
// target, then each item's progress.
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, ArrowUpFromLine, Box, Boxes, Globe2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatedSwitch, CONTENT_SWITCH_ANIMATION } from "@/components/common/AnimatedSwitch";
import { Notice } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { shortCommitSha, workloadImageLabel } from "@/lib/workload-image-label";
import { api } from "@/services/api";
import {
  APPS_REALTIME_CHANNEL,
  type AppDetail,
  type AppEnvironmentDetail,
  type AppPromotion,
  type AppPromotionPreview,
  type AppPromotionPreviewItem,
  type AppsChangedPayload,
  type DockerImageSource,
  type PromotionImageOrigins,
} from "@/types";
import { orderedEnvironments, plural } from "../app-shared";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";

const TYPE_LABEL: Record<AppPromotionPreviewItem["type"], string> = {
  container: "Container",
  deployment: "Deployment",
  compose: "Compose",
  pages: "Pages",
};

const STATUS_BADGE: Record<
  AppPromotion["items"][number]["status"],
  { label: string; variant: "secondary" | "warning" | "success" | "destructive" | "outline" }
> = {
  pending: { label: "Waiting", variant: "secondary" },
  running: { label: "Running", variant: "warning" },
  succeeded: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  skipped: { label: "Skipped", variant: "outline" },
};

/** Environments the caller may promote into from `source`. */
export function promotionTargets(
  app: AppDetail,
  source: AppEnvironmentDetail
): AppEnvironmentDetail[] {
  return orderedEnvironments(app.environments).filter(
    (env) => env.id !== source.id && app.permissions.promote[env.id]
  );
}

/** The target a Promote button names: Production when promoting from elsewhere, else the first one. */
export function defaultPromotionTarget(
  app: AppDetail,
  source: AppEnvironmentDetail
): AppEnvironmentDetail | null {
  const targets = promotionTargets(app, source);
  return targets.find((env) => env.isProduction) ?? targets[0] ?? null;
}

/** "2 images, 1 Compose revision and 1 Pages deployment" for the items that differ. */
export function differenceSummary(items: AppPromotionPreviewItem[]): string {
  const differ = items.filter((item) => !item.same && item.promotable);
  const images = differ.filter(
    (item) => item.type === "container" || item.type === "deployment"
  ).length;
  const compose = differ.filter((item) => item.type === "compose").length;
  const pages = differ.filter((item) => item.type === "pages").length;
  const parts = [
    images > 0 ? plural(images, "image") : null,
    compose > 0 ? plural(compose, "Compose revision") : null,
    pages > 0 ? plural(pages, "Pages deployment") : null,
  ].filter((part): part is string => !!part);
  if (parts.length === 0) return "";
  return parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** One side of a from → to image: a Git-built image names its repository and commit, never the internal registry. */
function promotedImage(
  image: string | null,
  source: DockerImageSource | null | undefined,
  sourceImage: string | null | undefined
): string | null {
  if (!image) return null;
  return workloadImageLabel({ image, source, sourceImage }).text;
}

/** "<from> → <to>" of an item; images of containers, deployments and Compose services through the shared label. */
function fromTo(
  row: PromotionImageOrigins & { from: string | null; to: string | null },
  images: boolean,
  missing = "not running"
): string {
  const from = images ? promotedImage(row.from, row.fromSource, row.fromSourceImage) : row.from;
  const to = images ? promotedImage(row.to, row.toSource, row.toSourceImage) : row.to;
  return `${from ?? missing} → ${to ?? missing}`;
}

function rolloutText(item: AppPromotionPreviewItem): string {
  if (item.type === "compose") {
    const changed =
      item.compose?.services.filter((service) => service.changed).map((service) => service.name) ??
      [];
    return `Redeployed at ${item.to}${changed.length ? ` · ${changed.join(", ")} updated` : ""}`;
  }
  if (item.type === "pages") {
    return `Deployment #${item.pages?.toSequence ?? "?"} becomes active${item.pages?.fromSequence ? ` (was #${item.pages.fromSequence})` : ""}`;
  }
  const build = item.build ? ` · commit ${shortCommitSha(item.build.commitSha)} · not rebuilt` : "";
  return `${item.rollout} with ${item.to}${build}`;
}

export function PromoteDialog({
  app,
  source,
  initialTargetId,
  open,
  onOpenChange,
  onDone,
}: {
  app: AppDetail;
  source: AppEnvironmentDetail;
  initialTargetId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const targets = promotionTargets(app, source);
  const [targetId, setTargetId] = useState<string | null>(initialTargetId);
  const [preview, setPreview] = useState<AppPromotionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [submitting, setSubmitting] = useState(false);
  const [promotion, setPromotion] = useState<AppPromotion | null>(null);
  const target = targets.find((env) => env.id === targetId) ?? null;

  useEffect(() => {
    if (!open) return;
    setTargetId(initialTargetId);
    setStep(1);
    setPromotion(null);
  }, [open, initialTargetId]);

  useEffect(() => {
    if (!open || !targetId) return;
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    api
      .previewAppPromotion(app.id, source.id, targetId)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setSelected(
          result.items.filter((item) => item.promotable && !item.same).map((item) => item.pairKey)
        );
      })
      .catch((error) => {
        if (!cancelled) toastApiError(error, "Failed to read what runs");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, app.id, source.id, targetId]);

  const reloadPromotion = useCallback(async () => {
    if (!promotion) return;
    try {
      setPromotion(await api.getAppPromotion(app.id, promotion.id));
    } catch {
      // Kept as it was; the next change retries.
    }
  }, [app.id, promotion]);

  useRealtime(APPS_REALTIME_CHANNEL, (raw) => {
    const payload = raw as AppsChangedPayload;
    if (payload?.appId === app.id && step === 3) void reloadPromotion();
  });

  const differing = useMemo(() => (preview?.items ?? []).filter((item) => !item.same), [preview]);
  const images = differing.filter(
    (item) => item.type === "container" || item.type === "deployment"
  );
  const composeItems = differing.filter((item) => item.type === "compose");
  const pagesItems = differing.filter((item) => item.type === "pages");
  const chosen = differing.filter((item) => selected.includes(item.pairKey));
  const toggle = (pairKey: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...current, pairKey] : current.filter((key) => key !== pairKey)
    );

  const promote = async () => {
    if (!preview || !target) return;
    setSubmitting(true);
    try {
      const started = await api.promoteApp(app.id, {
        sourceEnvironmentId: source.id,
        targetEnvironmentId: target.id,
        items: chosen.map((item) => item.pairKey),
        previewDigest: preview.previewDigest,
      });
      setPromotion(started);
      setStep(3);
      onDone();
    } catch (error) {
      toastApiError(error, "Failed to promote");
    } finally {
      setSubmitting(false);
    }
  };

  const itemSwitch = (item: AppPromotionPreviewItem) => (
    <Switch
      checked={selected.includes(item.pairKey)}
      onChange={(checked) => toggle(item.pairKey, checked)}
      disabled={!item.promotable}
      ariaLabel={`Promote ${item.targetName}`}
    />
  );

  const targetName = target?.name ?? "the target";
  const description =
    step === 1
      ? `Step 1 of 2 — What runs in ${source.name}`
      : step === 2
        ? "Step 2 of 2 — Summary"
        : "Progress";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={APP_DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>
            Promote {source.name} to {targetName}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>{description}</DialogDescription>

        <AnimatedSwitch>
          {step === 1 && (
            <motion.div key="step-1" {...CONTENT_SWITCH_ANIMATION} className="space-y-4">
              {targets.length > 1 && (
                <SettingsInlineControl label="Promote to">
                  <Select value={targetId ?? undefined} onValueChange={setTargetId}>
                    <SelectTrigger aria-label="Promote to">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((env) => (
                        <SelectItem key={env.id} value={env.id}>
                          {env.isProduction ? `${env.name} · Production` : env.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsInlineControl>
              )}
              <p className="text-sm text-muted-foreground">
                {targetName} will run exactly what runs in {source.name}: the same image digests,
                the same Compose revision and the same Pages artifact. Nothing is rebuilt. Variables
                and secrets stay per environment and are not promoted.
              </p>
              {loading || !preview ? (
                <p className="text-sm text-muted-foreground">
                  Reading what runs in both environments…
                </p>
              ) : differing.length === 0 ? (
                <Notice
                  tone="success"
                  title={`${targetName} already runs what runs in ${source.name}`}
                />
              ) : (
                <>
                  {images.length > 0 && (
                    <PanelShell
                      title="Containers and deployments"
                      icon={<Box className="h-4 w-4" />}
                      description="Same image digest, no rebuild"
                    >
                      {images.map((item) => (
                        <SettingsControlRow
                          key={item.pairKey}
                          title={`${item.targetName} · ${TYPE_LABEL[item.type].toLowerCase()}`}
                          description={
                            <>
                              <span className="block font-mono">{fromTo(item, true)}</span>
                              {item.build ? (
                                <span className="block">
                                  Commit {shortCommitSha(item.build.commitSha)}
                                </span>
                              ) : null}
                              <span className="block">
                                {item.promotable
                                  ? `Rollout: ${item.rollout}`
                                  : (item.reason ?? "Not promotable")}
                              </span>
                            </>
                          }
                        >
                          {itemSwitch(item)}
                        </SettingsControlRow>
                      ))}
                    </PanelShell>
                  )}
                  {composeItems.map((item) => (
                    <PanelShell
                      key={item.pairKey}
                      title={`Compose project · ${item.targetName}`}
                      icon={<Boxes className="h-4 w-4" />}
                      description={`Compose file ${item.from ?? "none"} → ${item.to}`}
                      actions={itemSwitch(item)}
                    >
                      {(item.compose?.services ?? []).map((service) => (
                        <SettingsControlRow
                          key={service.name}
                          title={service.name}
                          description={
                            <span className="font-mono">
                              {service.changed
                                ? fromTo(service, true)
                                : promotedImage(
                                    service.to,
                                    service.toSource,
                                    service.toSourceImage
                                  )}
                            </span>
                          }
                        >
                          <Badge variant={service.changed ? "warning" : "secondary"} size="inline">
                            {service.changed ? "Changed" : "Same"}
                          </Badge>
                        </SettingsControlRow>
                      ))}
                      {(item.compose?.changes ?? []).map((change) => (
                        <SettingsControlRow
                          key={change.path}
                          title={<span className="font-mono text-xs">{change.path}</span>}
                          description={
                            <span className="font-mono">
                              − {change.from ?? "none"} · + {change.to ?? "none"}
                            </span>
                          }
                        >
                          <Badge variant="outline" size="inline">
                            Compose file
                          </Badge>
                        </SettingsControlRow>
                      ))}
                    </PanelShell>
                  ))}
                  {pagesItems.length > 0 && (
                    <PanelShell
                      title="Pages"
                      icon={<Globe2 className="h-4 w-4" />}
                      description="Active deployment"
                    >
                      {pagesItems.map((item) => (
                        <SettingsControlRow
                          key={item.pairKey}
                          title={`${item.targetName} · Pages project`}
                          description={
                            <span className="font-mono">
                              {item.from ?? "none"} → {item.to}
                            </span>
                          }
                        >
                          {itemSwitch(item)}
                        </SettingsControlRow>
                      ))}
                    </PanelShell>
                  )}
                </>
              )}
              {preview && (
                <p className="text-xs text-muted-foreground">
                  {[
                    preview.unchanged.length > 0
                      ? `${preview.unchanged.join(", ")} ${preview.unchanged.length === 1 ? "is" : "are"} unchanged.`
                      : null,
                    preview.unpaired.length > 0
                      ? `${preview.unpaired.map((entry) => `${entry.name} (${entry.message})`).join(", ")} ${preview.unpaired.length === 1 ? "is" : "are"} not promoted.`
                      : null,
                    "Databases, storage, their data and schema are never promoted.",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                </p>
              )}
            </motion.div>
          )}

          {step === 2 && (
            <motion.div key="step-2" {...CONTENT_SWITCH_ANIMATION} className="space-y-4">
              <Notice
                tone="info"
                title={`${plural(chosen.length, "item")} promoted into ${targetName}`}
              >
                {targetName} then runs what {source.name} runs now. An entry is added to the app's
                Activity.
              </Notice>
              <PanelShell
                title={`What happens in ${targetName}`}
                icon={<ArrowUpFromLine className="h-4 w-4" />}
                description="Each uses its normal rollout"
              >
                {chosen.map((item) => (
                  <SettingsControlRow
                    key={item.pairKey}
                    title={item.targetName}
                    description={rolloutText(item)}
                  >
                    <Badge variant="secondary" size="inline">
                      {TYPE_LABEL[item.type]}
                    </Badge>
                  </SettingsControlRow>
                ))}
              </PanelShell>
            </motion.div>
          )}

          {step === 3 && promotion && (
            <motion.div key="step-3-promotion" {...CONTENT_SWITCH_ANIMATION}>
              <PanelShell
                title={`Promoting into ${targetName}`}
                icon={<ArrowUpFromLine className="h-4 w-4" />}
                description="One item after another; a failure does not stop the others"
              >
                {promotion.items.map((item) => (
                  <SettingsControlRow
                    key={item.pairKey}
                    title={item.targetName}
                    description={
                      item.error ??
                      item.detail ??
                      fromTo(item, item.type === "container" || item.type === "deployment")
                    }
                  >
                    <Badge variant={STATUS_BADGE[item.status].variant} size="inline">
                      {STATUS_BADGE[item.status].label}
                    </Badge>
                  </SettingsControlRow>
                ))}
              </PanelShell>
            </motion.div>
          )}
        </AnimatedSwitch>

        <DialogFooter>
          {step === 1 && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!preview || chosen.length === 0} onClick={() => setStep(2)}>
                Next <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button variant="outline" onClick={() => setStep(1)} disabled={submitting}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button pending={submitting} onClick={() => void promote()}>
                Promote
              </Button>
            </>
          )}
          {step === 3 && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
