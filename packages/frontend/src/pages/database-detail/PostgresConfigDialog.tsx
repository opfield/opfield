import { useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import {
  type DatabaseConnection,
  DEFAULT_MANAGED_POSTGRES_CONFIG,
  MANAGED_POSTGRES_MAX_CONNECTIONS,
  MANAGED_POSTGRES_MIN_CONNECTIONS,
} from "@/types";

function parseMaxConnections(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return parsed >= MANAGED_POSTGRES_MIN_CONNECTIONS && parsed <= MANAGED_POSTGRES_MAX_CONNECTIONS
    ? parsed
    : null;
}

export function PostgresConfigDialog({
  database,
  open,
  onOpenChange,
  onSaved,
}: {
  database: DatabaseConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const managed = database.managed!;
  const savedMaxConnections =
    managed.postgresConfig?.maxConnections ?? DEFAULT_MANAGED_POSTGRES_CONFIG.maxConnections;
  const [draft, setDraft] = useState(String(savedMaxConnections));
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open) setDraft(String(savedMaxConnections));
  }, [open, savedMaxConnections]);

  const maxConnections = parseMaxConnections(draft);
  const changed = maxConnections !== null && maxConnections !== savedMaxConnections;

  const save = async () => {
    if (maxConnections === null || !changed || saving || confirming) return;
    setConfirming(true);
    const confirmed = await confirm({
      title: "Save & Recreate",
      description:
        "Applying PostgreSQL configuration recreates the database container and temporarily takes it offline. It usually takes about 10 seconds; managed storage is retained. Continue?",
      confirmLabel: "Recreate",
      variant: "default",
    });
    setConfirming(false);
    if (!confirmed) return;

    setSaving(true);
    try {
      await api.updateManagedDatabase(managed.id, { postgresConfig: { maxConnections } });
      toast.success("PostgreSQL configuration updated — container recreated");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toastApiError(error, "Failed to update PostgreSQL configuration");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="flex max-h-[88dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Configure PostgreSQL</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pr-1">
          <PanelShell
            title="Connections"
            description="Control how many clients the server accepts at once."
          >
            <SettingsControlRow
              title="Maximum connections"
              description={`PostgreSQL max_connections, from ${MANAGED_POSTGRES_MIN_CONNECTIONS} to ${MANAGED_POSTGRES_MAX_CONNECTIONS}. Each connection is a server process with its own memory. Application bindings accept up to this many connections each.`}
            >
              <Input
                aria-label="Maximum connections"
                aria-invalid={maxConnections === null}
                type="number"
                min={MANAGED_POSTGRES_MIN_CONNECTIONS}
                max={MANAGED_POSTGRES_MAX_CONNECTIONS}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </SettingsControlRow>
          </PanelShell>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            pending={saving}
            disabled={maxConnections === null || !changed || confirming}
          >
            {saving ? "Recreating database..." : "Save & Recreate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
