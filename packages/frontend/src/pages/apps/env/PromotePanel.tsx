// The environment page's Promote panel (canvas frames env-live, env-staging): what differs from the
// target, or when something was last promoted into this environment, and Promote to <target>.
import { ArrowUpFromLine } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import type { AppDetail, AppEnvironmentDetail, AppPromotion, AppPromotionPreview } from "@/types";
import { plural } from "../app-shared";
import {
  defaultPromotionTarget,
  differenceSummary,
  PromoteDialog,
  promotionTargets,
} from "../dialogs/PromoteDialog";

export function PromotePanel({ app, env }: { app: AppDetail; env: AppEnvironmentDetail }) {
  const target = defaultPromotionTarget(app, env);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AppPromotionPreview | null>(null);
  const [last, setLast] = useState<AppPromotion | null>(null);
  const [loaded, setLoaded] = useState(false);
  const targetId = target?.id ?? null;

  const load = useCallback(async () => {
    try {
      if (env.isProduction) {
        setLast((await api.listAppPromotions(app.id, env.id))[0] ?? null);
      } else if (targetId) {
        setPreview(await api.previewAppPromotion(app.id, env.id, targetId));
      }
    } catch {
      setPreview(null);
      setLast(null);
    } finally {
      setLoaded(true);
    }
  }, [app.id, env.id, env.isProduction, targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!target || promotionTargets(app, env).length === 0) return null;

  const differing = preview
    ? preview.items.filter((item) => !item.same && item.promotable).length
    : 0;
  const source = last
    ? app.environments.find((item) => item.id === last.sourceEnvironmentId)
    : null;
  const status = env.isProduction ? (
    <SettingsControlRow
      title={`Last promoted into ${env.name}`}
      description={
        last
          ? `From ${source?.name ?? "another environment"}, ${formatRelativeDate(last.startedAt)}: ${last.items.map((item) => item.targetName).join(", ")}`
          : loaded
            ? "Nothing promoted yet"
            : "Loading…"
      }
    >
      {last && (
        <Badge variant={last.status === "succeeded" ? "secondary" : "warning"} size="inline">
          {last.status === "running" ? "Running" : formatRelativeDate(last.startedAt)}
        </Badge>
      )}
    </SettingsControlRow>
  ) : (
    <SettingsControlRow
      title={differing > 0 ? `Differs from ${target.name}` : `Same as ${target.name}`}
      description={
        !loaded
          ? `Comparing with ${target.name}…`
          : differing > 0 && preview
            ? `${differenceSummary(preview.items)} differ from ${target.name}`
            : `${target.name} runs what runs in ${env.name}`
      }
    >
      {loaded && differing > 0 && (
        <Badge variant="secondary" size="inline">
          {plural(differing, "change")}
        </Badge>
      )}
    </SettingsControlRow>
  );

  return (
    <>
      <PanelShell
        title="Promote"
        icon={<ArrowUpFromLine className="h-4 w-4" />}
        description={`Run ${env.name}'s exact images in ${target.name}`}
        actions={
          <Button variant="outline" onClick={() => setOpen(true)}>
            <ArrowUpFromLine className="h-3.5 w-3.5" />
            Promote to {target.name}
          </Button>
        }
      >
        {status}
      </PanelShell>
      <PromoteDialog
        app={app}
        source={env}
        initialTargetId={target.id}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) void load();
        }}
        onDone={() => void load()}
      />
    </>
  );
}
