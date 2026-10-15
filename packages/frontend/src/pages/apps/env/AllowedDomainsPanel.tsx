// The environment page's Allowed domains: the app-wide entries (read-only here, set in the app's
// Settings) and the environment's own list. Domains and route hostnames of the environment must
// match one of them; both empty allows any domain.
import { Globe2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EditableStringList } from "@/components/common/EditableStringList";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { AppDetail, AppEnvironmentDetail } from "@/types";
import {
  DOMAIN_PATTERN_PLACEHOLDER,
  domainPatternDraft,
  sameDomainPatterns,
} from "../domain-patterns";

export function AllowedDomainsPanel({
  app,
  env,
  canManage,
  onSaved,
}: {
  app: AppDetail;
  env: AppEnvironmentDetail;
  canManage: boolean;
  onSaved: () => void;
}) {
  const saved = env.domainPatterns ?? [];
  const [values, setValues] = useState<string[]>(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValues(env.domainPatterns ?? []), [env.domainPatterns]);
  const next = domainPatternDraft(values);
  const changed = !sameDomainPatterns(next, saved);
  const appWide = app.domainPatterns ?? [];

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAppEnvironment(app.id, env.id, { domainPatterns: next });
      toast.success(`Allowed domains of ${env.name} saved`);
      onSaved();
    } catch (error) {
      toastApiError(error, "Failed to save the allowed domains");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelShell
      title="Allowed domains"
      icon={<Globe2 className="h-4 w-4" />}
      description={`Domains and route hostnames ${env.name} may use. Empty allows any domain`}
      dirty={canManage && changed}
      actions={
        canManage ? (
          <Button onClick={() => void save()} pending={saving} disabled={!changed}>
            <Save />
            Save
          </Button>
        ) : undefined
      }
    >
      <SettingsControlRow
        title="App-wide"
        description="Set in the app's Settings, for every environment"
      >
        <span className="text-sm text-muted-foreground">{appWide.join(", ") || "None"}</span>
      </SettingsControlRow>
      <SettingsControlRow title={`Only ${env.name}`} description="Added to the app-wide domains">
        {canManage ? (
          <EditableStringList
            values={values}
            onChange={setValues}
            placeholder={DOMAIN_PATTERN_PLACEHOLDER}
            itemLabel="Allowed domain"
          />
        ) : (
          <span className="text-sm text-muted-foreground">{saved.join(", ") || "None"}</span>
        )}
      </SettingsControlRow>
    </PanelShell>
  );
}
